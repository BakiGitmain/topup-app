-- Gifts and redeem codes, part 2 of 4: buying one. FORWARD-ONLY, additive (two nullable columns on orders, one
-- attempts table, functions, triggers), re-runnable.
--
-- THE CONSTRAINT: the gift / redeem_codes row must exist the moment the order is 'paid' -- never a moment later, or
-- the delivery job (attemptFulfillment, fired right after payment) could deliver the order to the BUYER.
--   1. The order is a gift order FROM BIRTH: orders.gift_kind ('gift' | 'redeem_code') and gift_recipient_id are set
--      when checkout_gift creates it (still 'pending_payment'), and can never change afterwards.
--   2. An order becomes 'paid' in exactly two places: pay_order_with_wallet (every wallet payment, including
--      checkout_cart's and checkout_gift's) and finish_payment_verification (bank transfer). Neither is edited: an
--      AFTER UPDATE trigger on that very status change (orders_gift_on_paid) inserts the gift / redeem code, so it runs
--      INSIDE the same transaction as the flip in both paths. Nobody can ever see the order paid without its row.
--   3. attemptFulfillment skips any order with gift_kind set (redeployed with this), and orders_gift_backed_guard now
--      freezes such an order from birth: it may only be paid, cancelled or mismatched, never delivered/failed/refunded.

-- ------------------------------------------------------------------------------------------------ 1. the marker

alter table public.orders add column if not exists gift_kind text;
alter table public.orders add column if not exists gift_recipient_id uuid references public.profiles (id) on delete set null;
alter table public.orders drop constraint if exists orders_gift_kind_check;
alter table public.orders add constraint orders_gift_kind_check
  check (gift_kind is null or gift_kind in ('gift', 'redeem_code'));
