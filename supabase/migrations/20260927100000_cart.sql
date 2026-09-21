-- topup: real payment. Part 2 of 3: the cart. Run AFTER 20260927090000_payment_orders.sql. Safe to re-run.
--
-- WHAT THIS DOES: adds one table, cart_items. Nothing existing is touched.
--
-- One row = one pack for one player account: `fields` is THAT line's own player/game ID form (a Free Fire ID and a
-- PUBG ID are different accounts, so there is no cart-wide ID). The same pack with the same ID is one line whose
-- quantity goes up; the same pack for a different ID is a separate line.
--
-- The cart holds NO prices. Prices, availability and ID checks are all read fresh from the catalog at checkout
-- (create_cart_order), so a stale cart can never charge a stale price.
--
-- RLS: a customer reads and writes only their own rows. (Anyone may add any pack id here; checkout is what
-- decides whether it can be bought.)

create table if not exists public.cart_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  option_id  uuid not null references public.product_options (id) on delete cascade,
  quantity   integer not null default 1 check (quantity between 1 and 20),
  fields     jsonb not null default '{}'::jsonb
             check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) < 2000),
  -- What makes two lines "the same pack for the same account".
  fields_key text generated always as (fields::text) stored,
  -- The customer's tick "I've checked my ID", for regions the supplier can't check.
  id_checked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cart_items_line_unique unique (user_id, option_id, fields_key)
);

create index if not exists cart_items_user_idx on public.cart_items (user_id, created_at);

drop trigger if exists cart_items_set_updated_at on public.cart_items;
create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

-- A cart holds at most 30 lines.
create or replace function public.guard_cart_size()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.cart_items where user_id = new.user_id) >= 30 then
    raise exception 'cart_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists cart_items_size_guard on public.cart_items;
create trigger cart_items_size_guard
  before insert on public.cart_items
  for each row execute function public.guard_cart_size();

alter table public.cart_items enable row level security;

drop policy if exists cart_items_own on public.cart_items;
create policy cart_items_own on public.cart_items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.cart_items from anon, authenticated;
grant select, insert, update, delete on public.cart_items to authenticated;
