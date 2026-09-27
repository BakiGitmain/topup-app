-- The live "Delta Force" product (GamesDrop, productId 61, region "Standard") asked customers to tick "I've checked my
-- ID" because it was imported before 'delta force' was in GAMESDROP_VALIDATED_OFFERS; import fixes the check mode at
-- import time, and a catalog refresh/search never changes an existing product.
--
-- validation_category_id holds an OFFER id here, not a category id (opposite of Shop2Topup's own convention, see
-- 20260930170000_delta_force_id_check.sql): GamesDrop's check-game-data takes one fixed offerId with no pack-resolution
-- step, so validate-id's validateWithGamesDrop reads it directly as Number(categoryId). '2578' ("deltaforce 320") is the
-- offer proven live 2026-09-23: real ID 63314139102725674019 -> VALID, gameUserLogin "Beckyx77".
--
-- validation_field_map translates the buyer form's player_id into GamesDrop's own gameUserId param, exactly what
-- mapValidationFields (importPlan.ts) would compute for a fresh import once 'delta force' is in
-- GAMESDROP_VALIDATED_OFFERS -- this migration only backfills it for the region that already exists.
--
-- Only this one region changes. Its packs, price, image and on/off state are not touched.

do $$
declare
  n integer;
begin
  -- A database without this product (a fresh one, or the test database) has nothing to fix. Where it exists, the counts below are strict.
  if not exists (select 1 from public.products where name = 'Delta Force') then
    return;
  end if;

  update public.product_region_supplier s
     set validation_category_id = '2578', validation_supplier = null, validation_field_map = '{"player_id":"gameUserId"}'::jsonb
    from public.product_regions r, public.products p
   where s.region_id = r.id and r.product_id = p.id and p.name = 'Delta Force' and r.label = 'Standard'
     and s.supplier = 'gamesdrop' and s.category_id = '61' and s.validation_category_id is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'deltaforce_gamesdrop_link_expected_1_got_%', n; end if;

  update public.product_regions r
     set id_validation = 'supplier'
    from public.products p
   where r.product_id = p.id and p.name = 'Delta Force' and r.label = 'Standard' and r.id_validation = 'none';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'deltaforce_gamesdrop_region_expected_1_got_%', n; end if;
end
$$;
