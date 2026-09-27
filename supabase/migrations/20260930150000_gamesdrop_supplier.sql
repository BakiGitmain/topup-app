-- topup: add GamesDrop as a third known supplier. Safe to re-run.
--
-- WHY: the final supplier decision (2026-09-22) is Shop2Topup and GamesDrop, selectable per import by the admin
-- (FazerCards' trial has ended and it is no longer offered as a choice anywhere; see CLAUDE.md). This widens the four
-- already-live CHECK constraints from ('fazercards', 'shop2topup') to include 'gamesdrop'.
--
-- FazerCards is deliberately LEFT IN these constraints, not removed: `supplier_catalog` still holds 885 rows of its
-- cached scan and `blocked_supplier_categories` still holds 7 of its block entries (both historical, harmless, and
-- explicitly asked to be left alone); no live product's fulfilment or validation is tagged 'fazercards' any more
-- (verified: 0 rows in product_option_supplier and product_region_supplier), so removing it from the constraint would
-- change nothing live today, but would also gain nothing -- it would just mean re-adding it later if that data is ever
-- queried by name again. It is simply not offered anywhere any more: not in the admin import screen's supplier picker,
-- and not callable from either Edge Function (supplier-catalog, validate-id) -- see the 2026-09-21 entry in CLAUDE.md.

alter table public.product_option_supplier drop constraint if exists product_option_supplier_supplier_check;
alter table public.product_option_supplier
  add constraint product_option_supplier_supplier_check check (supplier in ('fazercards', 'shop2topup', 'gamesdrop'));

alter table public.product_region_supplier drop constraint if exists product_region_supplier_supplier_check;
alter table public.product_region_supplier
  add constraint product_region_supplier_supplier_check check (supplier in ('fazercards', 'shop2topup', 'gamesdrop'));

alter table public.supplier_catalog drop constraint if exists supplier_catalog_supplier_check;
alter table public.supplier_catalog
  add constraint supplier_catalog_supplier_check check (supplier in ('fazercards', 'shop2topup', 'gamesdrop'));

alter table public.blocked_supplier_categories drop constraint if exists blocked_supplier_categories_supplier_check;
alter table public.blocked_supplier_categories
  add constraint blocked_supplier_categories_supplier_check check (supplier in ('fazercards', 'shop2topup', 'gamesdrop'));
