-- Adds a second region, "Premium", to the existing live "Telegram" product, sourced from GamesDrop's dedicated
-- "Telegram Premium" product (productId 137: 3/6/12-month packs, proven live 2026-09-23 with real ID
-- 63314139102725674019 -> "Baki Cheats.py" against offer 459). Fulfilment AND validation are both GamesDrop, the same
-- pattern already used for Delta Force's GamesDrop region.
--
-- Telegram's EXISTING region ("Standard", Shop2Topup category 1736: 13 Stars packs + 3 hand-priced "Premium X Months"
-- packs, 0 orders on any of them) is left completely untouched: one region cannot mix suppliers
-- (guard_supplier_consistency), and GamesDrop's Telegram Premium product does not sell Stars, so this adds a region
-- rather than repointing the existing one -- the admin's explicit choice (three options were offered; this was picked).
--
-- admin_import_product cannot be reused here: it always creates a brand-new product, and Telegram already exists. This
-- inserts directly into the four tables it would itself write to for one new region, in the same order, with the same
-- columns -- product_regions -> product_region_supplier -> product_options (x3) -> product_option_supplier (x3).
--
-- Prices: cost USD x 175 (the saved rate) x 0%, rounded up -- the same "cost x rate x 0%" convention every other
-- fresh GamesDrop region has used (Blood Strike, Delta Force). GamesDrop's raw costs (12.41/16.55/29.95) are cheaper
-- than Shop2Topup's for the same months (13.62/18.16/32.94), so this undercuts the existing Shop2Topup Premium packs;
-- the admin can move either the price or the markup with the calculator's own stepper on the edit screen.
--
-- Starts OFF (region and every pack), like every new region/pack, even though the product itself is already live.

do $$
declare
  v_product     uuid;
  v_region_id   uuid;
  v_option_id   uuid;
begin
  select id into v_product from public.products where name = 'Telegram';
  if v_product is null then
    raise notice 'no Telegram product; nothing to add.';
    return;
  end if;

  if exists (
    select 1 from public.product_regions r
     where r.product_id = v_product and r.code = 'premium'
  ) then
    raise notice 'Telegram already has a "premium" region; nothing to add.';
    return;
  end if;

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

  if (select count(*) from public.product_options where region_id = v_region_id) <> 3 then
    raise exception 'telegram_premium_pack_count_wrong';
  end if;
end
$$;
