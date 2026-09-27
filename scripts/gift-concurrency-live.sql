-- Setup for scripts/gift-concurrency-live.mjs (run by it, not by hand). Throwaway accounts only
-- (giftrace-*@topup-test.invalid, password GiftRace-2026!); the script's cleanup removes everything this creates.
-- Real paths: a verified (test-key) deposit, then real wallet checkouts of a live gift-card pack, then the new
-- internal create_redeem_code / create_gift on those paid orders.
do $$
declare
  v_email text;
  v_buyer uuid;
  v_dep   uuid;
  v_order uuid;
  i       integer;
begin
  for v_email in select 'giftrace-' || n || '@topup-test.invalid'
                   from unnest(array['buyer','r1','r2','r3','r4','r5','r6','r7','r8']) n loop
    if not exists (select 1 from auth.users where email = v_email) then
      with u as (
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                                raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                confirmation_token, recovery_token, email_change_token_new, email_change,
                                email_change_token_current, phone_change, phone_change_token, reauthentication_token)
        values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', v_email,
                extensions.crypt('GiftRace-2026!', extensions.gen_salt('bf')), now(),
                '{"provider":"email","providers":["email"]}', jsonb_build_object('display_name', 'GIFTRACE'), now(), now(),
                '', '', '', '', '', '', '', '')
        returning id, email
      )
      insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      select gen_random_uuid(), u.id, u.id::text, 'email',
             jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), now(), now(), now() from u;
    end if;
  end loop;

  v_buyer := (select id from auth.users where email = 'giftrace-buyer@topup-test.invalid');
  perform set_config('request.jwt.claim.sub', v_buyer::text, true);

  -- fund the buyer through the real deposit path (test key, so tagged as a test)
  v_dep := (public.create_deposit_request(1500) ->> 'deposit_id')::uuid;
  perform public.begin_deposit_verification(v_dep, v_buyer, 'telebirr', 'GIFTRACE-' || upper(left(v_dep::text, 8)));
  perform public.finish_deposit_verification(v_dep, 'paid', 1500, 'test', 200, '{"note":"gift concurrency test"}'::jsonb);

  -- 7 real wallet checkouts of the live Free Fire Garena card (Br 185): 3 codes for the many-users race, 2 for the
  -- one-user double-tap race, 2 gifts for the claim race
  for i in 1 .. 7 loop
    insert into public.cart_items (user_id, option_id, quantity, fields)
    values (v_buyer, 'f553f779-46ba-4f24-b528-63cf11a17ebc', 1, '{}'::jsonb);
    v_order := (public.checkout_cart(null, null) ->> 'order_id')::uuid;
    if i <= 5 then
      perform public.create_redeem_code(v_order);
    else
      perform public.create_gift(v_order, (select id from auth.users where email = 'giftrace-r1@topup-test.invalid'));
    end if;
  end loop;
end $$;

select (select coalesce(json_agg(c.code order by c.created_at), '[]') from public.redeem_codes c
          join auth.users u on u.id = c.created_by where u.email = 'giftrace-buyer@topup-test.invalid') as codes,
       (select coalesce(json_agg(g.id order by g.created_at), '[]') from public.gifts g
          join auth.users u on u.id = g.recipient_user_id where u.email = 'giftrace-r1@topup-test.invalid') as gifts;
