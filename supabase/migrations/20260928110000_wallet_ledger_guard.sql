-- topup: wallet. Part 3 of 7: make the ledger the ONLY way a balance can change, and enforce it in the database.
-- Run AFTER 20260928100000_wallet_requests.sql. Safe to re-run.
--
-- WHAT ALREADY EXISTS (inspected, not assumed): the balance is `wallets.balance` (>= 0, customers can only SELECT it) and
-- the ledger is `wallet_transactions` (kinds deposit / purchase / refund / adjustment; select-only for customers). Today three
-- SECURITY DEFINER functions change balances and each writes a ledger row: purchase_product_option, admin_adjust_balance and
-- admin_set_order_status. They are NOT rewritten here.
--
-- WHAT THIS ADDS:
--   1. Two new links on the ledger (deposit_id, withdrawal_id) and the kind 'withdrawal'.
--        Your list of types -> the existing words:  deposit = deposit, withdrawal = withdrawal (new), refund = refund,
--        order_payment = 'purchase' (the word the ledger, the app and the tests already use for paying an order).
--   2. THE GUARD. A deferred constraint trigger on wallets AND on the ledger: at commit, a balance must equal the sum of
--      that customer's ledger rows. So a balance can't change without a matching ledger row (and a ledger row can't be added
--      without the balance moving with it), not from a bug, not from a hand-typed UPDATE in the SQL editor: the transaction
--      is refused. This protects the three existing functions as well as the new ones.
--   3. The ledger is append-only: a direct UPDATE or DELETE is refused (only the database's own foreign-key clean-up,
--      e.g. an order being deleted, may null a link).
--   4. One-time-only rules: a deposit credits at most once, a withdrawal is held at most once and refunded at most once.
--   5. wallet_apply(): the one internal function the new features use to move money. ONE statement does the balance check
--      and the change (`update ... where balance + amount >= 0`), so two requests racing on the same balance can never both
--      succeed and the balance can never go negative. It is internal: customers cannot call it.

------------------------------------------------------------------------------
-- 1. ledger columns and kinds
------------------------------------------------------------------------------

alter table public.wallet_transactions drop constraint if exists wallet_transactions_kind_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_kind_check
  check (kind in ('deposit', 'purchase', 'refund', 'adjustment', 'withdrawal'));

alter table public.wallet_transactions
  add column if not exists deposit_id    uuid references public.deposit_requests (id) on delete set null,
  add column if not exists withdrawal_id uuid references public.withdrawal_requests (id) on delete set null;

create index if not exists wallet_transactions_deposit_idx on public.wallet_transactions (deposit_id) where deposit_id is not null;
create index if not exists wallet_transactions_withdrawal_idx on public.wallet_transactions (withdrawal_id) where withdrawal_id is not null;

-- Shape rules for the new rows.
alter table public.wallet_transactions drop constraint if exists wallet_transactions_links_check;
alter table public.wallet_transactions add constraint wallet_transactions_links_check check (
  (deposit_id is null or kind = 'deposit')
  and (kind <> 'withdrawal' or (amount < 0 and withdrawal_id is not null))
  and (withdrawal_id is null or kind in ('withdrawal', 'refund'))
);

-- Exactly-once: a deposit request credits once; a withdrawal request is held once and refunded at most once.
create unique index if not exists wallet_tx_one_deposit_credit
  on public.wallet_transactions (deposit_id) where kind = 'deposit' and deposit_id is not null;
create unique index if not exists wallet_tx_one_withdrawal_hold
  on public.wallet_transactions (withdrawal_id) where kind = 'withdrawal';
create unique index if not exists wallet_tx_one_withdrawal_refund
  on public.wallet_transactions (withdrawal_id) where kind = 'refund' and withdrawal_id is not null;

------------------------------------------------------------------------------
-- 2. THE GUARD: balance == sum of the ledger, checked at commit
------------------------------------------------------------------------------

create or replace function public.check_wallet_matches_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum numeric(14, 2);
  v_bal numeric(14, 2);
begin
  select balance into v_bal from public.wallets where user_id = new.user_id;
  select coalesce(sum(amount), 0) into v_sum from public.wallet_transactions where user_id = new.user_id;
  if v_bal is distinct from v_sum then
    raise exception 'wallet_ledger_mismatch' using errcode = 'P0001',
      detail = format('balance %s but the ledger adds up to %s', v_bal, v_sum);
  end if;
  return null;
end;
$$;

drop trigger if exists wallets_match_ledger on public.wallets;
create constraint trigger wallets_match_ledger
  after insert or update of balance on public.wallets
  deferrable initially deferred
  for each row execute function public.check_wallet_matches_ledger();

drop trigger if exists wallet_transactions_match_balance on public.wallet_transactions;
create constraint trigger wallet_transactions_match_balance
  after insert on public.wallet_transactions
  deferrable initially deferred
  for each row execute function public.check_wallet_matches_ledger();

------------------------------------------------------------------------------
-- 3. the ledger is append-only
------------------------------------------------------------------------------

create or replace function public.wallet_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  -- Depth 1 = someone ran an UPDATE/DELETE on the ledger. Depth 2+ = the database's own foreign-key action
  -- (an order or a request was deleted and its link is being emptied, or the customer's profile is being deleted).
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'wallet_ledger_is_append_only' using errcode = 'P0001';
end;
$$;

drop trigger if exists wallet_transactions_append_only on public.wallet_transactions;
create trigger wallet_transactions_append_only
  before update or delete on public.wallet_transactions
  for each row execute function public.wallet_ledger_append_only();

------------------------------------------------------------------------------
-- 4. wallet_apply: the internal way to move money
------------------------------------------------------------------------------

-- p_amount is signed (+ money in, - money out). Returns the new balance. Raises insufficient_balance / wallet_missing.
-- The check and the change are ONE statement, so concurrent callers queue on the row and the second one re-checks
-- against the balance the first one left behind.
create or replace function public.wallet_apply(
  p_user       uuid,
  p_amount     numeric,
  p_kind       text,
  p_note       text,
  p_order      uuid default null,
  p_deposit    uuid default null,
  p_withdrawal uuid default null,
  p_by         uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(14, 2) := round(coalesce(p_amount, 0), 2);
  v_new    numeric(14, 2);
begin
  if v_amount = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  update public.wallets
     set balance = balance + v_amount
   where user_id = p_user and balance + v_amount >= 0
  returning balance into v_new;

  if v_new is null then
    if not exists (select 1 from public.wallets where user_id = p_user) then
      raise exception 'wallet_missing' using errcode = 'P0002';
    end if;
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions
    (user_id, kind, amount, balance_after, order_id, deposit_id, withdrawal_id, note, created_by)
  values
    (p_user, p_kind, v_amount, v_new, p_order, p_deposit, p_withdrawal, p_note, p_by);

  return v_new;
end;
$$;

revoke all on function public.wallet_apply(uuid, numeric, text, text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
