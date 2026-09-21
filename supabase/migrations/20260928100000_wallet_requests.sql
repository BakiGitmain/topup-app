-- topup: wallet. Part 2 of 7: the two request tables (deposits, withdrawals).
-- Run AFTER 20260928090000_admin_notifications.sql. Safe to re-run.
--
-- ADDS: deposit_requests, withdrawal_requests. EXTENDS: payment_attempts (so the audit log covers deposits too).
-- Nothing is dropped or rewritten; the only change to an existing table is that payment_attempts.order_id may now be
-- empty when the attempt belongs to a deposit (exactly one of the two must be set).
--
-- NAMING: the rest of this database says `user_id` (orders, wallets, cart_items...), so these tables do too, not `customer_id`.
--
-- WHO CAN DO WHAT: a customer can READ their own requests and nothing else; there is no write grant at all. Requests are
-- created and changed only by the functions in the next migrations. Admins can read every request.
--
-- LIMITS (edit here if you want different ones): a deposit is Br 10 to Br 100,000; a withdrawal is at least Br 10
-- (the balance is its upper limit).

------------------------------------------------------------------------------
-- 1. deposit_requests
------------------------------------------------------------------------------

create table if not exists public.deposit_requests (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  amount                  numeric(12, 2) not null check (amount between 10 and 100000),
  -- pending_reference:    waiting for the customer to send money and enter the reference
  -- pending_verification: a reference is being checked with ShegerPay right now
  -- paid:                 verified for exactly this amount; the balance was credited (once)
  -- mismatch:             a transfer was found but not for this amount; NOTHING credited, needs a person
  -- failed:               cancelled by the customer
  status                  text not null default 'pending_reference'
                          check (status in ('pending_reference', 'pending_verification', 'paid', 'failed', 'mismatch')),
  payment_provider        text,
  payment_reference       text,
  paid_at                 timestamptz,
  -- 'test' or 'live': which kind of ShegerPay key verified it (see the note in 20260927090000_payment_orders.sql).
  payment_mode            text,
  payment_verified_amount numeric(12, 2),
  verifying_since         timestamptz,
  payment_attempts        integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint deposit_provider_check  check (payment_provider is null or payment_provider in ('telebirr', 'cbe')),
  constraint deposit_reference_check check (payment_reference is null or payment_reference ~ '^[A-Z0-9_-]{4,64}$'),
  constraint deposit_mode_check      check (payment_mode is null or payment_mode in ('test', 'live')),
  constraint deposit_pair_check      check ((payment_provider is null) = (payment_reference is null)),
  -- A request being checked, paid, or mismatched must say which transfer it is.
  constraint deposit_claim_check
    check (status not in ('pending_verification', 'paid', 'mismatch') or payment_reference is not null),
  -- THE "NO PARTIAL CREDIT" RULE, in the database: a paid deposit was verified for exactly the requested amount.
  constraint deposit_paid_exact_check
    check (status <> 'paid' or (payment_verified_amount = amount and paid_at is not null and payment_mode is not null)),
  constraint deposit_mismatch_mode_check check (status <> 'mismatch' or payment_mode is not null),
  -- One real transfer can settle ONE deposit. (Also checked against orders by the shared guard in the next migration.)
  constraint deposit_reference_unique unique (payment_provider, payment_reference)
);

-- At most one open deposit per customer: a second "Deposit" tap resumes the first, never a duplicate.
create unique index if not exists deposit_requests_one_open_per_user
  on public.deposit_requests (user_id) where status in ('pending_reference', 'pending_verification');
create index if not exists deposit_requests_user_idx on public.deposit_requests (user_id, created_at desc);

drop trigger if exists deposit_requests_set_updated_at on public.deposit_requests;
create trigger deposit_requests_set_updated_at
  before update on public.deposit_requests
  for each row execute function public.set_updated_at();

alter table public.deposit_requests enable row level security;
drop policy if exists deposit_requests_select on public.deposit_requests;
create policy deposit_requests_select on public.deposit_requests
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.deposit_requests from anon, authenticated;
grant select on public.deposit_requests to authenticated;

------------------------------------------------------------------------------
-- 2. withdrawal_requests
------------------------------------------------------------------------------

create table if not exists public.withdrawal_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  amount          numeric(12, 2) not null check (amount between 10 and 1000000),
  -- Where the customer wants the money sent: their OWN Telebirr or CBE account.
  payout_provider text not null check (payout_provider in ('telebirr', 'cbe')),
  payout_account  text not null,
  -- pending:  the amount is already held (deducted); waiting for an admin
  -- paid:     an admin sent the money outside the app and marked it
  -- declined: an admin refused; the held amount went back to the balance
  -- approved: reserved (approve currently goes straight to paid)
  status          text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'paid')),
  admin_note      text check (admin_note is null or length(admin_note) <= 500),
  resolved_by     uuid references public.profiles (id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- The number must be well-formed for its provider: a typo here means money sent to the wrong person.
  --   Telebirr: 10 digits, 09xxxxxxxx or 07xxxxxxxx      CBE: 13 digits
  constraint withdrawal_payout_account_check check (
    (payout_provider = 'telebirr' and payout_account ~ '^0[79][0-9]{8}$')
    or (payout_provider = 'cbe' and payout_account ~ '^[0-9]{13}$')
  ),
  constraint withdrawal_resolved_check check (status = 'pending' or resolved_at is not null),
  -- A refusal always says why: the customer sees it.
  constraint withdrawal_declined_note_check
    check (status <> 'declined' or length(btrim(coalesce(admin_note, ''))) > 0)
);

create index if not exists withdrawal_requests_user_idx on public.withdrawal_requests (user_id, created_at desc);
create index if not exists withdrawal_requests_pending_idx on public.withdrawal_requests (created_at) where status = 'pending';

drop trigger if exists withdrawal_requests_set_updated_at on public.withdrawal_requests;
create trigger withdrawal_requests_set_updated_at
  before update on public.withdrawal_requests
  for each row execute function public.set_updated_at();

alter table public.withdrawal_requests enable row level security;
drop policy if exists withdrawal_requests_select on public.withdrawal_requests;
create policy withdrawal_requests_select on public.withdrawal_requests
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.withdrawal_requests from anon, authenticated;
grant select on public.withdrawal_requests to authenticated;

------------------------------------------------------------------------------
-- 3. payment_attempts: one audit log for orders AND deposits
------------------------------------------------------------------------------

alter table public.payment_attempts alter column order_id drop not null;
alter table public.payment_attempts
  add column if not exists deposit_id uuid references public.deposit_requests (id) on delete cascade;

alter table public.payment_attempts drop constraint if exists payment_attempts_one_target;
alter table public.payment_attempts add constraint payment_attempts_one_target
  check ((order_id is null) <> (deposit_id is null));

create index if not exists payment_attempts_deposit_idx on public.payment_attempts (deposit_id, created_at);
