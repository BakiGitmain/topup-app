-- topup: user roles, wallets (balance + ledger), admin-managed catalog, orders.
--
-- Money rules enforced here, not in the app:
--   * A client can never write a balance, a price, an order or a role directly.
--     Those writes only happen inside the SECURITY DEFINER functions below.
--   * The price charged always comes from product_options, never from the client.
--   * Every balance change also writes an immutable wallet_transactions row.
--
-- Safe to re-run.

------------------------------------------------------------------------------
-- 0. helpers
------------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

------------------------------------------------------------------------------
-- 1. profiles + roles
------------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  email        text,
  avatar_url   text,
  role         text not null default 'user',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'admin'));

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Used by RLS policies and the admin_* functions. SECURITY DEFINER so it can
-- read profiles without tripping over profiles' own RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Create the profile when someone signs up. The role is ALWAYS 'user': sign-up
-- metadata is client-controlled, so it is never trusted for the role.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------------------------
-- 2. catalog (prices are set by admins)
------------------------------------------------------------------------------

create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  category   text not null check (category in ('games', 'airtime', 'gift-cards')),
  tagline    text not null default '',
  glyph      text not null default 'gift'
             check (glyph in ('diamond', 'coin', 'signal', 'gift', 'play', 'crosshair', 'controller')),
  tint       text not null default '#E4F7C7',
  featured   boolean not null default false,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per thing a customer can buy, e.g. "310 Diamonds" for Br 165.
