-- topup: real payment (Telebirr / CBE via ShegerPay). Part 1 of 3: the order side.
-- Run AFTER 20260926120000_create_categories_and_pack_category.sql. Safe to re-run.
--
-- WHAT THIS DOES: extends the existing `orders` table (nothing is recreated or rewritten; the live table has
-- 0 rows) and adds three tables. Existing wallet-paid orders keep working exactly as before.
--
--   1. orders: four new statuses (pending_payment, paid, payment_mismatch, cancelled) and the payment columns
--      (provider, reference, paid_at, mode, verified amount, verifying_since, attempts).
--        * UNIQUE (payment_provider, payment_reference): one real transfer can pay ONE order, enforced by the
--          database itself, not only by the app. This is the fraud vector the whole design protects.
--        * At most ONE pending_payment order per customer (partial unique index): a second checkout can never
--          create a duplicate; the app is told which order to resume.
--        * A paid order must carry its reference, mode and verified amount; a payment_mismatch order its reference (CHECK).
--   2. order_items: what was in a cart order, snapshotted at order time (price, quantity, that line's own player
--      ID and its ID-check result). Prices can change later; the order never does.
--   3. payment_accounts: the account a customer sends money to, per provider (admins edit it; no app release
--      needed to change a number). Deliberately EMPTY here: no account numbers are invented.
--   4. payment_attempts: one row per verification attempt with the RAW ShegerPay response, for audit. It is its own
--      admin-only table (not a column on orders) because row-level security cannot hide a single column, and
--      customers can read their own order rows.
--
-- WHO CAN DO WHAT: customers can only READ their own orders and order_items (there is no write grant; the
-- functions in the next migrations write). payment_attempts: admins read, nobody else. payment_accounts: any
-- signed-in user reads the active ones, only admins write.

------------------------------------------------------------------------------
-- 1. orders
------------------------------------------------------------------------------

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('pending', 'processing', 'completed', 'failed', 'refunded',
                    'pending_payment', 'paid', 'payment_mismatch', 'cancelled'));

alter table public.orders
  add column if not exists payment_provider        text,
  add column if not exists payment_reference       text,
  add column if not exists paid_at                 timestamptz,
  -- 'test' or 'live': which kind of ShegerPay key verified it. A 'test' verification moves no real money, so
  -- delivery (the Vault work) must NOT treat a 'test' order as paid for real.
  add column if not exists payment_mode            text,
  -- What the payment provider said was actually transferred.
  add column if not exists payment_verified_amount numeric(12, 2),
  -- Set while a verification is in flight; a stale value (over 90 s) is ignored, so a crash can't wedge an order.
  add column if not exists verifying_since         timestamptz,
  add column if not exists payment_attempts        integer not null default 0;

alter table public.orders drop constraint if exists orders_payment_provider_check;
alter table public.orders add constraint orders_payment_provider_check
  check (payment_provider is null or payment_provider in ('telebirr', 'cbe'));

-- Stored upper-case with no spaces: "ft24 352" and "FT24352" are the same reference.
alter table public.orders drop constraint if exists orders_payment_reference_check;
alter table public.orders add constraint orders_payment_reference_check
  check (payment_reference is null or payment_reference ~ '^[A-Z0-9_-]{4,64}$');

alter table public.orders drop constraint if exists orders_payment_mode_check;
alter table public.orders add constraint orders_payment_mode_check
  check (payment_mode is null or payment_mode in ('test', 'live'));

alter table public.orders drop constraint if exists orders_payment_pair_check;
alter table public.orders add constraint orders_payment_pair_check
  check ((payment_provider is null) = (payment_reference is null));

-- A paid order must say what was verified. A mismatch must say which transfer it is (the amount may be unknown:
-- the provider can confirm a transfer without reporting how much it was, and that still needs a person).
alter table public.orders drop constraint if exists orders_paid_needs_payment_check;
alter table public.orders add constraint orders_paid_needs_payment_check
  check (status not in ('paid', 'payment_mismatch') or (payment_reference is not null and payment_mode is not null));

alter table public.orders drop constraint if exists orders_paid_needs_amount_check;
alter table public.orders add constraint orders_paid_needs_amount_check
  check (status <> 'paid' or payment_verified_amount is not null);

alter table public.orders drop constraint if exists orders_paid_needs_time_check;
alter table public.orders add constraint orders_paid_needs_time_check
  check (status <> 'paid' or paid_at is not null);

