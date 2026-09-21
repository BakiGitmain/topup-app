-- move the live Free Fire and PUBG Mobile products from FazerCards to Shop2Topup, IN PLACE.
--
-- WHAT CHANGES: only the supplier links. Each pack's link (product_option_supplier) points at the matching Shop2Topup pack and
-- its USD cost; each region's link (product_region_supplier) points at the Shop2Topup category and checks IDs against it.
-- WHAT DOES NOT CHANGE: product_options is not written at all: labels, prices, old prices, images, categories, on/off, region locks,
-- lock codes and order are exactly as they are. The migration proves it: a fingerprint of those columns is taken before and after
-- and the migration FAILS (and rolls back) if it differs. It also fails unless exactly 3 regions and 42 packs were moved.
-- The pairing was matched by total amount ("100 + 10 Diamonds" = 110 Diamonds) or exact name; see the dry-run diff.

-- The consistency trigger would (rightly) refuse a region that moved while its packs have not. Both halves move in THIS transaction.
alter table public.product_option_supplier disable trigger product_option_supplier_consistency;
alter table public.product_region_supplier disable trigger product_region_supplier_consistency;

do $$
declare
  v_before text;
  v_after  text;
  n        integer;
begin
  -- A database without these products (a fresh one, or the test database) has nothing to move. Where they exist, everything below is strict.
  if not exists (select 1 from public.products where name in ('Free Fire', 'PUBG Mobile')) then
    return;
  end if;

  select md5(coalesce(string_agg(concat_ws('|', o.id, o.label, o.price, o.old_price, o.image_url, o.category_id, o.is_active, o.region_locked, o.account_region_codes::text, o.group_label, o.sort_order), ';' order by o.id), '')) into v_before
    from public.product_options o
    join public.product_regions r on r.id = o.region_id
    join public.products p on p.id = r.product_id
   where p.name in ('Free Fire', 'PUBG Mobile');

  -- 1. the regions
  update public.product_region_supplier s
     set supplier = 'shop2topup', category_id = v.to_cat, validation_category_id = v.to_cat, validation_field_map = '{}'::jsonb
    from (values
    ('Free Fire', 'MENA', 'free_fire_mena', '4'),
    ('Free Fire', 'LATAM', 'free_fire_latam', '484'),
    ('PUBG Mobile', 'Auto', 'pubg_mobile_auto', '2')
    ) as v (product, region, from_cat, to_cat), public.product_regions r, public.products p
   where s.region_id = r.id and r.product_id = p.id and p.name = v.product and r.label = v.region
     and s.supplier = 'fazercards' and s.category_id = v.from_cat;
  get diagnostics n = row_count;
  if n <> 3 then raise exception 'repoint_regions_expected_3_got_%', n; end if;

  -- 2. the packs
  update public.product_option_supplier s
     set supplier = 'shop2topup', category_id = v.to_cat, offer_ref = v.sub_id, supplier_offer_name = v.sub_name,
         supplier_cost_usd = v.cost, missing_upstream = false, last_seen_at = now()
    from (values
    ('Free Fire', 'MENA', '110_diamonds', '4', '28', '100 + 10 Diamonds', 0.94564),
    ('Free Fire', 'MENA', '231_diamonds', '4', '29', '210 + 21 Diamonds', 1.89128),
    ('Free Fire', 'MENA', '583_diamonds', '4', '30', '530 + 53 Diamonds', 4.7517),
    ('Free Fire', 'MENA', '1188_diamonds', '4', '31', '1,080 + 108 Diamonds', 9.5034),
    ('Free Fire', 'MENA', '2420_diamonds', '4', '32', '2,200 + 220 Diamonds', 18.9128),
    ('Free Fire', 'LATAM', '110_diamonds', '484', '732', '100 + 10 Diamonds', 0.69512),
    ('Free Fire', 'LATAM', '341_diamonds', '484', '733', '310 + 31 Diamonds', 2.08536),
    ('Free Fire', 'LATAM', 'weekly_membership', '484', '741', 'Weekly Membership', 2.165259),
    ('Free Fire', 'LATAM', '572_diamonds', '484', '734', '520 + 52 Diamonds', 3.53153),
    ('Free Fire', 'LATAM', 'booyah_pass', '484', '738', 'Booyah Pass', 3.835145),
    ('Free Fire', 'LATAM', '1166_diamonds', '484', '735', '1,060 + 106 Diamonds', 6.551706),
    ('Free Fire', 'LATAM', 'monthly_membership', '484', '739', 'Monthly Membership', 10.394841),
    ('Free Fire', 'LATAM', '2398_diamonds', '484', '736', '2,180 + 218 Diamonds', 13.007534),
    ('Free Fire', 'LATAM', '6160_diamonds', '484', '737', '5,600 + 560 Diamonds', 33.094107),
    ('PUBG Mobile', 'Auto', 'weekly_deal_pack_1', '2', '3431', 'Weekly Deal Pack 1', 0.859382),
    ('PUBG Mobile', 'Auto', 'prime_1_month', '2', '3422', 'Prime (1 Month)', 0.86749),
    ('PUBG Mobile', 'Auto', '60_uc', '2', '13', '60 UC', 0.883764),
    ('PUBG Mobile', 'Auto', '60_wow_coins', '2', '4042', '60 WOW Coins', 0.916134),
    ('PUBG Mobile', 'Auto', 'weekly_deal_pack_2', '2', '3432', 'Weekly Deal Pack 2', 2.586256),
    ('PUBG Mobile', 'Auto', 'weekly_mythic_emblem_value_pack', '2', '3433', 'Weekly Mythic Emblem Value Pack', 2.586256),
    ('PUBG Mobile', 'Auto', 'upgradable_firearm_materials_pack', '2', '3430', 'Upgradable Firearm Materials Pack', 2.594363),
    ('PUBG Mobile', 'Auto', 'prime_3_months', '2', '3424', 'Prime (3 Months)', 2.594363),
    ('PUBG Mobile', 'Auto', 'mythic_emblem_pack', '2', '3421', 'Mythic Emblem Pack', 4.321236),
    ('PUBG Mobile', 'Auto', '325_uc', '2', '14', '300 + 25 UC', 4.43205),
    ('PUBG Mobile', 'Auto', '325_wow_coins', '2', '4043', '325 WOW Coins', 4.653638),
    ('PUBG Mobile', 'Auto', 'prime_6_months', '2', '3425', 'Prime (6 Months)', 5.188726),
    ('PUBG Mobile', 'Auto', 'elite_pass_lv1_50', '2', '3418', 'Elite Pass LV1-50', 5.164404),
    ('PUBG Mobile', 'Auto', 'prime_plus_1_month', '2', '3426', 'Prime Plus (1 Month)', 8.642471),
    ('PUBG Mobile', 'Auto', '660_uc', '2', '15', '600 + 60 UC', 8.8641),
    ('PUBG Mobile', 'Auto', '660_wow_coins', '2', '4044', '660 WOW Coins', 9.307277),
    ('PUBG Mobile', 'Auto', 'prime_12_months', '2', '3423', 'Prime (12 Months)', 10.369344),
    ('PUBG Mobile', 'Auto', 'elite_pass_lv1_100', '2', '3417', 'Elite Pass LV1-100', 10.572029),
    ('PUBG Mobile', 'Auto', '1800_uc', '2', '16', '1,500 + 300 UC', 22.16025),
    ('PUBG Mobile', 'Auto', '1800_wow_coins', '2', '4045', '1,800 WOW Coins', 23.260085),
    ('PUBG Mobile', 'Auto', 'elite_pass_plus_lv1_100', '2', '3419', 'Elite Pass Plus LV1-100', 25.830126),
    ('PUBG Mobile', 'Auto', 'prime_plus_3_months', '2', '3428', 'Prime Plus (3 Months)', 25.935522),
    ('PUBG Mobile', 'Auto', '3850_uc', '2', '17', '3,000 + 850 UC', 44.1441),
    ('PUBG Mobile', 'Auto', '3850_wow_coins', '2', '4046', '3,850 WOW Coins', 46.528277),
    ('PUBG Mobile', 'Auto', 'prime_plus_6_months', '2', '3429', 'Prime Plus (6 Months)', 51.862936),
    ('PUBG Mobile', 'Auto', '8100_uc', '2', '18', '6,000 + 2,100 UC', 88.2882),
    ('PUBG Mobile', 'Auto', '8100_wow_coins', '2', '4047', '8,100 WOW Coins', 93.056554),
    ('PUBG Mobile', 'Auto', 'prime_plus_12_months', '2', '3427', 'Prime Plus (12 Months)', 103.733979)
    ) as v (product, region, from_ref, to_cat, sub_id, sub_name, cost), public.product_options o, public.product_regions r, public.products p
   where s.option_id = o.id and o.region_id = r.id and r.product_id = p.id and p.name = v.product and r.label = v.region
     and s.supplier = 'fazercards' and s.offer_ref = v.from_ref;
  get diagnostics n = row_count;
  if n <> 42 then raise exception 'repoint_packs_expected_42_got_%', n; end if;

  -- 3. proof: nothing an admin edited has moved, and nothing of these products is left on FazerCards
  select md5(coalesce(string_agg(concat_ws('|', o.id, o.label, o.price, o.old_price, o.image_url, o.category_id, o.is_active, o.region_locked, o.account_region_codes::text, o.group_label, o.sort_order), ';' order by o.id), '')) into v_after
    from public.product_options o
    join public.product_regions r on r.id = o.region_id
    join public.products p on p.id = r.product_id
   where p.name in ('Free Fire', 'PUBG Mobile');
  if v_before is distinct from v_after then raise exception 'repoint_changed_pack_data'; end if;

  select count(*) into n
    from public.product_option_supplier s
    join public.product_options o on o.id = s.option_id
    join public.product_regions r on r.id = o.region_id
    join public.products p on p.id = r.product_id
   where p.name in ('Free Fire', 'PUBG Mobile') and s.supplier <> 'shop2topup';
  if n <> 0 then raise exception 'repoint_left_on_fazercards_%', n; end if;
end
$$;

alter table public.product_option_supplier enable trigger product_option_supplier_consistency;
alter table public.product_region_supplier enable trigger product_region_supplier_consistency;
