-- Gifts and redeem codes, part 4 of 4: the security pass. FORWARD-ONLY, re-runnable. No table or column changes;
-- redeem/claim/checkout logic is NOT touched. Three fixes found in the audit:
--
-- 1. SENDER PRIVACY. my_vault_gifts sent the gift's sender (name, picture, and the local part of their EMAIL when no
--    name was set) to the recipient. For a gift that came from a REDEEM CODE the "recipient" is whoever typed the
--    code -- possibly a stranger the code was sold or posted to -- so the buyer's identity leaked to them. The app
--    already hid it, but it still crossed the network. Now: a code's gift carries no sender at all, and a direct
--    gift never falls back to the email (same 'Portal user' fallback gift_order_summary uses).
--
-- 2. CODES PEOPLE CAN TYPE. Codes are handed over on paper and in chats; 0/O and 1/I look alike. New codes use the
--    32 characters left after removing those four (A-Z without I and O, then 2-9). 32 divides 256, so each random
--    byte maps to a character with no bias and nothing is thrown away. 32^10 = 1.1e15 codes (from 3.7e15): at the
--    redeem rate limit (10 misses / 10 min per account) guessing stays hopeless. Existing codes are untouched and
--    still redeem exactly as before (the column check is still ^[A-Z0-9]{10}$, a superset).
--
-- 3. LOCKDOWN. Supabase grants EXECUTE on every new public function to anon and authenticated by default. Three
--    constant helpers (gift_ttl, redeem_limits, email_lookup_limits) were never revoked, so a signed-out caller could
--    read the rate limits. Harmless, but nothing internal should be callable: revoked. (They are only called from
--    SECURITY DEFINER functions, which run as the owner.)

-- ------------------------------------------------------------------------------------------------ 1. sender privacy

create or replace function public.my_vault_gifts()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'sort_key' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', g.id, 'status', case when g.status = 'pending' and g.expires_at <= now() then 'expired' else g.status end,
      'created_at', g.created_at, 'expires_at', g.expires_at, 'claimed_at', g.claimed_at,
      'from_code', g.redeem_code_id is not null,
      -- a code's buyer stays anonymous to whoever redeemed it; a direct gift shows its sender's own name, never email
      'sender_name', case when g.redeem_code_id is null then coalesce(nullif(btrim(sp.display_name), ''), 'Portal user') end,
      'sender_avatar', case when g.redeem_code_id is null then sp.avatar_url end,
      'product_id', p.id, 'product_name', p.name, 'image_url', p.image_url, 'tint', p.tint, 'category', p.category,
      'option_label', o.label, 'region_id', r.id, 'region_label', r.label,
      'buyer_fields', coalesce(r.buyer_fields, '[]'::jsonb), 'id_validation', coalesce(r.id_validation, 'none'),
      'region_locked', o.region_locked, 'account_region_codes', to_jsonb(coalesce(o.account_region_codes, '{}'::text[])),
      'id_section_title', r.id_section_title, 'id_section_hint', r.id_section_hint,
      'delivery_order_id', d.id, 'delivery_status', d.status,
      'sort_key', (case when g.status = 'pending' and g.expires_at > now() then '1' else '0' end) || g.created_at::text) as x
      from public.gifts g
      join public.product_options o on o.id = g.option_id
      join public.products p on p.id = g.product_id
      left join public.product_regions r on r.id = o.region_id
      left join public.profiles sp on sp.id = g.sender_id
      left join public.orders d on d.gift_id = g.id
     where g.recipient_user_id = auth.uid()
  ) s
$$;
revoke all on function public.my_vault_gifts() from public, anon;
grant execute on function public.my_vault_gifts() to authenticated;

-- ------------------------------------------------------------------------------------------------ 2. unambiguous codes

-- 10 characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789, from a cryptographically strong source: gen_random_uuid()
-- draws on pg_strong_random (the OS CSPRNG). Only the 13 fully random bytes of each UUID are used (bytes 6 and 8
-- carry version/variant bits); byte & 31 picks the character, exactly uniform since 256 = 8 x 32.
create or replace function public.generate_redeem_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code     text := '';
  v_bytes    bytea;
  v_i        integer;
begin
  while length(v_code) < 10 loop
    v_bytes := uuid_send(gen_random_uuid());
    for v_i in 0 .. 15 loop
      continue when v_i in (6, 8);
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_i) & 31) + 1, 1);
      exit when length(v_code) = 10;
    end loop;
  end loop;
  return v_code;
end;
$$;
revoke all on function public.generate_redeem_code() from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ 3. lockdown

revoke all on function public.gift_ttl() from public, anon, authenticated;
revoke all on function public.redeem_limits() from public, anon, authenticated;
revoke all on function public.email_lookup_limits() from public, anon, authenticated;
-- Trigger functions can't be called directly anyway ("trigger functions can only be called as triggers"); revoked
-- too, so the rule "no gift function is callable unless it is meant to be" holds without exceptions.
revoke all on function public.guard_redeem_code_update() from public, anon, authenticated;
revoke all on function public.guard_gift_update() from public, anon, authenticated;
revoke all on function public.guard_gift_delivery_order() from public, anon, authenticated;
