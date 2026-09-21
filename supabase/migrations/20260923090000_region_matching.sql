-- topup: per-package region lock + per-package supplier category guard.
-- Run AFTER 20260922140000_multifield_purchase_and_guards.sql. Safe to re-run.
--
-- WHY: one product's packages can come from DIFFERENT supplier categories
-- (Free Fire diamonds from free_fire_mena, other packs from other categories),
-- and the supplier's packs are region-locked per category. So "is this package
-- right for this player's account region?" is a property of the PACKAGE, not of
-- the region chip it is displayed under. The chip stays presentation/grouping plus
-- the buyer form; each package already carries its own supplier category and offer
-- (product_option_supplier.category_id / offer_ref).
--
-- The supplier's ID validation returns the region the ACCOUNT belongs to
-- (Free Fire ID 3327205705 -> "ME"). The app compares it with the package.
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing changes for them.
--   * product_options gets region_locked (false) and account_region_codes ('{}').
--     Every existing package stays "not region-locked" and stays live.
--   * product_region_supplier.category_id becomes optional (it is no longer
--     authoritative; packages carry their own category).
--   * blocked (password-login) categories are now also refused on packages.

------------------------------------------------------------------------------
-- 1. region lock on the package
------------------------------------------------------------------------------

-- region_locked   : only accounts from account_region_codes may buy this package.
-- account_region_codes: supplier account-region codes it serves, e.g. {ME}.
-- Not secrets, so customers read them along with the rest of the package.
alter table public.product_options
  add column if not exists region_locked boolean not null default false,
  add column if not exists account_region_codes text[] not null default '{}';

-- Short plain codes only ("ME", "BR", "MY_SG").
create or replace function public.catalog_region_codes_are_safe(codes text[])
returns boolean
language sql
immutable
as $$
  select codes is not null
     and not exists (
       select 1 from unnest(codes) c where c is null or c !~ '^[A-Za-z0-9_-]{1,16}$'
     );
$$;

-- Stored upper-case, trimmed, de-duplicated and sorted. Runs before the CHECKs.
create or replace function public.normalize_option_region_codes()
returns trigger
language plpgsql
as $$
begin
  new.account_region_codes := coalesce(
    (select array_agg(distinct upper(btrim(c)) order by upper(btrim(c)))
       from unnest(new.account_region_codes) c),
    '{}'
  );
  return new;
end;
$$;

drop trigger if exists product_options_region_codes_normalize on public.product_options;
create trigger product_options_region_codes_normalize
  before insert or update of account_region_codes on public.product_options
  for each row execute function public.normalize_option_region_codes();

alter table public.product_options drop constraint if exists product_options_region_codes_safe;
alter table public.product_options
  add constraint product_options_region_codes_safe
  check (public.catalog_region_codes_are_safe(account_region_codes));

-- A package that is not region-locked serves everyone, so it lists no codes.
alter table public.product_options drop constraint if exists product_options_codes_need_lock;
alter table public.product_options
  add constraint product_options_codes_need_lock
  check (region_locked or cardinality(account_region_codes) = 0);

-- THE RULE: a locked package with unknown codes cannot go live. It may be saved
-- as a draft (inactive); switching it on needs the codes first.
alter table public.product_options drop constraint if exists product_options_locked_needs_codes_to_be_live;
alter table public.product_options
  add constraint product_options_locked_needs_codes_to_be_live
  check (not (is_active and region_locked and cardinality(account_region_codes) = 0));

------------------------------------------------------------------------------
-- 2. the supplier category is per package now: block bad categories there too
------------------------------------------------------------------------------

alter table public.product_region_supplier alter column category_id drop not null;

-- One place that decides whether a supplier category may be sold. Returns the
-- reason, or null when it is fine. Covers the list AND anything that looks like
-- a login category ("..._login"), so a future one is caught too.
create or replace function public.supplier_category_block_reason(p_supplier text, p_family text, p_category_id text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reason text;
begin
  if p_category_id is null then
    return null;
  end if;

  select reason into v_reason
    from public.blocked_supplier_categories b
   where b.supplier = p_supplier and b.family = p_family and b.category_id = p_category_id;

  if v_reason is null and p_category_id ~* '(^|_)login($|_)' then
    v_reason := 'login-based category (asks for the buyer''s game account)';
  end if;
  return v_reason;
end;
$$;

revoke all on function public.supplier_category_block_reason(text, text, text) from public, anon;
grant execute on function public.supplier_category_block_reason(text, text, text) to authenticated;

create or replace function public.guard_region_supplier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := public.supplier_category_block_reason(new.supplier, new.family, new.category_id);
begin
  if v_reason is not null then
    raise exception 'blocked_supplier_category' using errcode = 'P0001', detail = v_reason;
  end if;
  return new;
end;
$$;

-- The same refusal on the package's own category. Before this, a password-login
-- category could have been attached to a single package and slipped past the
-- region-level guard.
create or replace function public.guard_option_supplier_category()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := public.supplier_category_block_reason(new.supplier, new.family, new.category_id);
begin
  if v_reason is not null then
    raise exception 'blocked_supplier_category' using errcode = 'P0001', detail = v_reason;
  end if;
  return new;
end;
$$;

drop trigger if exists product_option_supplier_category_guard on public.product_option_supplier;
create trigger product_option_supplier_category_guard
  before insert or update of supplier, family, category_id on public.product_option_supplier
  for each row execute function public.guard_option_supplier_category();
