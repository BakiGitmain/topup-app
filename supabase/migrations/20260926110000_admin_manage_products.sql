-- topup: remove an imported product, and save many on/off switches in ONE request.
-- Run AFTER 20260926100000_create_product_images.sql. Safe to re-run (it replaces the two functions).
--
-- WHAT THIS DOES: adds two functions, both admin-only (the database re-checks the role). No table, column
-- or row changes, and nothing runs until an admin uses them from the app.
--
-- 1. admin_delete_product(product_id)
--    Same safety rule as the placeholder cleanup: if ANY order points at one of the product's packs, or at
--    one of its regions' ID checks, it refuses (error product_has_orders) and deletes nothing: hide the
--    product instead. With no such orders it hard-deletes the product and everything under it (packs, regions,
--    supplier links, ID checks, image rows, categories) in one transaction. It returns the storage file paths
--    that belonged to the product so the app can delete the files afterwards.
--
-- 2. admin_apply_active_changes(changes)
--    changes = {"products": [{"id": "...", "is_active": true}], "regions": [...], "options": [...]}
--    ALL-OR-NOTHING. Every change is tried; if any one is refused (for example a region-locked pack with no
--    account regions cannot be switched on) the whole request is rolled back, so no partial state is ever
--    left behind, and the error names each refused item:
--      error 'active_changes_failed', detail = [{"kind":"options","id":"...","reason":"..."}, ...]

------------------------------------------------------------------------------
-- 1. remove a product
------------------------------------------------------------------------------

create or replace function public.admin_delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_image_url text;
  v_paths     text[];
  v_orders    integer;
  v_checked   integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select image_url into v_image_url from public.products where id = p_product_id for update;
  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  select count(*) into v_orders
    from public.orders o
    join public.product_options po on po.id = o.option_id
   where po.product_id = p_product_id;

  select count(*) into v_checked
    from public.orders o
    join public.id_validations v on v.id = o.validation_id
    join public.product_regions r on r.id = v.region_id
   where r.product_id = p_product_id;

  if v_orders > 0 or v_checked > 0 then
    raise exception 'product_has_orders' using errcode = 'P0001',
      detail = format('%s order(s) bought this product. Hide it instead of removing it.', v_orders + v_checked);
  end if;

  v_paths := array(select path from public.product_images where product_id = p_product_id);

  -- Packs first: a pack's region link (and category link) must not block the deletes below.
  delete from public.product_options where product_id = p_product_id;   -- cascades to product_option_supplier
  delete from public.product_regions where product_id = p_product_id;   -- cascades to product_region_supplier, id_validations
  delete from public.products        where id = p_product_id;           -- cascades to product_images (and categories)

  return jsonb_build_object('image_url', v_image_url, 'image_paths', to_jsonb(v_paths));
end;
$$;

revoke all on function public.admin_delete_product(uuid) from public, anon;
grant execute on function public.admin_delete_product(uuid) to authenticated;

------------------------------------------------------------------------------
-- 2. save many on/off switches at once, all or nothing
------------------------------------------------------------------------------

create or replace function public.admin_apply_active_changes(p_changes jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind     text;
  v_table    text;
  v_item     jsonb;
  v_id       uuid;
  v_active   boolean;
  v_rows     integer;
  v_applied  integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_reason   text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' then
    raise exception 'changes_invalid' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_changes) k where k not in ('products', 'regions', 'options')) > 0 then
    raise exception 'changes_invalid' using errcode = '22023';
  end if;

  foreach v_kind in array array['products', 'regions', 'options'] loop
    if p_changes -> v_kind is null or jsonb_typeof(p_changes -> v_kind) = 'null' then
      continue;
    end if;
    if jsonb_typeof(p_changes -> v_kind) <> 'array' or jsonb_array_length(p_changes -> v_kind) > 500 then
      raise exception 'changes_invalid' using errcode = '22023';
    end if;
    v_table := case v_kind when 'products' then 'products' when 'regions' then 'product_regions' else 'product_options' end;

    for v_item in select value from jsonb_array_elements(p_changes -> v_kind) loop
      if jsonb_typeof(v_item) is distinct from 'object'
         or coalesce(v_item ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         or jsonb_typeof(v_item -> 'is_active') is distinct from 'boolean' then
        raise exception 'changes_invalid' using errcode = '22023';
      end if;
      v_id := (v_item ->> 'id')::uuid;
      v_active := (v_item ->> 'is_active')::boolean;

      begin
        execute format('update public.%I set is_active = $1 where id = $2', v_table) using v_active, v_id;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          v_failures := v_failures || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id, 'reason', 'not_found'));
        else
          v_applied := v_applied + 1;
        end if;
      exception when others then
        get stacked diagnostics v_reason = message_text;
        v_failures := v_failures || jsonb_build_array(jsonb_build_object('kind', v_kind, 'id', v_id, 'reason', left(v_reason, 200)));
      end;
    end loop;
  end loop;

  if jsonb_array_length(v_failures) > 0 then
    -- Raising rolls back every change made above: nothing is left half-applied.
    raise exception 'active_changes_failed' using errcode = 'P0001', detail = v_failures::text;
  end if;

  return v_applied;
end;
$$;

revoke all on function public.admin_apply_active_changes(jsonb) from public, anon;
grant execute on function public.admin_apply_active_changes(jsonb) to authenticated;
