-- Root cause of the live "Couldn't check the ID right now" failure on the Standard/Shop2Topup Telegram region,
-- confirmed by reproducing validate-id's real packsOf() logic against the live DB and Shop2Topup API (2026-09-23):
-- the reimport-fix migration (20260930200000) set validation_category_id = '3441', a PACK id ("50 Stars"). For
-- Shop2Topup, validation_category_id must be a CATEGORY id (packsOf() resolves the real pack from it at check time,
-- the same convention already correct for Free Fire MENA ('4') and Delta Force Mobile ('1180')) -- this is the
-- opposite mistake from the one already caught and fixed for Delta Force. With '3441' stored, packsOf('3441')
-- found no supplier_catalog row for that "category", fell back to a live GET /catalog/subcategories?categoryId=3441
-- (a pack has no subcategories of its own), got back an empty list, and validateWithAnyPack([], ...) threw
-- S2Error(503, 'NO_PACK') -- classified as "unavailable", shown to the customer as a generic failure.
--
-- Fix: validation_category_id = '1736', Telegram's real Shop2Topup category (already cached in supplier_catalog,
-- 16 offers, including 3441 itself, which packsOf will now correctly resolve to and try). Nothing else changes.

do $$
declare
  n integer;
begin
  -- A database without this exact stale value (a fresh/test database, or the live one after this already applied) has
  -- nothing to fix: 0 is a normal, safe outcome here, not an error.
  update public.product_region_supplier s
     set validation_category_id = '1736'
    from public.product_regions r, public.products p
   where s.region_id = r.id and r.product_id = p.id and p.name = 'Telegram' and r.code = 'standard'
     and s.supplier = 'shop2topup' and s.validation_category_id = '3441';
  get diagnostics n = row_count;
  if n not in (0, 1) then raise exception 'telegram_standard_validation_category_fix_expected_0_or_1_got_%', n; end if;
end
$$;