-- THE FRAUD GUARD. NULLs never collide, so unpaid orders are unaffected; a claimed reference is unique.
alter table public.orders drop constraint if exists orders_payment_reference_unique;
alter table public.orders add constraint orders_payment_reference_unique
  unique (payment_provider, payment_reference);

-- One open payment per customer.
create unique index if not exists orders_one_pending_payment_per_user
  on public.orders (user_id) where status = 'pending_payment';

------------------------------------------------------------------------------
-- 2. order_items (a snapshot; written only by create_cart_order)
------------------------------------------------------------------------------

create table if not exists public.order_items (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references public.orders (id) on delete cascade,
  -- Copied from the order so the read policy needs no join.
  user_id                  uuid not null references public.profiles (id) on delete cascade,
  option_id                uuid references public.product_options (id) on delete set null,
  product_name             text not null,
  option_label             text not null,
  region_label             text,
  unit_price               numeric(12, 2) not null check (unit_price > 0),
  quantity                 integer not null check (quantity between 1 and 20),
  line_total               numeric(12, 2) not null,
  -- {"fields": {"player_id": "..."}, "account_id": "..."}: THIS line's own game account.
  delivery                 jsonb not null default '{}'::jsonb,
  validation_id            uuid references public.id_validations (id) on delete set null,
  validated_account_region text,
  validated_player_name    text,
  id_self_declared_at      timestamptz,
  created_at               timestamptz not null default now(),
  constraint order_items_line_total_check check (line_total = unit_price * quantity)
);

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_user_idx on public.order_items (user_id);

alter table public.order_items enable row level security;
drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.order_items from anon, authenticated;
grant select on public.order_items to authenticated;

------------------------------------------------------------------------------
-- 3. payment_accounts (where the customer sends the money)
------------------------------------------------------------------------------

create table if not exists public.payment_accounts (
  provider       text primary key check (provider in ('telebirr', 'cbe')),
  -- Also sent to ShegerPay as the merchant name, so the receiver on the receipt is matched.
  account_name   text not null check (length(btrim(account_name)) between 2 and 80),
  account_number text not null check (length(btrim(account_number)) between 4 and 40),
  is_active      boolean not null default true,
  updated_at     timestamptz not null default now()
);

drop trigger if exists payment_accounts_set_updated_at on public.payment_accounts;
create trigger payment_accounts_set_updated_at
  before update on public.payment_accounts
  for each row execute function public.set_updated_at();

alter table public.payment_accounts enable row level security;
drop policy if exists payment_accounts_select on public.payment_accounts;
create policy payment_accounts_select on public.payment_accounts
  for select to authenticated
  using (is_active or (select public.is_admin()));
drop policy if exists payment_accounts_admin_write on public.payment_accounts;
create policy payment_accounts_admin_write on public.payment_accounts
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.payment_accounts from anon, authenticated;
grant select, insert, update, delete on public.payment_accounts to authenticated;

-- To set the accounts (SQL editor or db query), once you have the numbers:
--   insert into public.payment_accounts (provider, account_name, account_number) values
--     ('telebirr', 'Eyosiyas Daniel Debebe', '<telebirr number>'),
--     ('cbe',      'Eyosiyas Daniel Debebe', '<CBE account number>')
--   on conflict (provider) do update set account_name = excluded.account_name, account_number = excluded.account_number;

------------------------------------------------------------------------------
-- 4. payment_attempts (audit; admin-only)
------------------------------------------------------------------------------

create table if not exists public.payment_attempts (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  provider        text not null,
  reference       text not null,
  -- paid | mismatch | not_verified | unavailable
  outcome         text not null check (outcome in ('paid', 'mismatch', 'not_verified', 'unavailable')),
  verified_amount numeric(12, 2),
  mode            text,
  http_status     integer,
  -- The raw ShegerPay response body, exactly as received.
  response        jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists payment_attempts_order_idx on public.payment_attempts (order_id, created_at);

alter table public.payment_attempts enable row level security;
drop policy if exists payment_attempts_admin_select on public.payment_attempts;
create policy payment_attempts_admin_select on public.payment_attempts
  for select to authenticated
  using ((select public.is_admin()));
revoke all on public.payment_attempts from anon, authenticated;
grant select on public.payment_attempts to authenticated;
grant all on public.payment_attempts to service_role;
