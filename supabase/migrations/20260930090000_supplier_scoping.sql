-- topup: name the supplier on every supplier link, so FazerCards and Shop2Topup can sit side by side. Safe to re-run.
--
-- WHAT WAS ALREADY THERE (inspected, not assumed): product_option_supplier, product_region_supplier, supplier_catalog and
-- blocked_supplier_categories ALL already have a `supplier text not null default 'fazercards'` column, the saved catalog's key is
-- (supplier, family, category_id), and the guards (blocked categories, first-purchase offers) already look at the row's own
-- supplier. So nothing needs adding and nothing needs backfilling: all 43 pack links, 4 region links and 885 catalog rows
-- on the live project already say 'fazercards'. (The columns you called supplier_category_id / offer_id are category_id / offer_ref.)
--
-- WHAT THIS ADDS: rules, so the supplier name can't drift or be mixed up. Nothing about any live product's behaviour changes.
--   1. Only known supplier names are allowed on all four tables: 'fazercards' and 'shop2topup'. (A typo can no longer create a
--      third, silent supplier.)
--   2. A pack's supplier link must name the SAME supplier as its region's link. A region's category and its packs' offers are
--      one supplier's ids; mixing them would order from one supplier with the other's numbers.
--   3. id_validation_supplier() tells validate-id which supplier a region belongs to, so each check goes to the right one.
--      (A new function; id_validation_target() is left exactly as it was.)

alter table public.product_option_supplier drop constraint if exists product_option_supplier_supplier_check;
alter table public.product_option_supplier
  add constraint product_option_supplier_supplier_check check (supplier in ('fazercards', 'shop2topup'));

alter table public.product_region_supplier drop constraint if exists product_region_supplier_supplier_check;
alter table public.product_region_supplier
  add constraint product_region_supplier_supplier_check check (supplier in ('fazercards', 'shop2topup'));

alter table public.supplier_catalog drop constraint if exists supplier_catalog_supplier_check;
alter table public.supplier_catalog
  add constraint supplier_catalog_supplier_check check (supplier in ('fazercards', 'shop2topup'));

alter table public.blocked_supplier_categories drop constraint if exists blocked_supplier_categories_supplier_check;
alter table public.blocked_supplier_categories
  add constraint blocked_supplier_categories_supplier_check check (supplier in ('fazercards', 'shop2topup'));

-- 2. one supplier per region and its packs
create or replace function public.guard_supplier_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other text;
begin
  if tg_table_name = 'product_option_supplier' then
    -- A pack linked to supplier X inside a region linked to supplier Y.
    select s.supplier into v_other
      from public.product_options o
      join public.product_region_supplier s on s.region_id = o.region_id
     where o.id = new.option_id;
    if v_other is not null and v_other <> new.supplier then
      raise exception 'supplier_mismatch' using errcode = 'P0001',
        detail = format('the region is linked to %s but this pack to %s', v_other, new.supplier);
    end if;
  else
    -- A region moved to supplier X while some of its packs are linked to supplier Y.
    select s.supplier into v_other
      from public.product_options o
      join public.product_option_supplier s on s.option_id = o.id
     where o.region_id = new.region_id and s.supplier <> new.supplier
     limit 1;
    if v_other is not null then
      raise exception 'supplier_mismatch' using errcode = 'P0001',
        detail = format('a pack in this region is linked to %s, not %s', v_other, new.supplier);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists product_option_supplier_consistency on public.product_option_supplier;
create trigger product_option_supplier_consistency
  before insert or update of supplier, option_id on public.product_option_supplier
  for each row execute function public.guard_supplier_consistency();

drop trigger if exists product_region_supplier_consistency on public.product_region_supplier;
create trigger product_region_supplier_consistency
  before insert or update of supplier, region_id on public.product_region_supplier
  for each row execute function public.guard_supplier_consistency();

-- 3. which supplier a region's ID check belongs to. A NEW function, so id_validation_target() is not touched: changing its
-- columns would need a drop-and-recreate, and every earlier migration re-creates it with the old columns.
create or replace function public.id_validation_supplier(p_region_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.supplier
    from public.product_regions r
    join public.products p on p.id = r.product_id
    join public.product_region_supplier s on s.region_id = r.id
   where r.id = p_region_id and r.is_active and p.is_active;
$$;

revoke all on function public.id_validation_supplier(uuid) from public, anon, authenticated;
grant execute on function public.id_validation_supplier(uuid) to service_role;
