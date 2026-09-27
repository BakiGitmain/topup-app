-- Gifts and redeem codes, part 3 of 4: delivery on claim, and what the vault reads. FORWARD-ONLY, additive (one
-- nullable column on orders, triggers, read functions), re-runnable. claim_gift, the paid trigger and checkout_gift
-- are NOT touched.
--
-- DELIVERY ON CLAIM: claiming a gift creates the RECIPIENT's delivery order (orders.gift_id = the gift), in the same
-- transaction as the claim (trigger gifts_deliver_on_claim). From there it is an ordinary order in the ordinary
-- delivery funnel -- nothing new:
--   * status 'pending', exactly like the older direct-purchase path: the app calls the fulfill-order Edge Function
--     (attemptFulfillment -> supplier -> system_fulfill_order -> _complete_order -> vault_codes for a code), and if
--     that fails or never runs, the order sits in the admin queue ('pending') for manual delivery, the same safety net
--     every normal order has. No new status machine.
--   * delivered at most once: one delivery order per gift (unique orders.gift_id), created only by the single-winner
--     claim; the supplier call is keyed by that order id; _complete_order refuses a second completion; vault_codes
--     has one code per order.
--   * it is not a sale: it can never be failed, refunded or cancelled (that would pay the gift's value into the
--     recipient's wallet). Its amount is the gift's value, for the receipt and the queue.

-- ------------------------------------------------------------------------------------------------ 1. the link

alter table public.orders add column if not exists gift_id uuid references public.gifts (id) on delete set null;
create unique index if not exists orders_gift_id_unique on public.orders (gift_id) where gift_id is not null;

-- ------------------------------------------------------------------------------------------------ 2. the delivery order

create or replace function public.gift_deliver_on_claim()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_pack   record;
  v_fields jsonb := coalesce(new.player_fields, '{}'::jsonb);
  v_first  text;
  v_val_id uuid;
  v_val_rg text;
  v_val_nm text;
begin
  select o.label, p.name as product_name, p.category, r.id as region_id, r.label as region_label, r.buyer_fields,
         src.amount
    into v_pack
    from public.product_options o
    join public.products p on p.id = o.product_id
    left join public.product_regions r on r.id = o.region_id
    join public.orders src on src.id = new.order_id
   where o.id = new.option_id;

  -- The ID it was claimed with, exactly as checkout stores it: every field, plus the first as account_id.
  v_first := coalesce(v_pack.buyer_fields -> 0 ->> 'key', case when v_fields ? 'account_id' then 'account_id' end);
  -- ...and the supplier check it was claimed against, if the region has one (for the admin's view of the order).
  if v_pack.region_id is not null then
    select v.id, v.account_region, v.player_name into v_val_id, v_val_rg, v_val_nm
      from public.id_validations v
     where v.user_id = new.recipient_user_id and v.region_id = v_pack.region_id and v.fields = v_fields
     order by v.created_at desc limit 1;
  end if;

  insert into public.orders (user_id, option_id, product_name, option_label, region_label, amount, status, fulfillment,
                             delivery, validation_id, validated_account_region, validated_player_name, gift_id)
  values (new.recipient_user_id, new.option_id, v_pack.product_name, v_pack.label, v_pack.region_label, v_pack.amount,
          'pending',
          case when v_pack.category in ('games', 'airtime', 'subscriptions') then 'topup' else 'code' end,
          jsonb_build_object('fields', v_fields)
            || case when v_first is not null and v_fields ? v_first then jsonb_build_object('account_id', v_fields ->> v_first) else '{}'::jsonb end,
          v_val_id, v_val_rg, v_val_nm, new.id);
  return null;
end;
$$;
revoke all on function public.gift_deliver_on_claim() from public, anon, authenticated;
drop trigger if exists gifts_deliver_on_claim on public.gifts;
create trigger gifts_deliver_on_claim after update of status on public.gifts
  for each row
  when (new.status = 'claimed' and old.status = 'pending')
  execute function public.gift_deliver_on_claim();

-- The delivery order only ever moves forward to delivered: pending -> processing -> completed. Never failed,
-- refunded, cancelled or paid (each of those is a money path it must not take); its gift link never changes.
create or replace function public.guard_gift_delivery_order()
returns trigger language plpgsql as $$
begin
  if old.gift_id is null then
    if new.gift_id is not null then
      raise exception 'gift_delivery_locked' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.gift_id is distinct from old.gift_id and not (pg_trigger_depth() > 1 and new.gift_id is null) then
    raise exception 'gift_delivery_locked' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status
     and not ((old.status = 'pending' and new.status in ('processing', 'completed'))
              or (old.status = 'processing' and new.status = 'completed')) then
    raise exception 'gift_delivery_locked' using errcode = 'P0001', detail = old.status || ' -> ' || new.status;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_gift_delivery_guard on public.orders;
create trigger orders_gift_delivery_guard before update on public.orders
  for each row execute function public.guard_gift_delivery_order();

-- ------------------------------------------------------------------------------------------------ 3. recipient deletion

-- Found in part 3: gifts.recipient_user_id cascades, so deleting a recipient's account silently deleted a paid,
-- unclaimed gift (the buyer's order then stays frozen 'paid' with nothing behind it). Chosen: the same answer part 1
-- gave the buyer's side -- refuse. Account deletion here is a support request (Settings > Privacy), so the refusal
-- reaches a person who can deal with the gift first. A claimed or expired gift does not block (nothing left to lose).
create or replace function public.guard_recipient_with_pending_gifts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.gifts where recipient_user_id = old.id and status = 'pending') then
    raise exception 'recipient_has_pending_gifts' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_recipient_with_pending_gifts() from public, anon, authenticated;
drop trigger if exists profiles_pending_gifts_guard on public.profiles;
create trigger profiles_pending_gifts_guard before delete on public.profiles
  for each row execute function public.guard_recipient_with_pending_gifts();

-- ------------------------------------------------------------------------------------------------ 4. what the vault reads

-- The signed-in user's received gifts, newest first, with everything the claim card needs: the product's own art
-- (image, tint), the pack, the sender's name and picture (profiles are otherwise private), what ID the pack needs
-- (the region's buyer fields and check, or the region-less game fallback), and the delivery order once claimed.
create or replace function public.my_vault_gifts()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'sort_key' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', g.id, 'status', case when g.status = 'pending' and g.expires_at <= now() then 'expired' else g.status end,
      'created_at', g.created_at, 'expires_at', g.expires_at, 'claimed_at', g.claimed_at,
      'from_code', g.redeem_code_id is not null,
      'sender_name', coalesce(nullif(btrim(sp.display_name), ''), split_part(sp.email, '@', 1)),
      'sender_avatar', sp.avatar_url,
      'product_id', p.id, 'product_name', p.name, 'image_url', p.image_url, 'tint', p.tint, 'category', p.category,
      'option_label', o.label, 'region_id', r.id, 'region_label', r.label,
      'buyer_fields', coalesce(r.buyer_fields, '[]'::jsonb), 'id_validation', coalesce(r.id_validation, 'none'),
      'region_locked', o.region_locked, 'account_region_codes', to_jsonb(coalesce(o.account_region_codes, '{}'::text[])),
      'id_section_title', r.id_section_title, 'id_section_hint', r.id_section_hint,
      'delivery_order_id', d.id, 'delivery_status', d.status,
      'sort_key', (case when g.status = 'pending' and g.expires_at > now() then '1' else '0' end) || g.created_at::text) as x
      from public.gifts g
      join public.product_options o on o.id = g.option_id
      join public.products p on p.id = g.product_id
      left join public.product_regions r on r.id = o.region_id
      left join public.profiles sp on sp.id = g.sender_id
      left join public.orders d on d.gift_id = g.id
     where g.recipient_user_id = auth.uid()
  ) s
$$;
revoke all on function public.my_vault_gifts() from public, anon;
grant execute on function public.my_vault_gifts() to authenticated;

-- The signed-in user's own redeem codes (the second place to get a code after the one-time reveal), newest first.
create or replace function public.my_redeem_codes()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code,
      'status', case when c.status = 'active' and c.expires_at <= now() then 'expired' else c.status end,
      'created_at', c.created_at, 'expires_at', c.expires_at, 'redeemed_at', c.redeemed_at,
      'product_name', p.name, 'image_url', p.image_url, 'tint', p.tint, 'option_label', o.label)
    order by c.created_at desc), '[]'::jsonb)
    from public.redeem_codes c
    join public.product_options o on o.id = c.option_id
    join public.products p on p.id = c.product_id
   where c.created_by = auth.uid()
$$;
revoke all on function public.my_redeem_codes() from public, anon;
grant execute on function public.my_redeem_codes() to authenticated;
