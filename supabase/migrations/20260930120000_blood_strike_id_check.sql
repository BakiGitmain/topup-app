-- Blood Strike's live product asks customers to tick "I've checked my ID" because it was
-- imported (from Shop2Topup's out-of-stock MENA category, 445) BEFORE Blood Strike's ID check was wired. Import fixes that mode at
-- import time, and a catalog refresh never changes an existing product. Proven live with a real ID (Global category returns the name).
--
-- The check runs against category 445 as the product's own check category; validate-id falls back to the game's other category
-- (Global, in stock) for a game whose check reports no region, so an out-of-stock 445 does not make Blood Strike "unavailable".
-- Only this one region changes. Its pack, price, image and on/off state are not touched.

do $$
declare
  n integer;
begin
  -- A database without this product (a fresh one, or the test database) has nothing to fix. Where it exists, the counts below are strict.
  if not exists (select 1 from public.products where name = 'Blood Strike') then
    return;
  end if;

  update public.product_region_supplier s
     set validation_category_id = '445', validation_field_map = '{}'::jsonb
    from public.product_regions r, public.products p
   where s.region_id = r.id and r.product_id = p.id and p.name = 'Blood Strike' and r.label = 'MENA'
     and s.supplier = 'shop2topup' and s.category_id = '445' and s.validation_category_id is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'bloodstrike_link_expected_1_got_%', n; end if;

  update public.product_regions r
     set id_validation = 'supplier'
    from public.products p
   where r.product_id = p.id and p.name = 'Blood Strike' and r.label = 'MENA' and r.id_validation = 'none';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'bloodstrike_region_expected_1_got_%', n; end if;
end
$$;
