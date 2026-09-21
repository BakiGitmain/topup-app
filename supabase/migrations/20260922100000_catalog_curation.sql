-- topup: catalog curation. Artwork, regions, old prices, and admin-only supplier data.
-- Run AFTER 20260921090000_orders_vault_admin.sql. Safe to re-run.
--
-- WHAT THIS DOES TO EXISTING DATA (nothing is deleted or rewritten):
--   * Every existing product and package keeps its current is_active value.
--     Changing a column DEFAULT never touches existing rows, so everything that
--     is on sale today stays on sale, and everything off stays off.
--   * From now on, NEW products, packages and regions start OFF (is_active
--     defaults to false). That is the database default, not UI behaviour.
--   * Existing packages get NULL for the new columns (old_price, group_label,
--     amount_label, region_id). Products get NULL image/description/currency.
--   * Existing orders, prices, ids and the wallet are untouched.
--
-- WHAT CHANGES FOR CUSTOMERS:
--   * A product is only visible if it is on AND has at least one package on.
--     (Before, a product with every package off was shown as an empty shell.)

------------------------------------------------------------------------------
-- 1. new things start hidden
------------------------------------------------------------------------------

alter table public.products        alter column is_active set default false;
alter table public.product_options alter column is_active set default false;

------------------------------------------------------------------------------
-- 2. products: artwork, unit word, description
------------------------------------------------------------------------------

alter table public.products add column if not exists image_url      text;
-- Free text on purpose: the supplier catalog has 136 different unit words
-- ("Diamonds", "Coins", "UC", "CP", "VP", "Wild Cores"...), so this is not an enum.
alter table public.products add column if not exists currency_label text;
alter table public.products add column if not exists description    text;

------------------------------------------------------------------------------
-- 3. regions (one product, many supplier categories)
------------------------------------------------------------------------------

-- A region is what the customer picks ("BD", "Brazil", "Global"). Behind each one
-- sits one supplier category (see product_region_supplier). buyer_fields is the
-- form the customer fills in, copied from the supplier's declared `fields` at
-- import time, so the app can render any game's form:
--   [{"key":"player_id","label":"Player ID","type":"text"},
--    {"key":"server","label":"Server","type":"select","options":[{"label":"Asia","value":"Asia"}]}]
-- id_validation: 'supplier' = the server can check the ID before ordering;
--                'none'     = the customer must tick "I've checked my ID".
create table if not exists public.product_regions (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.products (id) on delete cascade,
  code          text not null,
  label         text not null,
  buyer_fields  jsonb not null default '[]'::jsonb,
  id_validation text not null default 'none' check (id_validation in ('supplier', 'none')),
  sort_order    integer not null default 100,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (product_id, code)
);

create index if not exists product_regions_product_idx on public.product_regions (product_id);

drop trigger if exists product_regions_set_updated_at on public.product_regions;
create trigger product_regions_set_updated_at
  before update on public.product_regions
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------------
-- 4. packages: old price, grouping, region
------------------------------------------------------------------------------

alter table public.product_options add column if not exists old_price    numeric(12, 2);
alter table public.product_options add column if not exists group_label   text;
alter table public.product_options add column if not exists amount_label  text;
alter table public.product_options add column if not exists region_id     uuid
  references public.product_regions (id) on delete restrict;

create index if not exists product_options_region_idx on public.product_options (region_id);

-- A meaningless "old price" is refused at write time, not hidden at render time.
alter table public.product_options drop constraint if exists product_options_old_price_check;
alter table public.product_options
  add constraint product_options_old_price_check
  check (old_price is null or old_price > price);

-- "Cannot be active without a real price" is already guaranteed here:
--   price is NOT NULL and CHECK (price > 0) from the first migration, so a
--   package can never exist, active or not, with a null, zero or negative price.
-- (Kept deliberately. Do not relax it: a priceless active package sells for nothing.)

------------------------------------------------------------------------------
-- 5. supplier data: ADMIN ONLY (never readable by customers)
------------------------------------------------------------------------------

-- Column grants can't tell an admin from a customer (both use the same database
-- role), so supplier ids and wholesale costs live in their own tables whose
-- rows only admins can read.

