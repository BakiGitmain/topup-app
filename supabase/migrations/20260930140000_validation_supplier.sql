-- topup: decouple which supplier CHECKS a region's IDs from which supplier its packs/prices come from. Safe to re-run.
--
-- WHY: one supplier can be cheaper for a game, or better stocked, while a DIFFERENT supplier is the one whose ID check is
-- actually reliable for it (Blood Strike: Shop2Topup's packs, GamesDrop's check -- Shop2Topup's own Blood Strike check
-- can never say "invalid", only "unavailable"). Until now `product_region_supplier.supplier` meant both "where the packs
-- come from" AND "who validates", so a region could only be checked by whichever supplier it was imported from. This adds
-- a SEPARATE, optional `validation_supplier`.
--
-- WHAT CHANGES:
--   1. product_region_supplier gets `validation_supplier text` (nullable), with the same known-suppliers check as `supplier`.
--      NULL (the default, and every existing row) means "same as `supplier`" -- nothing about any live product's behaviour
--      changes. `validation_category_id` / `validation_field_map` already lived on this table and already meant "in the
--      VALIDATING supplier's namespace" (that was simply always the same namespace as `supplier` until now).
--   2. id_validation_supplier() returns coalesce(validation_supplier, supplier) instead of just supplier. validate-id's
--      TypeScript is untouched: it already calls this function and feeds its result straight into the validator router.
--   3. admin_import_product(jsonb) accepts an optional `regions[].validation_supplier` in the payload (one of the known
--      suppliers, or omitted/blank = inherit `supplier`, exactly as before). Forced to null when a region's id_validation
--      isn't 'supplier' (nothing to route in that case). Every other rule of the import is unchanged.
--
-- WHAT DOES NOT CHANGE: product_option_supplier (the packs) has no validation_supplier -- a check is answered once per
-- REGION, for every pack in it, same as before. guard_supplier_consistency() (product_option_supplier <-> its region's
-- `supplier`) is untouched: it is about FULFILMENT only, and validation was never part of it.

alter table public.product_region_supplier add column if not exists validation_supplier text;

alter table public.product_region_supplier drop constraint if exists product_region_supplier_validation_supplier_check;
alter table public.product_region_supplier
  add constraint product_region_supplier_validation_supplier_check
  check (validation_supplier is null or validation_supplier in ('fazercards', 'shop2topup', 'gamesdrop'));

