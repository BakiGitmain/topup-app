-- Gifts: the BUYER picks the server. FORWARD-ONLY, re-runnable.
--
-- A region's buyer form can have dropdown fields (buyer_fields[].type = 'select', e.g. a game server). Until now gift
-- mode asked nothing at purchase and the recipient filled every field at claim. Owner's call (2026-09-27): a choice
-- the pack offers is made by the buyer, when buying; the recipient only types their own ID at claim, and cannot
-- change the choice.
--
--   checkout_gift(option, kind, recipient, p_fields default '{}')  every dropdown field of the pack's region is
--       required and must be one of its options (server_required / gift_fields_invalid); anything else in p_fields
--       (a player ID, an unknown key) is refused -- the recipient types those. Saved as orders.gift_fields.
--       The 3-argument form is dropped (a new parameter can't be added by CREATE OR REPLACE); an app that still
--       calls with three named arguments gets the default and keeps working for packs without a dropdown.
--   gifts.preset_fields  copied from the paying order when the gift row is created (trigger), for a direct gift and
--       for the gift a redeem code turns into alike, so gift_on_paid / redeem_code are not touched.
--   claim_gift  merges preset_fields OVER what the recipient sends: the buyer's choice always wins.
--   my_vault_gifts  returns preset_fields, so the claim card shows the choice and asks only for the rest.
-- Both new columns are write-once (the orders/gifts guards below); customers can't write either table anyway.

-- ------------------------------------------------------------------------------------------------ 1. columns

alter table public.orders add column if not exists gift_fields jsonb not null default '{}'::jsonb;
alter table public.gifts add column if not exists preset_fields jsonb not null default '{}'::jsonb;

create or replace function public.guard_gift_choice()
returns trigger language plpgsql as $$
begin
  -- Nested, not "a and b": plpgsql may evaluate both sides, and each table has only its own column.
  if tg_table_name = 'orders' then
    if new.gift_fields is distinct from old.gift_fields then
      raise exception 'gift_order_locked' using errcode = 'P0001';
    end if;
  elsif new.preset_fields is distinct from old.preset_fields then
    raise exception 'gift_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_gift_choice() from public, anon, authenticated;
drop trigger if exists orders_gift_fields_guard on public.orders;
create trigger orders_gift_fields_guard before update of gift_fields on public.orders
  for each row execute function public.guard_gift_choice();
drop trigger if exists gifts_preset_fields_guard on public.gifts;
create trigger gifts_preset_fields_guard before update of preset_fields on public.gifts
  for each row execute function public.guard_gift_choice();

-- Every gift row (direct, or made by redeeming a code) takes the choice saved on the order that paid for it.
create or replace function public.gift_copy_choice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.preset_fields := coalesce((select o.gift_fields from public.orders o where o.id = new.order_id), '{}'::jsonb);
  return new;
end;
$$;
revoke all on function public.gift_copy_choice() from public, anon, authenticated;
drop trigger if exists gifts_copy_choice on public.gifts;
create trigger gifts_copy_choice before insert on public.gifts
  for each row execute function public.gift_copy_choice();

-- ------------------------------------------------------------------------------------------------ 2. checkout_gift

drop function if exists public.checkout_gift(uuid, text, uuid);

-- Buys one pack as a gift for p_recipient ('gift') or as a redeem code ('redeem_code'). p_fields carries the pack's
-- dropdown choices (e.g. the server) and nothing else; the recipient gives their own ID at claim time. Otherwise
-- exactly as in 20261017090000: same rules as checkout_cart where they apply (one unpaid order per customer, the same
-- lock, price from the catalog, paid from the wallet at once when the balance covers it, else the bank screen).
create or replace function public.checkout_gift(p_option_id uuid, p_kind text, p_recipient uuid default null,
                                                p_fields jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid := auth.uid();
  v_pack    record;
  v_pending uuid;
  v_order   uuid;
  v_balance numeric(14, 2);
  v_paid    boolean := false;
  v_result  jsonb;
  v_field   jsonb;
  v_value   text;
  v_choice  jsonb := '{}'::jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('gift', 'redeem_code') then
    raise exception 'invalid_gift_kind' using errcode = '22023';
  end if;
  if p_kind = 'gift' then
    if p_recipient = v_user then
      raise exception 'cannot_gift_self' using errcode = 'P0001';
    end if;
    if p_recipient is null or not exists (select 1 from public.profiles where id = p_recipient) then
      raise exception 'recipient_not_found' using errcode = 'P0002';
    end if;
  elsif p_recipient is not null then
    raise exception 'invalid_gift_kind' using errcode = '22023';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    p_fields := '{}'::jsonb;
  end if;

  -- The same lock checkout_cart takes: a gift and a cart checkout can't race each other into two unpaid orders.
  perform pg_advisory_xact_lock(hashtextextended('create_cart_order:' || v_user::text, 0));
  select id into v_pending from public.orders where user_id = v_user and status = 'pending_payment';
  if found then
    raise exception 'pending_order_exists' using errcode = 'P0001', detail = v_pending::text;
  end if;

  select o.id, o.label, o.price, p.name as product_name, p.category, r.label as region_label, r.buyer_fields
    into v_pack
    from public.product_options o
    join public.products p on p.id = o.product_id
    left join public.product_regions r on r.id = o.region_id
   where o.id = p_option_id and o.is_active and p.is_active and (o.region_id is null or r.is_active);
  if not found or v_pack.price is null or v_pack.price <= 0 then
    raise exception 'pack_unavailable' using errcode = 'P0001';
  end if;

  -- The buyer's choices: every dropdown field of the region, each one of its own options.
  for v_field in select f from jsonb_array_elements(coalesce(v_pack.buyer_fields, '[]'::jsonb)) f loop
    continue when v_field ->> 'type' is distinct from 'select';
    v_value := btrim(coalesce(p_fields ->> (v_field ->> 'key'), ''));
    if v_value = '' then
      raise exception 'server_required' using errcode = '22023', detail = v_field ->> 'key';
    end if;
    if not exists (select 1 from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) o
                    where o ->> 'value' = v_value) then
      raise exception 'gift_fields_invalid' using errcode = '22023', detail = v_field ->> 'key';
    end if;
    v_choice := v_choice || jsonb_build_object(v_field ->> 'key', v_value);
  end loop;
  -- ...and nothing else: a player ID or an unknown key is the recipient's to give, never the buyer's.
  if exists (select 1 from jsonb_object_keys(p_fields) k where not (v_choice ? k)) then
    raise exception 'gift_fields_invalid' using errcode = '22023';
  end if;

  insert into public.orders (user_id, option_id, product_name, option_label, amount, status, delivery, fulfillment,
                             region_label, gift_kind, gift_recipient_id, gift_fields)
  values (v_user, v_pack.id, v_pack.product_name, v_pack.label, v_pack.price, 'pending_payment', '{}'::jsonb,
          case when v_pack.category in ('games', 'airtime', 'subscriptions') then 'topup' else 'code' end,
          v_pack.region_label, p_kind, case when p_kind = 'gift' then p_recipient end, v_choice)
  returning id into v_order;

  select balance into v_balance from public.wallets where user_id = v_user;
  if coalesce(v_balance, 0) >= v_pack.price then
    begin
      v_balance := (public.pay_order_with_wallet(v_order) ->> 'balance')::numeric;
      v_paid := true;
    exception when raise_exception then
      if sqlerrm <> 'insufficient_balance' then
        raise;
      end if;
      select balance into v_balance from public.wallets where user_id = v_user;
    end;
  end if;

  v_result := jsonb_build_object('order_id', v_order, 'amount', v_pack.price, 'kind', p_kind, 'paid', v_paid,
                                 'balance', coalesce(v_balance, 0));
  if v_paid and p_kind = 'gift' then
    v_result := v_result || jsonb_build_object('gift_id', (select id from public.gifts where order_id = v_order));
  elsif v_paid then
    v_result := v_result || jsonb_build_object('code', (select code from public.redeem_codes where order_id = v_order));
  end if;
  return v_result;
end;
$$;
revoke all on function public.checkout_gift(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.checkout_gift(uuid, text, uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------ 3. claim_gift

-- As in 20261016090000, with one line added: the buyer's choices (preset_fields) are laid over what the recipient
-- sends, so the recipient can never change them.
create or replace function public.claim_gift(p_gift_id uuid, p_fields jsonb default '{}'::jsonb)
returns public.gifts
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid := auth.uid();
  v_gift    public.gifts;
  v_pack    record;
  v_fields  jsonb := null;
  v_val_id  uuid;
  v_val_exp timestamptz;
  v_val_reg text;
  v_account text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' then
    p_fields := '{}'::jsonb;
  end if;

  select * into v_gift from public.gifts where id = p_gift_id;
  if not found then
    raise exception 'gift_not_found' using errcode = 'P0002';
  end if;
  if v_gift.recipient_user_id <> v_user then
    raise exception 'gift_not_yours' using errcode = '42501';
  end if;
  if v_gift.status = 'claimed' then
    raise exception 'gift_already_claimed' using errcode = 'P0001';
  end if;
  if v_gift.status = 'expired' or v_gift.expires_at <= now() then
    raise exception 'gift_expired' using errcode = 'P0001';
  end if;
  -- The buyer's choices win over anything the recipient sends for the same fields.
  if coalesce(v_gift.preset_fields, '{}'::jsonb) <> '{}'::jsonb then
    p_fields := p_fields || v_gift.preset_fields;
  end if;

  select o.is_active and p.is_active and (o.region_id is null or r.is_active) as available,
         o.region_id, o.region_locked, o.account_region_codes, p.category,
         r.buyer_fields, r.id_validation
    into v_pack
    from public.product_options o
    join public.products p on p.id = o.product_id
    left join public.product_regions r on r.id = o.region_id
   where o.id = v_gift.option_id;
  if not coalesce(v_pack.available, false) then
    raise exception 'pack_unavailable' using errcode = 'P0001';
  end if;

  -- The player ID, exactly as checkout requires it for this pack.
  if v_pack.region_id is not null then
    if jsonb_array_length(coalesce(v_pack.buyer_fields, '[]'::jsonb)) > 0 then
      if p_fields = '{}'::jsonb then
        raise exception 'player_id_required' using errcode = '22023';
      end if;
      begin
        v_fields := public.normalize_buyer_fields(v_pack.buyer_fields, p_fields);
      exception when others then
        raise exception 'id_fields_invalid' using errcode = '22023';
      end;
    end if;
    if v_pack.id_validation = 'supplier' then
      select v.id, v.expires_at, v.account_region into v_val_id, v_val_exp, v_val_reg
        from public.id_validations v
       where v.user_id = v_user and v.region_id = v_pack.region_id and v.fields = coalesce(v_fields, '{}'::jsonb)
       order by v.created_at desc limit 1;
      if v_val_id is null then
        raise exception 'id_not_validated' using errcode = 'P0001';
      elsif v_val_exp <= now() then
        raise exception 'id_validation_expired' using errcode = 'P0001';
      end if;
    end if;
    if v_pack.region_locked then
      if v_val_id is null then
        raise exception 'region_unverifiable' using errcode = 'P0001';
      elsif v_val_reg is null then
        raise exception 'region_unverified' using errcode = 'P0001';
      elsif not (v_val_reg = any (v_pack.account_region_codes)) then
        raise exception 'region_mismatch' using errcode = 'P0001';
      end if;
    end if;
  elsif v_pack.category in ('games', 'airtime', 'subscriptions') then
    -- older packs with no region: one game ID
    v_account := btrim(coalesce(p_fields ->> 'account_id', ''));
    if v_account = '' then
      raise exception 'player_id_required' using errcode = '22023';
    elsif length(v_account) > 64 then
      raise exception 'id_fields_invalid' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('account_id', v_account);
  end if;

  -- THE single-winner step (see redeem_code).
  update public.gifts
     set status = 'claimed', claimed_at = now(), player_fields = v_fields
   where id = p_gift_id and recipient_user_id = v_user and status = 'pending' and expires_at > now()
  returning * into v_gift;
  if not found then
    -- Someone (the same user's other tap) got there first, or it ran out in between.
    select * into v_gift from public.gifts where id = p_gift_id;
    if v_gift.status = 'claimed' then
      raise exception 'gift_already_claimed' using errcode = 'P0001';
    end if;
    raise exception 'gift_expired' using errcode = 'P0001';
  end if;
  return v_gift;
end;
$$;
revoke all on function public.claim_gift(uuid, jsonb) from public, anon;
grant execute on function public.claim_gift(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------ 4. what the vault reads

-- As in 20261019090000, plus preset_fields.
create or replace function public.my_vault_gifts()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'sort_key' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', g.id, 'status', case when g.status = 'pending' and g.expires_at <= now() then 'expired' else g.status end,
      'created_at', g.created_at, 'expires_at', g.expires_at, 'claimed_at', g.claimed_at,
      'from_code', g.redeem_code_id is not null,
      -- a code's buyer stays anonymous to whoever redeemed it; a direct gift shows its sender's own name, never email
      'sender_name', case when g.redeem_code_id is null then coalesce(nullif(btrim(sp.display_name), ''), 'Portal user') end,
      'sender_avatar', case when g.redeem_code_id is null then sp.avatar_url end,
      'product_id', p.id, 'product_name', p.name, 'image_url', p.image_url, 'tint', p.tint, 'category', p.category,
      'option_label', o.label, 'region_id', r.id, 'region_label', r.label,
      'buyer_fields', coalesce(r.buyer_fields, '[]'::jsonb), 'id_validation', coalesce(r.id_validation, 'none'),
      'preset_fields', g.preset_fields,
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
