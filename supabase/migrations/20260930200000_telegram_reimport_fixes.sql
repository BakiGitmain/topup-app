-- The live "Telegram" product was deleted and re-imported fresh (a new product_id), which lost three things fixed
-- earlier: its category (back to the import default "games"), its Shop2Topup ID check on the Stars region
-- (validation_category_id, offer 3441, proven live 2026-09-22/23 with real username baki_x_yosi -> "Baki Cheats.py"),
-- and the whole GamesDrop "Premium" region (20260930190000_telegram_premium_gamesdrop.sql only fixed the PREVIOUS
-- product_id, which no longer exists). This re-applies all three against whichever product_id "Telegram" has now.
--
-- Everything here is a straight repeat of the earlier, already-proven fixes -- no new decisions. See CLAUDE.md
-- 2026-09-22 (category) and 2026-09-23 (both validations) for the reasoning already written up.

do $$
declare
  v_product   uuid;
  v_region_id uuid;
  v_option_id uuid;
  n           integer;
begin
  select id into v_product from public.products where name = 'Telegram';
  if v_product is null then
    raise notice 'no Telegram product; nothing to fix.';
    return;
  end if;

  -- 1. category
  update public.products set category = 'subscriptions' where id = v_product and category <> 'subscriptions';

  -- 2. Stars (Standard, Shop2Topup category 1736): wire its own supplier's check, same as before.
  update public.product_region_supplier s
     set validation_category_id = '3441', validation_supplier = null, validation_field_map = '{}'::jsonb
    from public.product_regions r
   where s.region_id = r.id and r.product_id = v_product and r.code = 'standard'
     and s.supplier = 'shop2topup' and s.category_id = '1736' and s.validation_category_id is null;

  update public.product_regions
     set id_validation = 'supplier'
   where product_id = v_product and code = 'standard' and id_validation = 'none';

  -- 3. Premium region (GamesDrop productId 137), recreated exactly as 20260930190000 did for the deleted product.
  if not exists (select 1 from public.product_regions where product_id = v_product and code = 'premium') then
    insert into public.product_regions (product_id, code, label, buyer_fields, id_validation, sort_order, is_active)
    values (
      v_product, 'premium', 'Premium',
      '[{"key":"player_id","label":"Player ID","type":"text"}]'::jsonb,
      'supplier',
      (select coalesce(max(sort_order), 0) + 1 from public.product_regions where product_id = v_product),
      false
    )
    returning id into v_region_id;

    insert into public.product_region_supplier
      (region_id, supplier, family, category_id, validation_supplier, validation_category_id, validation_field_map)
    values
      (v_region_id, 'gamesdrop', 'topups', '137', null, '459', '{"player_id":"gameUserId"}'::jsonb);

    insert into public.product_options (product_id, label, price, region_id, sort_order, is_active)
    values (v_product, 'Premium 3 Months', 2172, v_region_id, 1, false)
    returning id into v_option_id;
    insert into public.product_option_supplier (option_id, supplier, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name, last_seen_at)
    values (v_option_id, 'gamesdrop', 'topups', '137', '459', 12.41, '3 Months Telegram Premium', now());

    insert into public.product_options (product_id, label, price, region_id, sort_order, is_active)
    values (v_product, 'Premium 6 Months', 2897, v_region_id, 2, false)
    returning id into v_option_id;
    insert into public.product_option_supplier (option_id, supplier, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name, last_seen_at)
    values (v_option_id, 'gamesdrop', 'topups', '137', '460', 16.55, '6 Months Telegram Premium', now());

    insert into public.product_options (product_id, label, price, region_id, sort_order, is_active)
    values (v_product, 'Premium 12 Months', 5242, v_region_id, 3, false)
    returning id into v_option_id;
    insert into public.product_option_supplier (option_id, supplier, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name, last_seen_at)
    values (v_option_id, 'gamesdrop', 'topups', '137', '461', 29.95, '12 Months Telegram Premium', now());
  end if;

  -- proof
  if (select category from public.products where id = v_product) <> 'subscriptions' then
    raise exception 'telegram_category_not_fixed';
  end if;
  select count(*) into n from public.product_regions where product_id = v_product and id_validation = 'supplier';
  if n <> 2 then
    raise exception 'telegram_expected_2_supplier_regions_got_%', n;
  end if;
end
$$;