-- A redeem-code order never names a recipient (a gift order's may become null if that account is deleted).
alter table public.orders drop constraint if exists orders_gift_recipient_check;
alter table public.orders add constraint orders_gift_recipient_check
  check (gift_kind = 'gift' or gift_recipient_id is null);
create index if not exists orders_gift_kind_idx on public.orders (gift_kind) where gift_kind is not null;

-- ------------------------------------------------------------------------------------------------ 2. the freeze

create or replace function public.guard_gift_backed_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.gift_kind is distinct from old.gift_kind
     or (new.gift_recipient_id is distinct from old.gift_recipient_id
         -- the database emptying the link when the recipient's account is deleted is not an edit
         and not (pg_trigger_depth() > 1 and new.gift_recipient_id is null)) then
    raise exception 'gift_order_immutable' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status
     and (old.gift_kind is not null
          or exists (select 1 from public.gifts where order_id = old.id)
          or exists (select 1 from public.redeem_codes where order_id = old.id)) then
    -- Before payment it may be paid, cancelled or mismatched like any unpaid order; once paid it never moves again
    -- (never delivered, failed or refunded by the normal paths: the product goes out only when the gift is claimed).
    if old.status = 'paid' or new.status not in ('pending_payment', 'paid', 'cancelled', 'payment_mismatch') then
      raise exception 'gift_order_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_gift_backed_order() from public, anon, authenticated;
drop trigger if exists orders_gift_backed_guard on public.orders;
create trigger orders_gift_backed_guard before update on public.orders
  for each row execute function public.guard_gift_backed_order();

-- ------------------------------------------------------------------------------------------------ 3. shared inserts

-- _giftable_order gains "must still be on sale" as an option: creating from a paid order at payment time must NOT
-- check it (the buyer has paid; refusing would fail the payment itself). Claim checks availability again anyway.
drop function if exists public._giftable_order(uuid);
create or replace function public._giftable_order(p_order_id uuid, p_require_available boolean default true)
returns table (user_id uuid, option_id uuid, product_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_order  public.orders;
  v_option uuid;
  v_lines  integer;
  v_qty    integer;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'paid' then
    raise exception 'order_not_paid' using errcode = 'P0001', detail = v_order.status;
  end if;
  if exists (select 1 from public.gifts g where g.order_id = p_order_id)
     or exists (select 1 from public.redeem_codes c where c.order_id = p_order_id) then
    raise exception 'order_already_gifted' using errcode = 'P0001';
  end if;

  v_option := v_order.option_id;
  if v_option is null then
    select count(*), min(i.quantity) into v_lines, v_qty from public.order_items i where i.order_id = p_order_id;
    if v_lines <> 1 or v_qty <> 1 then
      raise exception 'order_not_giftable' using errcode = 'P0001';
    end if;
    select i.option_id into v_option from public.order_items i where i.order_id = p_order_id;
  end if;

  if p_require_available and not exists (
    select 1 from public.product_options o
      join public.products p on p.id = o.product_id
      left join public.product_regions r on r.id = o.region_id
     where o.id = v_option and o.is_active and p.is_active and (o.region_id is null or r.is_active)
  ) then
    raise exception 'pack_unavailable' using errcode = 'P0001';
  end if;

  return query select v_order.user_id, v_option, (select o.product_id from public.product_options o where o.id = v_option);
end;
$$;
revoke all on function public._giftable_order(uuid, boolean) from public, anon, authenticated, service_role;

-- One redeem code row, retrying on a code collision (shared by create_redeem_code and the paid trigger).
create or replace function public._insert_redeem_code(p_order uuid, p_product uuid, p_option uuid, p_by uuid)
returns public.redeem_codes
language plpgsql security definer set search_path = public as $$
declare
  v_row public.redeem_codes;
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      insert into public.redeem_codes (code, order_id, product_id, option_id, created_by, expires_at)
      values (public.generate_redeem_code(), p_order, p_product, p_option, p_by, now() + public.gift_ttl())
      returning * into v_row;
      return v_row;
    exception when unique_violation then
      if sqlerrm not like '%redeem_codes_code_key%' then
        raise;
      end if;
      if v_try >= 50 then
        raise exception 'redeem_code_generation_failed' using errcode = 'P0001';
      end if;
    end;
  end loop;
end;
$$;
revoke all on function public._insert_redeem_code(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.create_redeem_code(p_order_id uuid)
returns public.redeem_codes
language plpgsql security definer set search_path = public as $$
declare
  v_src record;
begin
  select * into v_src from public._giftable_order(p_order_id, true);
  return public._insert_redeem_code(p_order_id, v_src.product_id, v_src.option_id, v_src.user_id);
end;
$$;
revoke all on function public.create_redeem_code(uuid) from public, anon, authenticated, service_role;

create or replace function public.create_gift(p_order_id uuid, p_recipient uuid)
returns public.gifts
language plpgsql security definer set search_path = public as $$
declare
  v_src record;
  v_row public.gifts;
begin
  if p_recipient is null or not exists (select 1 from public.profiles where id = p_recipient) then
    raise exception 'recipient_not_found' using errcode = 'P0002';
  end if;
  select * into v_src from public._giftable_order(p_order_id, true);
  insert into public.gifts (order_id, product_id, option_id, sender_id, recipient_user_id, expires_at)
  values (p_order_id, v_src.product_id, v_src.option_id, v_src.user_id, p_recipient, now() + public.gift_ttl())
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.create_gift(uuid, uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------------------------------------ 4. THE atomic hook

-- Fires on the UPDATE that makes a gift order 'paid', in that UPDATE's own transaction (whichever of the two payment
-- paths ran it). Never refuses: the buyer has paid, so a problem here must not undo the payment. If the recipient's
-- account was deleted before the payment landed, the buyer gets a redeem code instead -- the money is never lost.
create or replace function public.gift_on_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_src record;
begin
  select * into v_src from public._giftable_order(new.id, false);
  if new.gift_kind = 'gift' and new.gift_recipient_id is not null
     and exists (select 1 from public.profiles where id = new.gift_recipient_id) then
    insert into public.gifts (order_id, product_id, option_id, sender_id, recipient_user_id, expires_at)
    values (new.id, v_src.product_id, v_src.option_id, v_src.user_id, new.gift_recipient_id, now() + public.gift_ttl());
  else
    perform public._insert_redeem_code(new.id, v_src.product_id, v_src.option_id, v_src.user_id);
  end if;
  return null;
end;
$$;
revoke all on function public.gift_on_paid() from public, anon, authenticated;
drop trigger if exists orders_gift_on_paid on public.orders;
create trigger orders_gift_on_paid after update of status on public.orders
  for each row
  when (new.status = 'paid' and old.status is distinct from 'paid' and new.gift_kind is not null)
  execute function public.gift_on_paid();

-- ------------------------------------------------------------------------------------------------ 5. buying one

-- Buys one pack as a gift for p_recipient ('gift') or as a redeem code ('redeem_code'). No buyer fields: those are
-- asked at claim time only. Same rules as checkout_cart where they apply: one unpaid order per customer (the same
-- lock), the pack must be on sale, price from the catalog, paid from the wallet at once when the balance covers it
-- (through pay_order_with_wallet, so the paid trigger above does the rest) and otherwise left unpaid for the same
-- bank-transfer screen. No discount codes, wheel prizes or Portal Coins here: gifts never complete as an order.
-- Returns {order_id, amount, kind, paid, balance} plus gift_id (a paid gift) or code (a paid redeem code -- the one
-- time it is handed over in a reply; the buyer can also read it from redeem_codes later).
create or replace function public.checkout_gift(p_option_id uuid, p_kind text, p_recipient uuid default null)
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

  -- The same lock checkout_cart takes: a gift and a cart checkout can't race each other into two unpaid orders.
  perform pg_advisory_xact_lock(hashtextextended('create_cart_order:' || v_user::text, 0));
  select id into v_pending from public.orders where user_id = v_user and status = 'pending_payment';
  if found then
    raise exception 'pending_order_exists' using errcode = 'P0001', detail = v_pending::text;
  end if;

  select o.id, o.label, o.price, p.name as product_name, p.category, r.label as region_label
    into v_pack
    from public.product_options o
    join public.products p on p.id = o.product_id
    left join public.product_regions r on r.id = o.region_id
   where o.id = p_option_id and o.is_active and p.is_active and (o.region_id is null or r.is_active);
  if not found or v_pack.price is null or v_pack.price <= 0 then
    raise exception 'pack_unavailable' using errcode = 'P0001';
  end if;

  insert into public.orders (user_id, option_id, product_name, option_label, amount, status, delivery, fulfillment,
                             region_label, gift_kind, gift_recipient_id)
  values (v_user, v_pack.id, v_pack.product_name, v_pack.label, v_pack.price, 'pending_payment', '{}'::jsonb,
          case when v_pack.category in ('games', 'airtime', 'subscriptions') then 'topup' else 'code' end,
          v_pack.region_label, p_kind, case when p_kind = 'gift' then p_recipient end)
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
revoke all on function public.checkout_gift(uuid, text, uuid) from public, anon;
grant execute on function public.checkout_gift(uuid, text, uuid) to authenticated;

-- What the buyer sees after paying for a gift order (the done screen), whichever payment path paid it: the pack,
-- the code (a redeem-code order) or who it went to (a gift). Only the order's own buyer gets an answer.
create or replace function public.gift_order_summary(p_order uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_o public.orders;
begin
  select * into v_o from public.orders where id = p_order and user_id = auth.uid();
  if not found or v_o.gift_kind is null then
    return null;
  end if;
  return jsonb_build_object(
    'order_id', v_o.id, 'kind', v_o.gift_kind, 'status', v_o.status, 'product_name', v_o.product_name,
    'option_label', v_o.option_label, 'amount', v_o.amount,
    'code', (select c.code from public.redeem_codes c where c.order_id = v_o.id),
    'gift_id', (select g.id from public.gifts g where g.order_id = v_o.id),
    'recipient_name', (select coalesce(nullif(p.display_name, ''), 'Portal user') from public.gifts g
                         join public.profiles p on p.id = g.recipient_user_id where g.order_id = v_o.id),
    'recipient_avatar', (select p.avatar_url from public.gifts g
                           join public.profiles p on p.id = g.recipient_user_id where g.order_id = v_o.id));
end;
$$;
revoke all on function public.gift_order_summary(uuid) from public, anon;
grant execute on function public.gift_order_summary(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------ 6. email lookup

-- Lookups per user and per client IP in the window. Every lookup counts (a hit also tells whether an email has an
-- account, which is exactly what an enumeration wants), so the budget is generous for a person, tight for a script.
create or replace function public.email_lookup_limits()
returns table (per_user integer, per_ip integer, window_length interval)
language sql immutable as $$ select 20, 60, interval '10 minutes' $$;

-- The log behind the limit. Never stores the email that was looked up.
create table if not exists public.email_lookup_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists email_lookup_attempts_user_idx on public.email_lookup_attempts (user_id, created_at desc);
create index if not exists email_lookup_attempts_ip_idx on public.email_lookup_attempts (ip, created_at desc) where ip is not null;
alter table public.email_lookup_attempts enable row level security;
revoke all on public.email_lookup_attempts from public, anon, authenticated;

-- Exact email -> one account, for picking a gift recipient. Never a partial match, never a list. Returns (never
-- raises, so the attempt log commits):
--   {ok: true, id, name, avatar_url}     the account
--   {ok: false, error: 'not_found'}      no account with exactly that email (also for anything malformed)
--   {ok: false, error: 'self'}           it is the caller's own email ("you can't gift yourself")
--   {ok: false, error: 'too_many_attempts'} / 'not_authenticated'
create or replace function public.find_recipient_by_email(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := auth.uid();
  v_ip     text := public._request_ip();
  v_limits record;
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_hit    public.profiles;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select * into v_limits from public.email_lookup_limits();
  delete from public.email_lookup_attempts where created_at < now() - interval '1 day';
  if (select count(*) from public.email_lookup_attempts
       where user_id = v_user and created_at > now() - v_limits.window_length) >= v_limits.per_user
     or (v_ip is not null and (select count(*) from public.email_lookup_attempts
       where ip = v_ip and created_at > now() - v_limits.window_length) >= v_limits.per_ip) then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  insert into public.email_lookup_attempts (user_id, ip) values (v_user, v_ip);

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_hit from public.profiles where lower(email) = v_email limit 2;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_hit.id = v_user then
    return jsonb_build_object('ok', false, 'error', 'self');
  end if;
  return jsonb_build_object('ok', true, 'id', v_hit.id,
                            'name', coalesce(nullif(btrim(v_hit.display_name), ''), split_part(v_hit.email, '@', 1)),
                            'avatar_url', v_hit.avatar_url);
end;
$$;
revoke all on function public.find_recipient_by_email(text) from public, anon;
grant execute on function public.find_recipient_by_email(text) to authenticated;
