-- topup: a fresh import of Blood Strike. Fulfilment = Shop2Topup (its Global Blood Strike category, 491: cheaper
-- than GamesDrop's equivalent by roughly 0.2% on the matching packs, in stock, and the same supplier Free Fire/PUBG
-- already run on). Validation = GamesDrop (offerId 2733, "bloodstrike 51"): both suppliers' Blood Strike checks return
-- the same real player for the confirmed test ID (568840231399), but ONLY GamesDrop's check ever says "invalid" for a
-- wrong one -- Shop2Topup's Blood Strike check answers "temporarily unavailable" for every nonsense ID tried (see
-- CLAUDE.md), so it can never tell a customer's typo from an outage. Neither supplier's Blood Strike check reports an
-- account region, so this import is not region-locked on either side.
--
-- FazerCards is NOT used anywhere in this migration (superseding the earlier draft, which was FazerCards-fulfilled): the
-- final supplier decision is Shop2Topup and GamesDrop only, selected per import by the admin, never auto-decided.
--
-- WHAT IT DOES: calls the real admin_import_product(jsonb) -- the exact function and rules every import goes through --
-- impersonating a real admin (session-local set_config('request.jwt.claim.sub', ..., true), reset at commit; the same
-- technique this project's DB tests already use). Skips (no-op) if a product named 'Blood Strike' already exists, or if
-- no admin profile exists yet (empty/test databases). Needs 20260930140000 (validation_supplier) and 20260930150000
-- (gamesdrop added to the supplier registry) to already be applied.
--
-- PACKS AND PRICES: all 15 of Shop2Topup's Blood Strike Global offers (its own catalog, category 491), priced at cost x
-- today's saved rate (175) x 0% -- the calculator's own formula (src/lib/priceCalc.ts, calcPrice); the field map
-- ({"player_id":"gameUserId"}) is exactly what mapValidationFields(purchase, check) computes for these two forms.
-- Everything OFF, as every import.

do $$
declare
  v_admin uuid;
  v_id    uuid;
begin
  if exists (select 1 from public.products where name = 'Blood Strike') then
    raise notice 'Blood Strike already exists; nothing to import.';
    return;
  end if;

  -- No admin profile yet (a fresh/test database) has nothing to import as: skip, same as the "product doesn't exist"
  -- guard above. On the live project an admin profile always exists by the time this runs.
  select id into v_admin from public.profiles where role = 'admin' order by id limit 1;
  if v_admin is null then
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  select public.admin_import_product($json${"name":"Blood Strike","category":"games","tagline":"Gold","currency_label":"Gold","image_url":null,"regions":[{"code":"global","label":"Global","buyer_fields":[{"key":"player_id","label":"Player ID","type":"text"}],"id_validation":"supplier","family":"topups","category_id":"491","validation_category_id":"2733","validation_field_map":{"player_id":"gameUserId"},"supplier":"shop2topup","validation_supplier":"gamesdrop","packs":[{"offer_ref":"1638","offer_name":"51 Gold","label":"51 Gold","price":69,"cost_usd":"0.3915","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1639","offer_name":"100 + 5 Gold","label":"100 + 5 Gold","price":135,"cost_usd":"0.7670","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1640","offer_name":"300 + 20 Gold","label":"300 + 20 Gold","price":410,"cost_usd":"2.3410","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1641","offer_name":"500 + 40 Gold","label":"500 + 40 Gold","price":686,"cost_usd":"3.9150","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1642","offer_name":"1,000 + 100 Gold","label":"1,000 + 100 Gold","price":1374,"cost_usd":"7.8461","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1643","offer_name":"2,000 + 260 Gold","label":"2,000 + 260 Gold","price":2751,"cost_usd":"15.7161","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1644","offer_name":"5,000 + 800 Gold","label":"5,000 + 800 Gold","price":6888,"cost_usd":"39.3582","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1645","offer_name":"0.99 Deal","label":"0.99 Deal","price":136,"cost_usd":"0.7750","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1646","offer_name":"Bloodstrike Pre-order Item","label":"Bloodstrike Pre-order Item","price":293,"cost_usd":"1.6716","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1647","offer_name":"Level Up Pass","label":"Level Up Pass","price":275,"cost_usd":"1.5660","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1648","offer_name":"Lucky Bag Week","label":"Lucky Bag Week","price":136,"cost_usd":"0.7750","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1649","offer_name":"Strike Pass Elite","label":"Strike Pass Elite","price":551,"cost_usd":"3.1480","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1650","offer_name":"Strike Pass Premium","label":"Strike Pass Premium","price":1242,"cost_usd":"7.0950","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1651","offer_name":"Ultra Skin Lucky Chest","label":"Ultra Skin Lucky Chest","price":69,"cost_usd":"0.3915","group_label":null,"region_locked":false,"account_region_codes":[]},{"offer_ref":"1652","offer_name":"Value Season Pass","label":"Value Season Pass","price":136,"cost_usd":"0.7750","group_label":null,"region_locked":false,"account_region_codes":[]}]}]}$json$::jsonb) into v_id;
  if v_id is null then
    raise exception 'blood_strike_import_failed';
  end if;

  -- proof, not just hope: fulfilment is Shop2Topup, validation is GamesDrop, in each one's own category, and it starts off
  if not exists (
    select 1
      from public.product_regions r
      join public.product_region_supplier s on s.region_id = r.id
     where r.product_id = v_id and r.label = 'Global' and r.id_validation = 'supplier'
       and s.supplier = 'shop2topup' and s.category_id = '491'
       and s.validation_supplier = 'gamesdrop' and s.validation_category_id = '2733'
  ) then
    raise exception 'blood_strike_import_shape_unexpected';
  end if;
  if exists (select 1 from public.products where id = v_id and is_active) then
    raise exception 'blood_strike_import_not_off';
  end if;
  if (select count(*) from public.product_option_supplier s join public.product_options o on o.id = s.option_id where o.product_id = v_id and s.supplier <> 'shop2topup') > 0 then
    raise exception 'blood_strike_import_pack_not_shop2topup';
  end if;
end
$$;
