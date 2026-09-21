-- topup: several images per product, and one of them assigned to each pack.
-- Run AFTER 20260926090000_pack_image_url.sql. Safe to re-run.
--
-- WHAT THIS DOES (nothing existing is read, rewritten or deleted):
--   1. product_images: the gallery. One row per uploaded image: which product, the path inside the
--      product-art storage bucket, and when it was uploaded. Deleting a product deletes its rows.
--   2. Row-level security, same conventions as product_regions: admins can do everything; other
--      signed-in users can only read images of a product that is on sale. Anonymous: nothing.
--   3. A pack may only use an image from ITS OWN product's gallery (product_options.image_url is checked
--      against product_images), so no arbitrary URL can ever be shown to customers.
--   4. DECISION: deleting an image that packs still use does NOT block. Those packs' image_url is set to
--      NULL by the database and they fall back to the text-only card. (The file in storage is removed by
--      the app afterwards.)
--   5. admin_import_product now also accepts "images": [{"path": "products/xyz.jpg"}, ...], so the images
--      an admin uploads at import are saved with the product, in the same transaction. Everything else
--      about the import (all switched off, offer name required, guards) is unchanged.

------------------------------------------------------------------------------
-- 1. the gallery
------------------------------------------------------------------------------

create table if not exists public.product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products (id) on delete cascade,
  -- The object's path inside the product-art bucket, e.g. products/m1x2y3-ab12cd34.jpg
  path        text not null unique check (path ~ '^products/[a-z0-9-]+\.jpg$'),
  uploaded_at timestamptz not null default now()
);

create index if not exists product_images_product_idx on public.product_images (product_id, uploaded_at);

------------------------------------------------------------------------------
-- 2. row-level security
------------------------------------------------------------------------------

alter table public.product_images enable row level security;

drop policy if exists product_images_select on public.product_images;
create policy product_images_select on public.product_images
  for select to authenticated
  using ((select public.catalog_product_is_live(product_id)) or (select public.is_admin()));

drop policy if exists product_images_admin_write on public.product_images;
create policy product_images_admin_write on public.product_images
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.product_images from anon, authenticated;
grant select, insert, update, delete on public.product_images to authenticated;

------------------------------------------------------------------------------
-- 3. a pack may only use an image from its own product's gallery
------------------------------------------------------------------------------

create or replace function public.guard_pack_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.image_url is not null and not exists (
    select 1
      from public.product_images i
     where i.product_id = new.product_id
       and right(new.image_url, length(i.path) + 1) = '/' || i.path
  ) then
    raise exception 'pack_image_not_in_gallery' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists product_options_image_guard on public.product_options;
create trigger product_options_image_guard
  before insert or update of image_url, product_id on public.product_options
  for each row execute function public.guard_pack_image();

------------------------------------------------------------------------------
-- 4. deleting an image frees the packs that used it (their image becomes NULL)
------------------------------------------------------------------------------

create or replace function public.release_packs_of_image()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.product_options
     set image_url = null
   where product_id = old.product_id
     and image_url is not null
     and right(image_url, length(old.path) + 1) = '/' || old.path;
  return old;
end;
$$;

drop trigger if exists product_images_release_packs on public.product_images;
create trigger product_images_release_packs
  before delete on public.product_images
  for each row execute function public.release_packs_of_image();

------------------------------------------------------------------------------
-- 5. the import saves the gallery too
------------------------------------------------------------------------------

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

    insert into public.product_regions (product_id, code, label, buyer_fields, id_validation, sort_order, is_active)
    values (v_product, v_code, v_label, v_fields, v_mode, v_region_ord, false)
    returning id into v_region_id;

    -- The guard on this table refuses password-login categories.
    insert into public.product_region_supplier (region_id, family, category_id, validation_category_id, validation_field_map)
    values (v_region_id, v_family, v_category_id, v_valid_cat, v_valid_map);

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
         where s.supplier = 'fazercards' and s.family = v_family
           and s.category_id = v_category_id and s.offer_ref = v_offer_ref
      ) then
        raise exception 'already_imported' using errcode = 'P0001', detail = left(v_offer_name, 80);
      end if;

      -- Off, always. A locked pack with no codes is a draft until the codes are typed.
      insert into public.product_options
        (product_id, label, price, group_label, region_id, region_locked, account_region_codes, sort_order, is_active)
      values
        (v_product, v_label, v_price, left(nullif(btrim(coalesce(v_pack ->> 'group_label', '')), ''), 60),
         v_region_id, v_locked, v_codes, v_pack_ord, false)
      returning id into v_option_id;

      -- The guards on this table refuse first-purchase-only offers and password-login categories.
      insert into public.product_option_supplier
        (option_id, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name, last_seen_at)
      values
        (v_option_id, v_family, v_category_id, v_offer_ref, v_cost, v_offer_name, now());
    end loop;
  end loop;

  return v_product;
end;
$$;

revoke all on function public.admin_import_product(jsonb) from public, anon;
grant execute on function public.admin_import_product(jsonb) to authenticated;
