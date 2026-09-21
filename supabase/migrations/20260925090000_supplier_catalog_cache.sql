-- topup: a saved copy of the supplier catalog, so admin search is fast and import keeps
-- working after the supplier trial ends. Run AFTER 20260924090000_id_validation.sql. Safe to re-run.
--
-- WHAT THIS DOES: adds ONE table. Nothing existing is read, changed or deleted.
--
-- WHAT IT HOLDS (per supplier category, one row):
--   * the listing: name, game, region, the supplier's own note
--   * which supplier ID check fits it (validation_category_id) and that check's form
--   * why it may not be sold, if so (blocked_reason). Those rows stay here but admin search hides them.
--   * its packs and their USD WHOLESALE COST, plus the buyer form, with the date they were fetched.
--     offers is null until a category's packs have been fetched at least once.
--
-- WHO CAN SEE IT: admins only. Customers cannot read a single row (wholesale costs).
-- WHO WRITES IT: only the supplier-catalog Edge Function (service role) and the one-off seed script.

create table if not exists public.supplier_catalog (
  supplier                text not null default 'fazercards',
  family                  text not null check (family in ('topups', 'giftcards')),
  category_id             text not null,
  name                    text not null,
  -- The name without its trailing "(region)": "Free Fire (MENA)" -> "Free Fire". Search groups by this.
  game_name               text not null,
  -- The label a customer sees on the region chip: the "(MENA)" in the name, else the note's region.
  region_label            text,
  -- The supplier's own "Region: X" line, exactly as it says. Null = the supplier doesn't state one.
  note_region             text,
  note                    text,
  validation_category_id  text,
  validation_fields       jsonb,
  blocked_reason          text,
  -- Last time a catalog refresh saw this category.
  listed_at               timestamptz not null default now(),
  -- [{"ref":"110_diamonds","name":"110 Diamonds","cost_usd":"0.9456"}, ...]  sellable packs only.
  offers                  jsonb,
  -- The buyer form the supplier declares for this category.
  fields                  jsonb,
  -- Packs left out because they can't be sold (first-purchase-only, unusable, ...).
  hidden_offer_count      integer not null default 0,
  offers_fetched_at       timestamptz,
  primary key (supplier, family, category_id),
  constraint supplier_catalog_offers_shape check (offers is null or jsonb_typeof(offers) = 'array'),
  constraint supplier_catalog_fields_shape check (fields is null or jsonb_typeof(fields) = 'array')
);

create index if not exists supplier_catalog_game_idx on public.supplier_catalog (lower(game_name));

alter table public.supplier_catalog enable row level security;

drop policy if exists supplier_catalog_admin_select on public.supplier_catalog;
create policy supplier_catalog_admin_select on public.supplier_catalog
  for select to authenticated
  using ((select public.is_admin()));

revoke all on public.supplier_catalog from anon, authenticated;
grant select on public.supplier_catalog to authenticated;
grant all on public.supplier_catalog to service_role;
