-- Item 3 of the creator feature set (items 0-2 already live: post-purchase Vault routing, the content-creator flag,
-- discount codes). Portal Coin: a customer loyalty currency, an append-only ledger mirroring wallet_transactions'
-- already-guarded pattern byte-for-byte (same deferred balance-matches-ledger trigger, same append-only trigger,
-- same one-statement atomic *_apply() function) rather than inventing a second guard mechanism.
--
-- CREDITED WHERE ITEM 2 ALREADY LOGS REDEMPTIONS -- inside _complete_order(), not earlier. Same reasoning as item
-- 2's own "redemption logged only at completion" call: a pending or later-failed order never delivered anything, so
-- it must not earn a loyalty reward either. +1 for a plain completed order; +2 (not +1, then +2 more) for one that
-- redeemed a discount code -- detected via `orders.discount_code_id is not null`, the exact link item 2 already put
-- on the order, not re-derived from code_redemptions or discount_amount.
--
-- FLAGGING, PER THE STANDING INSTRUCTION: a completed order can later be refunded (admin_set_order_status,
-- 'completed' -> 'refunded' -- today only reachable for a TOPUP order; a completed CODE order is blocked from
-- refunding entirely by its own existing guard, 'code_already_delivered'). The brief asks about an order "refunded
-- before completion", which cannot actually happen in the current state machine: the only refund transition
-- requires 'completed' first, and a paid/pending order that never completes goes to 'failed' instead (no coins were
-- ever credited, since crediting only happens inside _complete_order). So the real question is a completed-then-
-- refunded order: does refunding claw back the Portal Coins it already earned? THIS MIGRATION DOES NOT CLAW THEM
-- BACK -- chosen for consistency with item 2's own precedent, where a completed-then-refunded order's
-- code_redemptions row (and the commission it recorded) is likewise never reversed. Reversing either would mean
-- editing admin_set_order_status, a payment-critical function already covering several other transitions, for a
-- rare, already-manually-reviewed path (an admin has to actively choose to refund). If the owner wants claw-back on
-- refund for Portal Coin, commission, or both, that is a deliberate follow-up, not a silent default.
--
-- REDEMPTION RATE IS A PLACEHOLDER, FLAGGING THIS TOO: portal_coin_settings starts at 1000 Portal Coins = 1 birr,
-- deliberately a token, unrealistic number (same spirit as the project's "placeholder prices are 9999" rule) so it
-- can never be mistaken for a real rate if it goes live before an admin sets one. Unlike pricing_settings' USD rate,
-- there was no existing number to inherit here -- an admin must set the real one before this is worth using.
--
-- REDEMPTION DESIGN CALL, FLAGGING: "on demand" is read as "whenever the customer wants," not "for any amount they
-- type." redeem_portal_coins() takes no amount -- it converts as many WHOLE exchange units as the customer's current
-- balance allows (floor division) in one atomic step, leaving any remainder (fewer coins than one unit) in their
-- Portal Coin balance. This avoids ever crediting a fractional birr amount, and keeps the customer-facing action a
-- single "Redeem" button rather than an amount-entry form. A per-amount redemption is a small, easy follow-up if the
-- owner wants it instead.

-------------------------------------------------------------------------------
-- 1. portal_coin_balances + portal_coin_transactions: same shape as wallets/wallet_transactions, integers not birr.
-------------------------------------------------------------------------------

create table if not exists public.portal_coin_balances (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

drop trigger if exists portal_coin_balances_set_updated_at on public.portal_coin_balances;
create trigger portal_coin_balances_set_updated_at
  before update on public.portal_coin_balances
  for each row execute function public.set_updated_at();

-- amount is signed: positive = coins in (earned), negative = coins out (redeemed).
create table if not exists public.portal_coin_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  kind          text not null check (kind in ('earn_purchase', 'earn_purchase_discount', 'redeem')),
  amount        integer not null check (amount <> 0),
  balance_after integer not null check (balance_after >= 0),
  order_id      uuid references public.orders (id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);

-- Earning is always positive, redeeming always negative. NOT also requiring order_id IS NOT NULL for an earn row:
-- order_id is `on delete set null` (orders are real history, but test fixtures -- and conceivably a future cleanup
-- job -- do delete them), and a permanent NOT NULL here would make that FK's own SET NULL action violate the check
-- on every historical earn row the moment its order is removed. The one-earn-per-order rule below still holds at
-- the moment a row is inserted; it just doesn't try to outlive the order forever.
alter table public.portal_coin_transactions drop constraint if exists portal_coin_transactions_shape_check;
alter table public.portal_coin_transactions add constraint portal_coin_transactions_shape_check check (
  (kind in ('earn_purchase', 'earn_purchase_discount') and amount > 0)
  or (kind = 'redeem' and amount < 0)
);

-- At most one earn row per order (an order can only complete once, but this makes the "never earn twice" rule an
-- actual constraint, not just a hope resting on _complete_order's own status guard).
create unique index if not exists portal_coin_tx_one_earn_per_order
  on public.portal_coin_transactions (order_id) where kind in ('earn_purchase', 'earn_purchase_discount');

create index if not exists portal_coin_transactions_user_idx
  on public.portal_coin_transactions (user_id, created_at desc);

-- Every profile gets a Portal Coin balance too, same trigger event as create_wallet_for_profile, a separate function
-- and trigger so that existing one stays exactly what its name says.
create or replace function public.create_portal_coin_balance_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.portal_coin_balances (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created_portal_coin on public.profiles;
create trigger on_profile_created_portal_coin
  after insert on public.profiles
  for each row execute function public.create_portal_coin_balance_for_profile();

-- Accounts that existed before this migration.
insert into public.portal_coin_balances (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

-------------------------------------------------------------------------------
-- 2. THE GUARD: balance == sum of the ledger, checked at commit. Byte-for-byte the wallet's own mechanism.
-------------------------------------------------------------------------------

create or replace function public.check_portal_coin_matches_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum integer;
  v_bal integer;
begin
  select balance into v_bal from public.portal_coin_balances where user_id = new.user_id;
  select coalesce(sum(amount), 0) into v_sum from public.portal_coin_transactions where user_id = new.user_id;
  if v_bal is distinct from v_sum then
    raise exception 'portal_coin_ledger_mismatch' using errcode = 'P0001',
      detail = format('balance %s but the ledger adds up to %s', v_bal, v_sum);
  end if;
  return null;
end;
$$;

drop trigger if exists portal_coin_balances_match_ledger on public.portal_coin_balances;
create constraint trigger portal_coin_balances_match_ledger
  after insert or update of balance on public.portal_coin_balances
  deferrable initially deferred
  for each row execute function public.check_portal_coin_matches_ledger();

drop trigger if exists portal_coin_transactions_match_balance on public.portal_coin_transactions;
create constraint trigger portal_coin_transactions_match_balance
  after insert on public.portal_coin_transactions
  deferrable initially deferred
  for each row execute function public.check_portal_coin_matches_ledger();

-------------------------------------------------------------------------------
-- 3. the ledger is append-only
-------------------------------------------------------------------------------

create or replace function public.portal_coin_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'portal_coin_ledger_is_append_only' using errcode = 'P0001';
end;
$$;

drop trigger if exists portal_coin_transactions_append_only on public.portal_coin_transactions;
create trigger portal_coin_transactions_append_only
  before update or delete on public.portal_coin_transactions
  for each row execute function public.portal_coin_ledger_append_only();

-------------------------------------------------------------------------------
-- 4. portal_coin_apply: the internal way to move coins, same one-statement atomic pattern as wallet_apply.
-------------------------------------------------------------------------------

create or replace function public.portal_coin_apply(
  p_user   uuid,
  p_amount integer,
  p_kind   text,
  p_note   text,
  p_order  uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new integer;
begin
  if coalesce(p_amount, 0) = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  update public.portal_coin_balances
     set balance = balance + p_amount
   where user_id = p_user and balance + p_amount >= 0
  returning balance into v_new;

  if v_new is null then
    if not exists (select 1 from public.portal_coin_balances where user_id = p_user) then
      raise exception 'portal_coin_balance_missing' using errcode = 'P0002';
    end if;
    raise exception 'insufficient_portal_coins' using errcode = 'P0001';
  end if;

  insert into public.portal_coin_transactions (user_id, kind, amount, balance_after, order_id, note)
  values (p_user, p_kind, p_amount, v_new, p_order, p_note);

  return v_new;
end;
$$;

revoke all on function public.portal_coin_apply(uuid, integer, text, text, uuid)
  from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 5. RLS: a customer reads their own balance and ledger, same shape as wallets/wallet_transactions.
-------------------------------------------------------------------------------

alter table public.portal_coin_balances enable row level security;
alter table public.portal_coin_transactions enable row level security;

drop policy if exists portal_coin_balances_select on public.portal_coin_balances;
create policy portal_coin_balances_select on public.portal_coin_balances
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists portal_coin_transactions_select on public.portal_coin_transactions;
create policy portal_coin_transactions_select on public.portal_coin_transactions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.portal_coin_balances, public.portal_coin_transactions from anon, authenticated;
grant select on public.portal_coin_balances, public.portal_coin_transactions to authenticated;

-------------------------------------------------------------------------------
-- 6. portal_coin_settings: the one-row admin-editable redemption rate, same shape as pricing_settings.
-------------------------------------------------------------------------------

create table if not exists public.portal_coin_settings (
  id                    boolean primary key default true check (id),
  -- coins_per_redemption Portal Coins convert to birr_per_redemption birr, one whole exchange unit at a time.
  -- PLACEHOLDER, see the header: an admin must set the real rate.
  coins_per_redemption  integer not null default 1000 check (coins_per_redemption > 0),
  birr_per_redemption   numeric(10, 2) not null default 1 check (birr_per_redemption > 0),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.profiles (id) on delete set null
);

insert into public.portal_coin_settings (id) values (true) on conflict (id) do nothing;

create or replace function public.portal_coin_settings_stamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists portal_coin_settings_stamp on public.portal_coin_settings;
create trigger portal_coin_settings_stamp
  before update on public.portal_coin_settings
  for each row execute function public.portal_coin_settings_stamp();

-- READ IS NOT ADMIN-ONLY, DEVIATING FROM pricing_settings ON PURPOSE -- flagging this. pricing_settings hides its
-- rate because it is a wholesale margin the shop keeps private; the Portal Coin rate is the opposite kind of number:
-- a customer must know "X coins = Y birr" to decide whether redeeming is worth it, the same way they can already see
-- their own wallet balance. Hiding it and only revealing the result after the fact (inside redeem_portal_coins'
-- return value) would make the customer-facing screen unable to show "you have N coins, redeemable for Br M" or grey
-- out the Redeem button until enough are earned. So: every authenticated user may SELECT the one row; only an admin
-- may UPDATE it -- the customer-visible half of pricing_settings' pattern dropped, the admin-write half kept.
alter table public.portal_coin_settings enable row level security;
drop policy if exists portal_coin_settings_read on public.portal_coin_settings;
create policy portal_coin_settings_read on public.portal_coin_settings
  for select to authenticated using (true);
drop policy if exists portal_coin_settings_admin_update on public.portal_coin_settings;
create policy portal_coin_settings_admin_update on public.portal_coin_settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.portal_coin_settings from anon, authenticated;
grant select, update on public.portal_coin_settings to authenticated;

-------------------------------------------------------------------------------
-- 7. wallet_transactions gains one more kind: crediting a redemption's birr into the existing wallet.
-------------------------------------------------------------------------------

alter table public.wallet_transactions drop constraint if exists wallet_transactions_kind_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_kind_check
  check (kind in ('deposit', 'purchase', 'refund', 'adjustment', 'withdrawal', 'portal_coin_redemption'));

-------------------------------------------------------------------------------
-- 8. redeem_portal_coins: burns whole exchange units of Portal Coins, credits the wallet. One function, one
--    transaction -- if either portal_coin_apply or wallet_apply raises, NOTHING is written (normal Postgres
--    transactional rollback; no extra coordination needed, the same reasoning checkout_cart already relies on).
-------------------------------------------------------------------------------

create or replace function public.redeem_portal_coins()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user        uuid := auth.uid();
  v_coins_unit  integer;
  v_birr_unit   numeric(10, 2);
  v_balance     integer;
  v_units       integer;
  v_coins_spent integer;
  v_birr_credit numeric(14, 2);
  v_new_coins   integer;
  v_new_wallet  numeric(14, 2);
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select coins_per_redemption, birr_per_redemption into v_coins_unit, v_birr_unit
    from public.portal_coin_settings where id = true;

  select balance into v_balance from public.portal_coin_balances where user_id = v_user for update;
  v_balance := coalesce(v_balance, 0);

  v_units := v_balance / v_coins_unit; -- integer division floors
  if v_units <= 0 then
    raise exception 'not_enough_portal_coins' using errcode = 'P0001', detail = format('%s of %s needed', v_balance, v_coins_unit);
  end if;

  v_coins_spent := v_units * v_coins_unit;
  v_birr_credit := round(v_units * v_birr_unit, 2);

  v_new_coins := public.portal_coin_apply(v_user, -v_coins_spent, 'redeem', 'Redeemed for ' || v_birr_credit || ' birr');
  v_new_wallet := public.wallet_apply(v_user, v_birr_credit, 'portal_coin_redemption', 'Redeemed ' || v_coins_spent || ' Portal Coins');

  return jsonb_build_object('coins_redeemed', v_coins_spent, 'birr_credited', v_birr_credit, 'coin_balance', v_new_coins, 'wallet_balance', v_new_wallet);
end;
$$;

revoke all on function public.redeem_portal_coins() from public, anon;
grant execute on function public.redeem_portal_coins() to authenticated;

-------------------------------------------------------------------------------
-- 9. _complete_order: the one place a Portal Coin is ever earned. Redefined with the SAME signature (uuid, text)
--    as item 2 left it, so admin_deliver_order/system_fulfill_order need no change at all.
-------------------------------------------------------------------------------

create or replace function public._complete_order(
  p_order_id      uuid,
  p_delivery_code text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_code  text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status not in ('paid', 'pending', 'processing') then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if v_order.fulfillment = 'code' then
    v_code := btrim(coalesce(p_delivery_code, ''));
    if v_code = '' then
      raise exception 'code_required' using errcode = '22023';
    end if;
    insert into public.vault_codes (order_id, user_id, code)
    values (v_order.id, v_order.user_id, v_code);
  end if;

  update public.orders
     set status = 'completed', completed_at = now()
   where id = p_order_id
  returning * into v_order;

  if v_order.discount_code_id is not null then
    insert into public.code_redemptions (code_id, customer_id, order_id, discount_amount, commission_amount)
    values (v_order.discount_code_id, v_order.user_id, v_order.id, v_order.discount_amount, v_order.commission_amount);
  end if;

  -- +1 Portal Coin for any completed order; +2 TOTAL (not +1 then +2 more) if it redeemed a discount code --
  -- detected via the same discount_code_id link item 2 already set, not re-derived.
  perform public.portal_coin_apply(
    v_order.user_id,
    case when v_order.discount_code_id is not null then 2 else 1 end,
    case when v_order.discount_code_id is not null then 'earn_purchase_discount' else 'earn_purchase' end,
    'Order ' || left(v_order.id::text, 8),
    v_order.id
  );

  return v_order;
end;
$$;

revoke all on function public._complete_order(uuid, text) from public, anon, authenticated, service_role;
