-- The ID-step section title ("Your player ID") and hint ("...exactly as it shows in the game") above the buyer form
-- are generic, hardcoded i18n strings shared by every product -- unlike the field's own label (buyer_fields.label),
-- which is already per-region JSONB and already correctly says "Telegram username" for Telegram. Adds the same kind
-- of per-region override for the section title/hint, nullable so every existing region (which has none) renders
-- exactly the generic copy it always has; only a region that sets one gets different wording.
--
-- English only for now (no Amharic variant), matching buyer_fields.label's own current state -- see CLAUDE.md.

alter table public.product_regions add column if not exists id_section_title text;
alter table public.product_regions add column if not exists id_section_hint text;

do $$
declare
  n integer;
begin
  update public.product_regions r
     set id_section_title = 'Your Telegram username',
         id_section_hint = 'Enter your Telegram username exactly as it appears in your profile.'
    from public.products p
   where r.product_id = p.id and p.name = 'Telegram' and r.id_section_title is null;
  get diagnostics n = row_count;
  if n <> 0 and n <> 2 then raise exception 'telegram_id_copy_expected_0_or_2_got_%', n; end if;
end
$$;