create table if not exists public.product_region_supplier (
  region_id               uuid primary key references public.product_regions (id) on delete cascade,
  supplier                text not null default 'fazercards',
  family                  text not null check (family in ('topups', 'giftcards', 'gamekeys', 'telegram')),
  -- The id used to PURCHASE (e.g. free_fire_bd).
  category_id             text not null,
  -- The id used to VALIDATE a player id. A different namespace (e.g. free_fire),
  -- and null when the supplier can't validate this game.
  validation_category_id  text,
  -- Purchase field key -> validation field key, where they differ
  -- (Mobile Legends: {"server_id":"zone_id"}).
  validation_field_map    jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now()
);

create table if not exists public.product_option_supplier (
  option_id          uuid primary key references public.product_options (id) on delete cascade,
  supplier           text not null default 'fazercards',
  family             text not null check (family in ('topups', 'giftcards', 'gamekeys', 'telegram')),
  category_id        text not null,
  -- offer_id (top-ups), card_id (gift cards), key_id (game keys) or "3"/"6"/"12" (Telegram months).
  offer_ref          text not null,
  supplier_cost_usd  numeric(12, 4),
  -- Set when the supplier stops listing it. The package stays visible; it fails at
  -- order time with a clear message and is flagged in admin. Nothing is auto-deleted.
  missing_upstream   boolean not null default false,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now(),
  -- The same supplier SKU can only be imported once.
  unique (supplier, family, category_id, offer_ref)
);

------------------------------------------------------------------------------
-- 6. row level security
------------------------------------------------------------------------------

-- Is this product on AND does it have at least one package on? SECURITY DEFINER
-- so the policies below can call it without policies referring to each other.
create or replace function public.catalog_product_is_live(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.products p
     where p.id = p_product_id
       and p.is_active
       and exists (
         select 1 from public.product_options o
          where o.product_id = p.id and o.is_active
       )
  );
$$;

revoke all on function public.catalog_product_is_live(uuid) from public, anon;
grant execute on function public.catalog_product_is_live(uuid) to authenticated;

alter table public.product_regions          enable row level security;
alter table public.product_region_supplier  enable row level security;
alter table public.product_option_supplier  enable row level security;

-- Customers see a product only when it is on and has a package on.
drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated
  using ((select public.catalog_product_is_live(id)) or (select public.is_admin()));

drop policy if exists product_options_select on public.product_options;
create policy product_options_select on public.product_options
  for select to authenticated
  using (
    (is_active and (select public.catalog_product_is_live(product_id)))
    or (select public.is_admin())
  );

drop policy if exists product_regions_select on public.product_regions;
create policy product_regions_select on public.product_regions
  for select to authenticated
  using (
    (is_active and (select public.catalog_product_is_live(product_id)))
    or (select public.is_admin())
  );

drop policy if exists product_regions_admin_write on public.product_regions;
create policy product_regions_admin_write on public.product_regions
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Supplier tables: admins only, for every operation.
drop policy if exists product_region_supplier_admin on public.product_region_supplier;
create policy product_region_supplier_admin on public.product_region_supplier
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists product_option_supplier_admin on public.product_option_supplier;
create policy product_option_supplier_admin on public.product_option_supplier
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.product_regions, public.product_region_supplier, public.product_option_supplier
  from anon, authenticated;
grant select, insert, update, delete on public.product_regions          to authenticated;
grant select, insert, update, delete on public.product_region_supplier  to authenticated;
grant select, insert, update, delete on public.product_option_supplier  to authenticated;

------------------------------------------------------------------------------
-- 7. artwork storage (Supabase only; skipped where the storage schema is absent)
------------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('product-art', 'product-art', true)
    on conflict (id) do nothing;

    drop policy if exists product_art_read on storage.objects;
    create policy product_art_read on storage.objects
      for select using (bucket_id = 'product-art');

    drop policy if exists product_art_admin_insert on storage.objects;
    create policy product_art_admin_insert on storage.objects
      for insert to authenticated
      with check (bucket_id = 'product-art' and (select public.is_admin()));

    drop policy if exists product_art_admin_update on storage.objects;
    create policy product_art_admin_update on storage.objects
      for update to authenticated
      using (bucket_id = 'product-art' and (select public.is_admin()))
      with check (bucket_id = 'product-art' and (select public.is_admin()));

    drop policy if exists product_art_admin_delete on storage.objects;
    create policy product_art_admin_delete on storage.objects
      for delete to authenticated
      using (bucket_id = 'product-art' and (select public.is_admin()));
  end if;
end
$$;
