-- Gifts: notifications, and receipts for the buyer only. FORWARD-ONLY, re-runnable.
--
-- 1. NOTIFICATIONS (written by triggers, in the same transaction as the event, like the money notifications):
--      gift_received  -> the recipient, when a gift sent to them is PAID for (the gift row is created at payment).
--                        Not for the gift a redeem code turns into: the redeemer did that themselves, right now.
--      gift_claimed   -> the buyer, when their friend claims it.
--      code_redeemed  -> the buyer, when someone redeems their code. It never says who (a code can end up with a
--                        stranger; the redeemer stays anonymous, as the sender does to them -- 20261019090000).
--      gift_delivered -> the recipient, when a claimed gift's delivery completes LATE (it waited in the queue,
--                        e.g. an admin delivered it by hand). An instant delivery right after the claim is not
--                        announced: they just watched it happen on screen.
--    `data` carries what the app renders in the customer's language and where a tap goes; title/body are the
--    plain-English fallback for an app that doesn't know the type yet.
--
-- 2. RECEIPTS ARE THE BUYER'S. The recipient's delivery order (orders.gift_id, part 3) was stored with the gift's
--    PRICE: the recipient could read what their friend paid (RLS lets them read their own orders), and the sale was
--    counted twice (the buyer's paid order + this one). It is not a sale, so it now carries amount 0 -- allowed only
--    for a gift delivery -- and the app shows it as a gift, never as a receipt. Existing delivery orders are set to 0.
--
-- 3. admin_set_order_status refuses failing/refunding a gift delivery FIRST, as gift_delivery_locked (copied
--    verbatim, one check added): with Br 0 the refund step would otherwise fail first with a confusing error.

-- ------------------------------------------------------------------------------------------------ 2. no price on the recipient's side

alter table public.orders drop constraint if exists orders_amount_check;
update public.orders set amount = 0 where gift_id is not null and amount <> 0;
alter table public.orders add constraint orders_amount_check
  check (amount > 0 or (amount = 0 and gift_id is not null));

-- As in 20261018090000, with amount 0 (was the gift's price).
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
  select o.label, p.name as product_name, p.category, r.id as region_id, r.label as region_label, r.buyer_fields
    into v_pack
    from public.product_options o
    join public.products p on p.id = o.product_id
    left join public.product_regions r on r.id = o.region_id
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
  values (new.recipient_user_id, new.option_id, v_pack.product_name, v_pack.label, v_pack.region_label, 0,
          'pending',
          case when v_pack.category in ('games', 'airtime', 'subscriptions') then 'topup' else 'code' end,
          jsonb_build_object('fields', v_fields)
            || case when v_first is not null and v_fields ? v_first then jsonb_build_object('account_id', v_fields ->> v_first) else '{}'::jsonb end,
          v_val_id, v_val_rg, v_val_nm, new.id);
  return null;
end;
$$;
revoke all on function public.gift_deliver_on_claim() from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ 1. notifications

-- A person's name as the gift flow shows it (never their email).
create or replace function public._gift_person_name(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(btrim(display_name), '') from public.profiles where id = p_id), 'Portal user')
$$;
revoke all on function public._gift_person_name(uuid) from public, anon, authenticated;

create or replace function public.notify_gift_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_product text;
  v_pack    text;
  v_name    text;
begin
  select p.name, o.label into v_product, v_pack
    from public.product_options o join public.products p on p.id = o.product_id
   where o.id = new.option_id;

  if tg_table_name = 'gifts' and tg_op = 'INSERT' then
    -- A direct gift, just paid for: tell the recipient.
    if new.redeem_code_id is null then
      v_name := public._gift_person_name(new.sender_id);
      insert into public.notifications (type, title, body, data, user_id)
      values ('gift_received', 'You received a gift',
              format('%s sent you %s %s. Claim it in your Vault.', v_name, v_product, v_pack),
              jsonb_build_object('gift_id', new.id, 'product_name', v_product, 'pack_label', v_pack, 'sender_name', v_name),
              new.recipient_user_id);
    end if;

  elsif tg_table_name = 'gifts' then
    -- Claimed: tell the buyer of a direct gift (a code's buyer hears about the redemption instead, below).
    if new.redeem_code_id is null and new.sender_id is not null then
      v_name := public._gift_person_name(new.recipient_user_id);
      insert into public.notifications (type, title, body, data, user_id)
      values ('gift_claimed', 'Your gift was claimed',
              format('%s claimed the %s %s you sent.', v_name, v_product, v_pack),
              jsonb_build_object('gift_id', new.id, 'order_id', new.order_id, 'product_name', v_product,
                                 'pack_label', v_pack, 'recipient_name', v_name),
              new.sender_id);
    end if;

  elsif tg_table_name = 'redeem_codes' then
    -- Redeemed: tell the buyer, and nothing about who.
    insert into public.notifications (type, title, body, data, user_id)
    values ('code_redeemed', 'Your redeem code was used',
            format('Your %s %s code was redeemed.', v_product, v_pack),
            jsonb_build_object('order_id', new.order_id, 'product_name', v_product, 'pack_label', v_pack),
            new.created_by);
  end if;
  return null;
end;
$$;
revoke all on function public.notify_gift_event() from public, anon, authenticated;

drop trigger if exists gifts_notify_received on public.gifts;
create trigger gifts_notify_received after insert on public.gifts
  for each row execute function public.notify_gift_event();
drop trigger if exists gifts_notify_claimed on public.gifts;
create trigger gifts_notify_claimed after update of status on public.gifts
  for each row when (new.status = 'claimed' and old.status = 'pending')
  execute function public.notify_gift_event();
drop trigger if exists redeem_codes_notify_redeemed on public.redeem_codes;
create trigger redeem_codes_notify_redeemed after update of status on public.redeem_codes
  for each row when (new.status = 'redeemed' and old.status = 'active')
  execute function public.notify_gift_event();

-- A claimed gift delivered late (queued, or delivered by hand): tell the recipient it has arrived.
create or replace function public.notify_gift_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.completed_at, now()) - new.created_at < interval '2 minutes' then
    return null; -- delivered right after the claim: they saw it happen
  end if;
  insert into public.notifications (type, title, body, data, user_id)
  values ('gift_delivered', 'Your gift has arrived',
          format('%s %s is delivered.', new.product_name, new.option_label),
          jsonb_build_object('gift_id', new.gift_id, 'order_id', new.id, 'product_name', new.product_name,
                             'pack_label', new.option_label, 'fulfillment', new.fulfillment),
          new.user_id);
  return null;
end;
$$;
revoke all on function public.notify_gift_delivered() from public, anon, authenticated;
drop trigger if exists orders_notify_gift_delivered on public.orders;
create trigger orders_notify_gift_delivered after update of status on public.orders
  for each row when (new.status = 'completed' and old.status is distinct from 'completed' and new.gift_id is not null)
  execute function public.notify_gift_delivered();

-- ------------------------------------------------------------------------------------------------ 3. admin refusal

-- Copied verbatim from 20260930240000_paid_orders_reach_admin_queue.sql (its latest definition), with ONE check
-- added: a gift delivery is refused as gift_delivery_locked before any refund step runs.
create or replace function public.admin_set_order_status(
  p_order_id uuid,
  p_status   text
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders;
  v_balance numeric(14, 2);
  v_new     numeric(14, 2);
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_status not in ('processing', 'failed', 'refunded') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- A gift delivery (orders.gift_id) is not a sale -- it carries no price (Br 0) and the buyer paid on their own
  -- order -- so it can never be failed or refunded. Refused here, first, with its real reason (before this, the
  -- refund step's zero-amount ledger row failed first with a check-constraint error).
  if v_order.gift_id is not null and p_status in ('failed', 'refunded') then
    raise exception 'gift_delivery_locked' using errcode = 'P0001';
  end if;

  -- The customer already holds the code, so the money can't come back.
  if p_status = 'refunded' and v_order.status = 'completed' and v_order.fulfillment = 'code' then
    raise exception 'code_already_delivered' using errcode = 'P0001';
  end if;

  if not (
    (v_order.status = 'paid'       and p_status in ('processing', 'failed')) or
    (v_order.status = 'pending'    and p_status in ('processing', 'failed')) or
    (v_order.status = 'processing' and p_status = 'failed') or
    (v_order.status = 'completed'  and p_status = 'refunded')
  ) then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if p_status in ('failed', 'refunded') then
    select balance into v_balance
      from public.wallets where user_id = v_order.user_id for update;

    v_new := v_balance + v_order.amount;
    update public.wallets set balance = v_new where user_id = v_order.user_id;

    insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note, created_by)
    values (
      v_order.user_id, 'refund', v_order.amount, v_new, v_order.id,
      'Refund: ' || v_order.product_name || ' - ' || v_order.option_label,
      auth.uid()
    );
  end if;

  update public.orders set status = p_status where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;
revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;