create table if not exists public.product_options (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  label      text not null,
  price      numeric(12, 2) not null check (price > 0),
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_options_product_idx
  on public.product_options (product_id);

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists product_options_set_updated_at on public.product_options;
create trigger product_options_set_updated_at
  before update on public.product_options
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------------
-- 3. orders
------------------------------------------------------------------------------

-- Name, label and amount are copied at purchase time so later price edits
-- never rewrite history.
create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  option_id    uuid references public.product_options (id) on delete set null,
  product_name text not null,
  option_label text not null,
  amount       numeric(12, 2) not null check (amount > 0),
  status       text not null default 'pending'
               check (status in ('pending', 'completed', 'failed', 'refunded')),
  -- What the customer typed at checkout: player id, phone number, ...
  delivery     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists orders_user_idx on public.orders (user_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------------
-- 4. wallets: balance + immutable ledger
------------------------------------------------------------------------------

create table if not exists public.wallets (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    numeric(14, 2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

drop trigger if exists wallets_set_updated_at on public.wallets;
create trigger wallets_set_updated_at
  before update on public.wallets
  for each row execute function public.set_updated_at();

-- amount is signed: positive = money in, negative = money out.
create table if not exists public.wallet_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  kind          text not null check (kind in ('deposit', 'purchase', 'refund', 'adjustment')),
  amount        numeric(14, 2) not null check (amount <> 0),
  balance_after numeric(14, 2) not null check (balance_after >= 0),
  order_id      uuid references public.orders (id) on delete set null,
  note          text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists wallet_transactions_user_idx
  on public.wallet_transactions (user_id, created_at desc);

-- Every profile gets a wallet, whoever created the profile.
create or replace function public.create_wallet_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wallets (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.create_wallet_for_profile();

-- Accounts that signed up before this migration existed.
insert into public.profiles (id, display_name, email)
select
  u.id,
  coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
    split_part(coalesce(u.email, ''), '@', 1)
  ),
  u.email
from auth.users u
on conflict (id) do nothing;

insert into public.wallets (user_id)
select id from public.profiles
on conflict do nothing;

------------------------------------------------------------------------------
-- 5. functions the app calls (the only way money and roles change)
------------------------------------------------------------------------------

-- Customer buys one option with their balance. Atomic: either the balance is
-- charged AND the order + ledger rows exist, or nothing happens.
create or replace function public.purchase_product_option(
  p_option_id uuid,
  p_delivery  jsonb default '{}'::jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user        uuid := auth.uid();
  v_opt         record;
  v_balance     numeric(14, 2);
  v_new_balance numeric(14, 2);
  v_order       public.orders;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if p_delivery is null or jsonb_typeof(p_delivery) <> 'object' then
    p_delivery := '{}'::jsonb;
  end if;
  if pg_column_size(p_delivery) > 2000 then
    raise exception 'delivery_too_large' using errcode = '22023';
  end if;

  select o.id, o.label, o.price, p.name
    into v_opt
    from public.product_options o
    join public.products p on p.id = o.product_id
   where o.id = p_option_id and o.is_active and p.is_active;

  if not found then
    raise exception 'option_unavailable' using errcode = 'P0002';
  end if;

  -- Row lock: two purchases at once can't both spend the same money.
  select balance into v_balance
    from public.wallets
   where user_id = v_user
     for update;

  if not found then
    raise exception 'wallet_missing' using errcode = 'P0002';
  end if;

  if v_balance < v_opt.price then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  v_new_balance := v_balance - v_opt.price;
  update public.wallets set balance = v_new_balance where user_id = v_user;

  insert into public.orders (user_id, option_id, product_name, option_label, amount, delivery)
  values (v_user, v_opt.id, v_opt.name, v_opt.label, v_opt.price, p_delivery)
  returning * into v_order;

  insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note)
  values (v_user, 'purchase', -v_opt.price, v_new_balance, v_order.id, v_opt.name || ' - ' || v_opt.label);

  return v_order;
end;
$$;

-- Admin adds (positive) or removes (negative) money from a user's balance.
create or replace function public.admin_adjust_balance(
  p_user_id uuid,
  p_amount  numeric,
  p_note    text default null
)
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(14, 2);
  v_wallet public.wallets;
  v_new    numeric(14, 2);
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet_missing' using errcode = 'P0002';
  end if;

  v_new := v_wallet.balance + v_amount;
  if v_new < 0 then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  update public.wallets set balance = v_new where user_id = p_user_id
  returning * into v_wallet;

  insert into public.wallet_transactions (user_id, kind, amount, balance_after, note, created_by)
  values (
    p_user_id,
    case when v_amount > 0 then 'deposit' else 'adjustment' end,
    v_amount,
    v_new,
    p_note,
    auth.uid()
  );

  return v_wallet;
end;
$$;

-- Admin moves an order along. Failing or refunding an order returns the money.
--   pending   -> completed | failed (refunds)
--   completed -> refunded           (refunds)
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

  if p_status not in ('completed', 'failed', 'refunded') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if not (
    (v_order.status = 'pending'   and p_status in ('completed', 'failed')) or
    (v_order.status = 'completed' and p_status = 'refunded')
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

-- Promote or demote a user. Refuses to remove the last admin.
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role    text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_role not in ('user', 'admin') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  if v_profile.role = 'admin' and p_role = 'user'
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;

  update public.profiles set role = p_role where id = p_user_id
  returning * into v_profile;

  return v_profile;
end;
$$;

------------------------------------------------------------------------------
-- 6. row level security + privileges
------------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.wallets             enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.products            enable row level security;
alter table public.product_options     enable row level security;
alter table public.orders              enable row level security;

-- profiles: read your own (admins read all). You may only edit display_name and
-- avatar_url; role/email/id are protected by column privileges below.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- wallets + ledger + orders: read-only for clients (own rows; admins see all).
drop policy if exists wallets_select on public.wallets;
create policy wallets_select on public.wallets
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists wallet_transactions_select on public.wallet_transactions;
create policy wallet_transactions_select on public.wallet_transactions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.wallets, public.wallet_transactions, public.orders
  from anon, authenticated;
grant select on public.wallets, public.wallet_transactions, public.orders
  to authenticated;

-- catalog: signed-in users see active items; admins see and edit everything.
drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated
  using (is_active or (select public.is_admin()));

drop policy if exists products_admin_write on public.products;
create policy products_admin_write on public.products
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists product_options_select on public.product_options;
create policy product_options_select on public.product_options
  for select to authenticated
  using (is_active or (select public.is_admin()));

drop policy if exists product_options_admin_write on public.product_options;
create policy product_options_admin_write on public.product_options
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.products, public.product_options from anon, authenticated;
grant select, insert, update, delete
  on public.products, public.product_options to authenticated;

-- functions: only signed-in users may call them (admin_* also check the role).
revoke all on function public.purchase_product_option(uuid, jsonb) from public, anon;
revoke all on function public.admin_adjust_balance(uuid, numeric, text) from public, anon;
revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
revoke all on function public.admin_set_user_role(uuid, text) from public, anon;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.create_wallet_for_profile() from public, anon, authenticated;

grant execute on function public.purchase_product_option(uuid, jsonb) to authenticated;
grant execute on function public.admin_adjust_balance(uuid, numeric, text) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;
grant execute on function public.is_admin() to authenticated;
