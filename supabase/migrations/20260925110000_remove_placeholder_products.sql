-- topup: remove the placeholder catalog and the Free Fire test product, so the shop starts empty
-- and everything in it comes from the supplier import. Run AFTER 20260925100000_admin_import.sql.
-- Safe to re-run: with nothing left to remove it does nothing.
--
-- WHAT IT REMOVES (matched by slug, so anything else in the catalog is never touched):
--   the 12 placeholder products from the old seed.sql
--   ethio-airtime and safaricom-airtime (added by hand earlier; nothing in the repo creates them)
--   free-fire-diamonds-test (the real Free Fire MENA test product)
-- ...and, with each product, its packs, its regions, its supplier links and its ID-check records
-- (packs first, because a pack's region link is ON DELETE RESTRICT).
--
-- WHAT IT NEVER TOUCHES: supplier_catalog (the saved supplier catalog), orders, wallets, the vault.
--
-- ORDER HISTORY: an order keeps its own copy of the product name, pack label, amount, delivery details
-- and region, and its link to the pack is ON DELETE SET NULL, so deleting a pack never deletes or edits
-- an order. Even so, this refuses to run at all if any order points at one of these packs or at one of
-- their ID checks: it stops with an error and deletes NOTHING, so you decide what to do first. (At the
-- time of writing the live database has 0 orders.)

do $$
declare
  v_slugs    constant text[] := array[
    'freefire', 'pubg', 'mlbb', 'codm', 'roblox',
    'google-play', 'netflix', 'steam', 'spotify',
    'pc-game-keys', 'telegram-premium', 'playstation-plus',
    'ethio-airtime', 'safaricom-airtime',
    'free-fire-diamonds-test'
  ];
  v_products uuid[];
  v_orders   integer;
  v_checked  integer;
  v_packs    integer;
  v_regions  integer;
begin
  select coalesce(array_agg(id), '{}') into v_products
    from public.products
   where slug = any (v_slugs);

  if cardinality(v_products) = 0 then
    raise notice 'remove_placeholder_products: nothing to remove.';
    return;
  end if;

  -- Orders bought from one of these packs.
  select count(*) into v_orders
    from public.orders o
    join public.product_options po on po.id = o.option_id
   where po.product_id = any (v_products);

  -- Orders whose recorded ID check belongs to one of these regions (deleting the region deletes the check).
  select count(*) into v_checked
    from public.orders o
    join public.id_validations v on v.id = o.validation_id
    join public.product_regions r on r.id = v.region_id
   where r.product_id = any (v_products);

  if v_orders > 0 or v_checked > 0 then
    raise exception 'placeholder_cleanup_blocked_by_orders'
      using errcode = 'P0001',
            detail = format('%s order(s) bought these packs and %s order(s) point at their ID checks. Nothing was deleted.', v_orders, v_checked);
  end if;

  select count(*) into v_packs   from public.product_options where product_id = any (v_products);
  select count(*) into v_regions from public.product_regions where product_id = any (v_products);

  delete from public.product_options where product_id = any (v_products);   -- cascades to product_option_supplier
  delete from public.product_regions where product_id = any (v_products);   -- cascades to product_region_supplier and id_validations
  delete from public.products        where id = any (v_products);

  raise notice 'remove_placeholder_products: removed % products, % regions, % packs.', cardinality(v_products), v_regions, v_packs;
end
$$;
