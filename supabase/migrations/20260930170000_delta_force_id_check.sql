-- Delta Force Mobile's live MENA region (Shop2Topup category 1180) asks customers to tick "I've checked my ID"
-- because it was imported before Delta Force Mobile was in VALIDATED_GAMES; import fixes the check mode at import
-- time, and a catalog refresh never changes an existing product. Proven live with a real Garena ID (2026-09-22):
-- category 1180's own pack 3402 returned the same name and region ("ME") this ID returns on Free Fire, confirming
-- Delta Force Mobile shares Garena's account ID space. validation_category_id is the CATEGORY id (matching Free
-- Fire MENA's own wiring, category 4), not a pack id: validate-id's packsOf() resolves the actual pack (e.g. 3402)
-- from the saved catalog at check time, the same way it already does for every other Shop2Topup game.
--
-- Only this one region changes. Its packs, prices, image and on/off state are not touched.

do $$
declare
  n integer;
begin
  -- A database without this product (a fresh one, or the test database) has nothing to fix. Where it exists, the counts below are strict.
  if not exists (select 1 from public.products where name = 'Delta Force Mobile') then
    return;
  end if;

  update public.product_region_supplier s
     set validation_category_id = '1180', validation_supplier = null, validation_field_map = '{}'::jsonb
    from public.product_regions r, public.products p
   where s.region_id = r.id and r.product_id = p.id and p.name = 'Delta Force Mobile' and r.label = 'MENA'
     and s.supplier = 'shop2topup' and s.category_id = '1180' and s.validation_category_id is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'deltaforce_link_expected_1_got_%', n; end if;

  update public.product_regions r
     set id_validation = 'supplier'
    from public.products p
   where r.product_id = p.id and p.name = 'Delta Force Mobile' and r.label = 'MENA' and r.id_validation = 'none';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'deltaforce_region_expected_1_got_%', n; end if;
end
$$;