create or replace function public.id_validation_supplier(p_region_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(s.validation_supplier, s.supplier)
    from public.product_regions r
    join public.products p on p.id = r.product_id
    join public.product_region_supplier s on s.region_id = r.id
   where r.id = p_region_id and r.is_active and p.is_active;
$$;

-- admin_import_product: the previous version (20260930100000) with `validation_supplier` parsed, validated, and stored.
-- This is that version with exactly those additions; nothing else in it was touched.
create or replace function public.admin_import_product(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name        text;
  v_category    text;
  v_tagline     text;
  v_currency    text;
  v_image       text;
  v_slug        text;
  v_glyph       text;
  v_tint        text;
  v_product     uuid;
  v_img         jsonb;
  v_path        text;
  v_cat         jsonb;
  v_cat_ids     jsonb := '{}'::jsonb;
  v_cat_count   integer := 0;
  v_cat_key     text;
  v_cat_id      uuid;
  v_pack_cat    uuid;
  v_region      jsonb;
  v_region_ord  integer;
  v_region_id   uuid;
  v_code        text;
  v_label       text;
  v_fields      jsonb;
  v_mode        text;
  v_family      text;
  v_category_id text;
  v_valid_cat   text;
  v_valid_map   jsonb;
  v_pack        jsonb;
  v_pack_ord    integer;
  v_option_id   uuid;
  v_offer_ref   text;
  v_offer_name  text;
  v_price       numeric;
  v_cost        numeric;
  v_locked      boolean;
  v_codes       text[];
  v_supplier    text;
  v_valid_sup   text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'import_invalid' using errcode = '22023', detail = 'payload';
  end if;

  -- ---- the product
  v_name := btrim(coalesce(p_payload ->> 'name', ''));
  if v_name = '' or length(v_name) > 120 then
    raise exception 'import_invalid' using errcode = '22023', detail = 'name';
  end if;
  v_category := p_payload ->> 'category';
  if v_category is null or v_category not in ('games', 'gift-cards') then
    raise exception 'import_invalid' using errcode = '22023', detail = 'category';
  end if;
  v_tagline  := left(btrim(coalesce(p_payload ->> 'tagline', '')), 120);
  v_currency := left(nullif(btrim(coalesce(p_payload ->> 'currency_label', '')), ''), 40);
  v_image    := nullif(btrim(coalesce(p_payload ->> 'image_url', '')), '');
  if v_image is not null and v_image !~ '^https://[^[:space:]]+$' then
    raise exception 'import_invalid' using errcode = '22023', detail = 'image_url';
  end if;
  if jsonb_typeof(p_payload -> 'regions') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'regions') not between 1 and 40 then
    raise exception 'import_invalid' using errcode = '22023', detail = 'regions';
  end if;

  v_glyph := case v_category when 'games' then 'diamond' else 'gift' end;
  v_tint  := case v_category when 'games' then '#FBEBD0' else '#D3F5E3' end;
  v_slug  := coalesce(nullif(left(btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-'), 40), ''), 'product')
             || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6);

  insert into public.products (slug, name, category, tagline, glyph, tint, image_url, currency_label, sort_order, is_active)
  values (v_slug, v_name, v_category, v_tagline, v_glyph, v_tint, v_image, v_currency,
          (select coalesce(max(sort_order), 0) + 1 from public.products), false)
  returning id into v_product;

  -- ---- the image gallery (optional)
  if p_payload -> 'images' is not null and jsonb_typeof(p_payload -> 'images') <> 'null' then
    if jsonb_typeof(p_payload -> 'images') <> 'array' or jsonb_array_length(p_payload -> 'images') > 12 then
      raise exception 'import_invalid' using errcode = '22023', detail = 'images';
    end if;
    for v_img in select value from jsonb_array_elements(p_payload -> 'images') loop
      v_path := btrim(coalesce(v_img ->> 'path', ''));
      if v_path !~ '^products/[a-z0-9-]+\.jpg$' then
        raise exception 'import_invalid' using errcode = '22023', detail = 'image_path';
      end if;
      insert into public.product_images (product_id, path) values (v_product, v_path);
    end loop;
  end if;

  -- ---- the product's categories (optional): "UC", "Coins", "Membership", ...
  if p_payload -> 'categories' is not null and jsonb_typeof(p_payload -> 'categories') <> 'null' then
    if jsonb_typeof(p_payload -> 'categories') <> 'array' or jsonb_array_length(p_payload -> 'categories') > 12 then
      raise exception 'import_invalid' using errcode = '22023', detail = 'categories';
    end if;
    for v_cat in select value from jsonb_array_elements(p_payload -> 'categories') loop
      v_cat_key := btrim(coalesce(v_cat ->> 'key', ''));
      v_label   := btrim(coalesce(v_cat ->> 'label', ''));
      if v_cat_key !~ '^[a-z0-9_-]{1,40}$' or v_cat_ids ? v_cat_key or v_label = '' or length(v_label) > 40 then
        raise exception 'import_invalid' using errcode = '22023', detail = 'category';
      end if;
      v_cat_count := v_cat_count + 1;
      insert into public.product_categories (product_id, label, sort_order)
      values (v_product, v_label, v_cat_count)
      returning id into v_cat_id;
      v_cat_ids := v_cat_ids || jsonb_build_object(v_cat_key, v_cat_id);
    end loop;
  end if;

  -- ---- regions
  v_region_ord := 0;
  for v_region in select value from jsonb_array_elements(p_payload -> 'regions') loop
    v_region_ord := v_region_ord + 1;

    if jsonb_typeof(v_region) is distinct from 'object' then
      raise exception 'import_invalid' using errcode = '22023', detail = 'region';
    end if;
    v_code := btrim(coalesce(v_region ->> 'code', ''));
    if v_code !~ '^[a-z0-9_]{1,40}$' then
      raise exception 'import_invalid' using errcode = '22023', detail = 'region_code';
    end if;
    v_label := btrim(coalesce(v_region ->> 'label', ''));
    if v_label = '' or length(v_label) > 60 then
      raise exception 'import_invalid' using errcode = '22023', detail = 'region_label';
    end if;

    v_fields := coalesce(v_region -> 'buyer_fields', '[]'::jsonb);
    if not public.catalog_fields_are_safe(v_fields) then
      raise exception 'import_invalid' using errcode = '22023', detail = 'buyer_fields';
    end if;

    v_family := v_region ->> 'family';
    if v_family is null or v_family not in ('topups', 'giftcards') then
      raise exception 'import_invalid' using errcode = '22023', detail = 'family';
    end if;
    v_category_id := btrim(coalesce(v_region ->> 'category_id', ''));
    if v_category_id = '' then
      raise exception 'import_invalid' using errcode = '22023', detail = 'category_id';
    end if;

    -- Which supplier this region's category and packs belong to. No tag means FazerCards, which is what every earlier import was.
    v_supplier := coalesce(nullif(btrim(coalesce(v_region ->> 'supplier', '')), ''), 'fazercards');
    if v_supplier not in ('fazercards', 'shop2topup', 'gamesdrop') then
      raise exception 'import_invalid' using errcode = '22023', detail = 'supplier';
    end if;

    -- Which supplier CHECKS this region's IDs, if different from the one above. Blank/omitted = inherit v_supplier.
    v_valid_sup := nullif(btrim(coalesce(v_region ->> 'validation_supplier', '')), '');
    if v_valid_sup is not null and v_valid_sup not in ('fazercards', 'shop2topup', 'gamesdrop') then
      raise exception 'import_invalid' using errcode = '22023', detail = 'validation_supplier';
    end if;

    v_mode := coalesce(v_region ->> 'id_validation', 'none');
    if v_mode not in ('supplier', 'none') then
      raise exception 'import_invalid' using errcode = '22023', detail = 'id_validation';
    end if;
    v_valid_cat := case when v_mode = 'supplier' then nullif(btrim(coalesce(v_region ->> 'validation_category_id', '')), '') end;
    if v_mode = 'supplier' and v_valid_cat is null then
      raise exception 'import_invalid' using errcode = '22023', detail = 'validation_category_id';
    end if;
    v_valid_map := coalesce(v_region -> 'validation_field_map', '{}'::jsonb);
    if jsonb_typeof(v_valid_map) is distinct from 'object' then
      raise exception 'import_invalid' using errcode = '22023', detail = 'validation_field_map';
    end if;
    -- Nothing to route when there is no check: keep the column clean rather than store a supplier name that means nothing.
    if v_mode <> 'supplier' then
      v_valid_sup := null;
    end if;

    insert into public.product_regions (product_id, code, label, buyer_fields, id_validation, sort_order, is_active)
    values (v_product, v_code, v_label, v_fields, v_mode, v_region_ord, false)
    returning id into v_region_id;

    -- The guard on this table refuses password-login categories.
    insert into public.product_region_supplier (region_id, supplier, family, category_id, validation_category_id, validation_field_map, validation_supplier)
    values (v_region_id, v_supplier, v_family, v_category_id, v_valid_cat, v_valid_map, v_valid_sup);

    -- ---- packs
    if jsonb_typeof(v_region -> 'packs') is distinct from 'array'
       or jsonb_array_length(v_region -> 'packs') not between 1 and 300 then
      raise exception 'import_invalid' using errcode = '22023', detail = 'packs';
    end if;

    v_pack_ord := 0;
    for v_pack in select value from jsonb_array_elements(v_region -> 'packs') loop
      v_pack_ord := v_pack_ord + 1;

      if jsonb_typeof(v_pack) is distinct from 'object' then
        raise exception 'import_invalid' using errcode = '22023', detail = 'pack';
      end if;

      v_offer_ref := btrim(coalesce(v_pack ->> 'offer_ref', ''));
      if v_offer_ref = '' then
        raise exception 'import_invalid' using errcode = '22023', detail = 'offer_ref';
      end if;

      -- ALWAYS recorded. The first-purchase guard passes a null name, so refuse it here.
      v_offer_name := btrim(coalesce(v_pack ->> 'offer_name', ''));
      if v_offer_name = '' then
        raise exception 'offer_name_required' using errcode = '22023', detail = left(v_offer_ref, 60);
      end if;

      v_label := btrim(coalesce(v_pack ->> 'label', ''));
      if v_label = '' or length(v_label) > 80 then
        raise exception 'import_invalid' using errcode = '22023', detail = 'pack_label';
      end if;

      if coalesce(v_pack ->> 'price', '') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then
        raise exception 'import_invalid' using errcode = '22023', detail = 'price';
      end if;
      v_price := (v_pack ->> 'price')::numeric;
      if v_price <= 0 then
        raise exception 'import_invalid' using errcode = '22023', detail = 'price';
      end if;

      if v_pack -> 'cost_usd' is null or jsonb_typeof(v_pack -> 'cost_usd') = 'null' then
        v_cost := null;
      elsif coalesce(v_pack ->> 'cost_usd', '') ~ '^[0-9]{1,9}(\.[0-9]{1,6})?$' then
        v_cost := (v_pack ->> 'cost_usd')::numeric;
      else
        raise exception 'import_invalid' using errcode = '22023', detail = 'cost_usd';
      end if;

      if jsonb_typeof(coalesce(v_pack -> 'region_locked', 'false'::jsonb)) is distinct from 'boolean' then
        raise exception 'import_invalid' using errcode = '22023', detail = 'region_locked';
      end if;
      v_locked := coalesce((v_pack ->> 'region_locked')::boolean, false);

      if jsonb_typeof(coalesce(v_pack -> 'account_region_codes', '[]'::jsonb)) is distinct from 'array' then
        raise exception 'import_invalid' using errcode = '22023', detail = 'account_region_codes';
      end if;
      if exists (
        select 1 from jsonb_array_elements(coalesce(v_pack -> 'account_region_codes', '[]'::jsonb)) c
         where jsonb_typeof(c) is distinct from 'string'
      ) then
        raise exception 'import_invalid' using errcode = '22023', detail = 'account_region_codes';
      end if;
      v_codes := array(select jsonb_array_elements_text(coalesce(v_pack -> 'account_region_codes', '[]'::jsonb)));

      if exists (
        select 1 from public.product_option_supplier s
         where s.supplier = v_supplier and s.family = v_family
           and s.category_id = v_category_id and s.offer_ref = v_offer_ref
      ) then
        raise exception 'already_imported' using errcode = 'P0001', detail = left(v_offer_name, 80);
      end if;

      -- The pack's category. With two or more categories every pack must be in one (else it would be
      -- unreachable behind the category pills).
      v_pack_cat := null;
      v_cat_key  := btrim(coalesce(v_pack ->> 'category_key', ''));
      if v_cat_key <> '' then
        if not (v_cat_ids ? v_cat_key) then
          raise exception 'import_invalid' using errcode = '22023', detail = 'category_key';
        end if;
        v_pack_cat := (v_cat_ids ->> v_cat_key)::uuid;
      elsif v_cat_count >= 2 then
        raise exception 'import_invalid' using errcode = '22023', detail = 'category_key';
      end if;

      -- Off, always. A locked pack with no codes is a draft until the codes are typed.
      insert into public.product_options
        (product_id, label, price, group_label, region_id, region_locked, account_region_codes, sort_order, is_active, category_id)
      values
        (v_product, v_label, v_price, left(nullif(btrim(coalesce(v_pack ->> 'group_label', '')), ''), 60),
         v_region_id, v_locked, v_codes, v_pack_ord, false, v_pack_cat)
      returning id into v_option_id;

      -- The guards on this table refuse first-purchase-only offers and password-login categories.
      insert into public.product_option_supplier
        (option_id, supplier, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name, last_seen_at)
      values
        (v_option_id, v_supplier, v_family, v_category_id, v_offer_ref, v_cost, v_offer_name, now());
    end loop;
  end loop;

  return v_product;
end;
$$;

revoke all on function public.admin_import_product(jsonb) from public, anon;
grant execute on function public.admin_import_product(jsonb) to authenticated;
