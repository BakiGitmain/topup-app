-- Free Fire: MENA first (and so the region the product page opens on), LATAM second. Owner's call 2026-09-27.
-- DATA ONLY, re-runnable, a no-op on a database without that product (test databases).
--
-- The product page lists regions by product_regions.sort_order and opens on the first (lib/productView sortRegions /
-- initialRegionId). Free Fire's regions tied, so the label broke the tie and LATAM (L < M) came first. This orders
-- them explicitly on every product named 'Free Fire' that has BOTH a MENA and a LATAM region (the game top-up
-- product; the Free Fire gift-card product has neither): MENA 0, LATAM 1, any other region of it after them in its
-- existing order. Nothing else is touched (no pack, price, lock or on/off value).
with target as (
  select r.product_id
    from public.product_regions r
    join public.products p on p.id = r.product_id
   where p.name = 'Free Fire'
   group by r.product_id
  having bool_or(upper(r.label) = 'MENA') and bool_or(upper(r.label) = 'LATAM')
),
ranked as (
  select r.id,
         row_number() over (
           partition by r.product_id
           order by case upper(r.label) when 'MENA' then 0 when 'LATAM' then 1 else 2 end, r.sort_order, r.label
         ) - 1 as new_order
    from public.product_regions r
   where r.product_id in (select product_id from target)
)
update public.product_regions r
   set sort_order = ranked.new_order
  from ranked
 where r.id = ranked.id and r.sort_order is distinct from ranked.new_order;
