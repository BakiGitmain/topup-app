-- topup: multi-field buyer IDs, and data-layer guards.
-- Run AFTER 20260922100000_catalog_curation.sql. Safe to re-run.
--
--   1. purchase_product_option now understands multi-field IDs (Mobile Legends needs
--      player id + server id). Old single-ID calls keep working unchanged.
--   2. We NEVER collect a customer's game password. A region whose form asks for one
--      cannot exist, and supplier categories that ask for one cannot be imported.
--   3. Offers that only work once per account ("First Purchase Only", "First Top-Up
--      Bonus"...) cannot be imported: a repeat buyer would get nothing and we'd
--      eat the refund.
--
-- WHAT THIS DOES TO EXISTING DATA: nothing is deleted or rewritten. orders gets one
-- new nullable column. Existing orders keep their delivery JSON as it is.

------------------------------------------------------------------------------
-- 1. orders: remember which region was bought
------------------------------------------------------------------------------

-- A snapshot of the region label ("BD", "Indonesia") so whoever fulfils the order
-- knows which server to top up, even if the region is renamed or removed later.
alter table public.orders add column if not exists region_label text;

------------------------------------------------------------------------------
-- 2. never collect game passwords
------------------------------------------------------------------------------

-- A buyer form is valid only if every field is a plain text or dropdown input with
-- a tame key AND no secret-looking key or label. Labels are checked too, on
-- purpose: the supplier has a category whose field is keyed "server_id" but
-- labelled "Password".
create or replace function public.catalog_fields_are_safe(fields jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  f jsonb;
  k text;
  l text;
begin
  if jsonb_typeof(fields) is distinct from 'array' then
    return false;
  end if;

  for f in select * from jsonb_array_elements(fields) loop
    if jsonb_typeof(f) is distinct from 'object' then
      return false;
    end if;
    k := coalesce(f ->> 'key', '');
    l := coalesce(f ->> 'label', '');
    if k !~ '^[a-z0-9_]{1,40}$' then
      return false;
    end if;
    if coalesce(f ->> 'type', 'text') not in ('text', 'select') then
      return false;
    end if;
    if k ~* '(^|_)(pass|password|passcode|passwd|pwd|secret|otp|2fa|token|credential|credentials|pin|cvv)($|_)'
       or l ~* '\m(pass|password|passcode|passwd|pwd|secret|otp|2fa|token|credentials?|pin|cvv)\M' then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

alter table public.product_regions drop constraint if exists product_regions_buyer_fields_safe;
alter table public.product_regions
  add constraint product_regions_buyer_fields_safe
  check (public.catalog_fields_are_safe(buyer_fields));

-- Supplier categories we refuse to import. Seeded from the full catalog scan:
-- every one of these asks the buyer for their game login (email + password).
create table if not exists public.blocked_supplier_categories (
  supplier    text not null default 'fazercards',
  family      text not null,
  category_id text not null,
  reason      text not null,
  primary key (supplier, family, category_id)
);

insert into public.blocked_supplier_categories (supplier, family, category_id, reason) values
  ('fazercards', 'topups', 'arknight_endfield_login',      'asks for the buyer''s game password'),
  ('fazercards', 'topups', 'genshin_impact_login',         'asks for the buyer''s game password'),
  ('fazercards', 'topups', 'love_and_deepspace_login',     'asks for the buyer''s game password'),
  ('fazercards', 'topups', 'mongil_star_dive',             'asks for the buyer''s game password (labelled, under a server_id key)'),
  ('fazercards', 'topups', 'neverness_to_everness_login',  'asks for the buyer''s game password'),
  ('fazercards', 'topups', 'solo_leveling_arise_login',    'asks for the buyer''s game password'),
  ('fazercards', 'topups', 'tower_of_fantasy_login',       'asks for the buyer''s game password')
on conflict do nothing;

alter table public.blocked_supplier_categories enable row level security;
drop policy if exists blocked_supplier_categories_admin on public.blocked_supplier_categories;
create policy blocked_supplier_categories_admin on public.blocked_supplier_categories
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.blocked_supplier_categories from anon, authenticated;
grant select on public.blocked_supplier_categories to authenticated;

-- Refuse to link a region to a blocked supplier category, whether it is on the
-- list or merely looks like a login category ("..._login") so a future one is
-- caught too.
create or replace function public.guard_region_supplier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
begin
  select reason into v_reason
    from public.blocked_supplier_categories b
   where b.supplier = new.supplier and b.family = new.family and b.category_id = new.category_id;

  if v_reason is null and new.category_id ~* '(^|_)login($|_)' then
    v_reason := 'login-based category (asks for the buyer''s game account)';
  end if;

  if v_reason is not null then
    raise exception 'blocked_supplier_category' using errcode = 'P0001', detail = v_reason;
  end if;
  return new;
end;
$$;

drop trigger if exists product_region_supplier_guard on public.product_region_supplier;
create trigger product_region_supplier_guard
  before insert or update of supplier, family, category_id on public.product_region_supplier
  for each row execute function public.guard_region_supplier();

------------------------------------------------------------------------------
-- 3. offers that only work once per account cannot be imported
------------------------------------------------------------------------------

-- The supplier's own offer name, kept so we can see (and check) what we imported.
alter table public.product_option_supplier add column if not exists supplier_offer_name text;

-- Matches every one-time-per-account shape found in the catalog scan:
--   "250 (FIRST PURCHASE ONLY)", "50 + 50 Diamonds (First Top-Up Bonus)",
--   "First Recharge 100 (...)", "First Purchase Pack", "(First-time buy at half price)".
create or replace function public.is_first_purchase_only(offer_name text)
returns boolean
language sql
immutable
as $$
  select coalesce(offer_name, '') ~*
    '(first|1st)[ _-]?(time[ _-]?)?(purchase|recharge|top[ -]?up|buy|order|deposit)';
$$;

create or replace function public.guard_option_supplier()
returns trigger
language plpgsql
as $$
begin
  if public.is_first_purchase_only(new.supplier_offer_name) then
    raise exception 'first_purchase_only_not_sellable' using errcode = 'P0001', detail = new.supplier_offer_name;
  end if;
  return new;
end;
$$;

drop trigger if exists product_option_supplier_guard on public.product_option_supplier;
create trigger product_option_supplier_guard
  before insert or update of supplier_offer_name on public.product_option_supplier
  for each row execute function public.guard_option_supplier();

------------------------------------------------------------------------------
-- 4. purchase: multi-field buyer IDs
------------------------------------------------------------------------------

-- Two paths, chosen by the package:
--
--  * Package WITH a region: the region declares the form (buyer_fields). The call's
--    p_delivery must be a flat object {"<key>": "<value>", ...} that matches it
--    EXACTLY: no unknown keys, no missing ones, values within limits, dropdown
--    values from the declared options. Stored as
--       delivery = {"fields": {...}, "account_id": "<first field's value>"}
--    (account_id is kept so existing screens that show a single ID still work).
--    A legacy {"account_id": "..."} call is accepted if the region declares
--    exactly ONE field; it is mapped onto that field.
--
--  * Package WITHOUT a region (everything sold before regions existed): unchanged.
--    Game top-ups need {"account_id": "..."}; anything else is stripped.
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
  v_region      record;
  v_region_label text;   -- a plain variable: a record that was never assigned cannot be read, even inside CASE
  v_fulfillment text;
  v_account     text;
  v_delivery    jsonb := '{}'::jsonb;
  v_fields      jsonb := '{}'::jsonb;
  v_first       text;
  v_key         text;
  v_field       jsonb;
  v_raw         jsonb;
  v_val         text;
  v_balance     numeric(14, 2);
  v_new_balance numeric(14, 2);
  v_order       public.orders;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select o.id, o.label, o.price, o.region_id, p.name, p.category
    into v_opt
    from public.product_options o
    join public.products p on p.id = o.product_id
   where o.id = p_option_id and o.is_active and p.is_active;

  if not found then
    raise exception 'option_unavailable' using errcode = 'P0002';
  end if;

  v_fulfillment := case when v_opt.category in ('games', 'airtime') then 'topup' else 'code' end;

  if v_opt.region_id is not null then
    -- ---------------------------------------------------- region path
    select r.label, r.buyer_fields, r.is_active
      into v_region
      from public.product_regions r
     where r.id = v_opt.region_id;

    if not found or not v_region.is_active then
      raise exception 'option_unavailable' using errcode = 'P0002';
    end if;
    v_region_label := v_region.label;

    if jsonb_typeof(p_delivery) is distinct from 'object' then
      p_delivery := '{}'::jsonb;
    end if;

    -- Legacy single-ID call onto a one-field region.
    if jsonb_array_length(v_region.buyer_fields) = 1
       and (select count(*) from jsonb_object_keys(p_delivery)) = 1
       and p_delivery ? 'account_id'
       and (v_region.buyer_fields -> 0 ->> 'key') <> 'account_id' then
      p_delivery := jsonb_build_object(v_region.buyer_fields -> 0 ->> 'key', p_delivery -> 'account_id');
    end if;

    -- No keys the region didn't declare.
    for v_key in select jsonb_object_keys(p_delivery) loop
      if not exists (
        select 1 from jsonb_array_elements(v_region.buyer_fields) f where f ->> 'key' = v_key
      ) then
        raise exception 'buyer_field_unknown' using errcode = '22023', detail = left(v_key, 60);
      end if;
    end loop;

    -- Every declared field, present and valid.
    for v_field in select * from jsonb_array_elements(v_region.buyer_fields) loop
      v_key := v_field ->> 'key';
      v_raw := p_delivery -> v_key;

      if v_raw is null or jsonb_typeof(v_raw) not in ('string', 'number') then
        raise exception 'buyer_field_required' using errcode = '22023', detail = v_key;
      end if;

      v_val := btrim(p_delivery ->> v_key);
      if v_val = '' then
        raise exception 'buyer_field_required' using errcode = '22023', detail = v_key;
      end if;
      if length(v_val) > 128 then
        raise exception 'buyer_field_invalid' using errcode = '22023', detail = v_key;
      end if;

      if coalesce(v_field ->> 'type', 'text') = 'select' and not exists (
        select 1 from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) o
         where o ->> 'value' = v_val
      ) then
        raise exception 'buyer_field_invalid' using errcode = '22023', detail = v_key;
      end if;

      v_fields := v_fields || jsonb_build_object(v_key, v_val);
      v_first  := coalesce(v_first, v_val);
    end loop;

    v_delivery := jsonb_build_object('fields', v_fields);
    if v_first is not null then
      v_delivery := v_delivery || jsonb_build_object('account_id', v_first);
    end if;
  elsif v_fulfillment = 'topup' then
    -- ---------------------------------------------------- legacy path (no region)
    v_account := btrim(coalesce(p_delivery ->> 'account_id', ''));
    if v_account = '' then
      raise exception 'account_id_required' using errcode = '22023';
    end if;
    if length(v_account) > 64 then
      raise exception 'account_id_invalid' using errcode = '22023';
    end if;
    -- Only the fields we know about are stored, whatever the client sent.
    v_delivery := jsonb_build_object('account_id', v_account);
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

  insert into public.orders (user_id, option_id, product_name, option_label, amount, delivery, fulfillment, region_label)
  values (v_user, v_opt.id, v_opt.name, v_opt.label, v_opt.price, v_delivery, v_fulfillment,
          v_region_label)
  returning * into v_order;

  insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note)
  values (v_user, 'purchase', -v_opt.price, v_new_balance, v_order.id, v_opt.name || ' - ' || v_opt.label);

  return v_order;
end;
$$;

revoke all on function public.purchase_product_option(uuid, jsonb) from public, anon;
grant execute on function public.purchase_product_option(uuid, jsonb) to authenticated;
