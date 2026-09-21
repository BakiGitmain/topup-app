-- topup: an optional image on each pack (product_options). Run AFTER 20260925110000_remove_placeholder_products.sql.
-- Safe to re-run.
--
-- WHAT THIS DOES: adds one nullable column. Every existing pack gets NULL (no image), so nothing changes
-- for anyone until an admin picks an image for a pack. Nothing is read, rewritten or deleted.
--
-- The value is a full https URL of a file in the product-art bucket. The next migration
-- (create_product_images) additionally makes the database refuse any URL that is not one of the product's
-- own uploaded images.

alter table public.product_options add column if not exists image_url text;

alter table public.product_options drop constraint if exists product_options_image_url_check;
alter table public.product_options
  add constraint product_options_image_url_check
  check (image_url is null or image_url ~ '^https://[^[:space:]]+$');
