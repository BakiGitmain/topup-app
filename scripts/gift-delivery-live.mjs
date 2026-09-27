// Gifts part 3, against the linked project: claiming delivers exactly once through the ordinary delivery step, even
// under 8 simultaneous claims and 8 simultaneous delivery calls; a pack that needs a player ID refuses without one
// and delivers with a real, supplier-checked one; a redeemed code claims and delivers the same way; a delivery that
// never went through is recovered by the normal admin path; both sides' Orders and Vault reads reflect it.
//
//   node --env-file=.env scripts/gift-delivery-live.mjs
//
// Throwaway accounts only (gdel-*@topup-test.invalid), removed at the end, pass or fail. FULFILLMENT_MODE is 'mock',
// so "delivery" is the real step with the mock supplier: nothing is bought from a real supplier.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rowsFromCliOutput } from './cliQueryRows.mjs';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON) throw new Error('run with --env-file=.env');
const PASSWORD = 'GiftDel-2026!';
const CARD = 'f553f779-46ba-4f24-b528-63cf11a17ebc'; // Free Fire Garena card (a code, no player ID)
const MENA = '60422b84-37e9-403f-af8f-72ee2030616d'; // Free Fire MENA 100+10 Diamonds (supplier-checked, locked ME)
const REAL_GARENA_ID = '6823793183'; // a real Garena account already used by this project's ID-check tests

function sql(query) {
  const file = path.join(os.tmpdir(), `gdel-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(file, query);
  try {
    for (let attempt = 1; ; attempt++) {
      let out;
      try {
        out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-o', 'json', '-f', `"${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        if (attempt >= 3) throw new Error(String(e.stderr || e.message).slice(0, 600));
        continue;
      }
      // Only the CLI call is retried: once it ran, the SQL ran, and re-running it would repeat its writes.
      return rowsFromCliOutput(out);
    }
  } finally { fs.rmSync(file, { force: true }); }
}
const mkUser = (name) => `
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change,
                          email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'gdel-${name}@topup-test.invalid',
         extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"GDEL ${name}"}',
         now(), now(), '', '', '', '', '', '', '', ''
   where not exists (select 1 from auth.users where email = 'gdel-${name}@topup-test.invalid');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), now(), now(), now()
    from auth.users u where u.email = 'gdel-${name}@topup-test.invalid' and not exists (select 1 from auth.identities i where i.user_id = u.id);`;

async function signIn(name) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `gdel-${name}@topup-test.invalid`, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed: ${name}`);
  return j.access_token;
}
const headers = (token) => ({ apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const rpc = async (token, fn, body) => { const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const rest = async (token, q) => (await fetch(`${URL_}/rest/v1/${q}`, { headers: headers(token) })).json();
const fulfill = async (token, orderId) => (await fetch(`${URL_}/functions/v1/fulfill-order`, { method: 'POST', headers: headers(token), body: JSON.stringify({ order_id: orderId }) })).json().catch(() => ({ outcome: 'unreachable' }));
const deliveryOf = async (token, giftId) => (await rest(token, `orders?gift_id=eq.${giftId}&select=id,status,user_id`))[0] ?? null;

let failures = 0;
const check = (name, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); };

const CLEANUP = `
  delete from public.vault_codes where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'gdel-%@topup-test.invalid');
  delete from public.gifts where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'gdel-%@topup-test.invalid');
  delete from public.redeem_codes where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'gdel-%@topup-test.invalid');
  delete from public.admin_notifications where sent_at is null and message like '%gdel-%@topup-test.invalid%';
  delete from auth.users where email like 'gdel-%@topup-test.invalid';
  select (select count(*) from auth.users where email like 'gdel-%') as users_left`;

try {
  // ---- setup: four throwaway accounts, the buyer funded through the real (test-key) deposit path
  sql(`${mkUser('buyer')} ${mkUser('friend')} ${mkUser('other')} ${mkUser('admin')}
    update public.profiles set role = 'admin' where email = 'gdel-admin@topup-test.invalid';
    do $$ declare v_buyer uuid := (select id from auth.users where email = 'gdel-buyer@topup-test.invalid'); v_dep uuid; begin
      perform set_config('request.jwt.claim.sub', v_buyer::text, true);
      v_dep := (public.create_deposit_request(2000) ->> 'deposit_id')::uuid;
      perform public.begin_deposit_verification(v_dep, v_buyer, 'telebirr', 'GDEL-' || upper(left(v_dep::text, 8)));
      perform public.finish_deposit_verification(v_dep, 'paid', 2000, 'test', 200, '{"note":"gift delivery test"}'::jsonb);
    end $$; select 1 as ok`);
  const [buyer, friend, other, admin] = [await signIn('buyer'), await signIn('friend'), await signIn('other'), await signIn('admin')];
  const [{ id: friendId }] = sql(`select id from auth.users where email = 'gdel-friend@topup-test.invalid'`);
  const buy = async (option, kind, to = null) => (await rpc(buyer, 'checkout_gift', { p_option_id: option, p_kind: kind, p_recipient: to })).json;

  // ---- 1. 8 simultaneous claims, then 8 simultaneous delivery calls: one claim, one delivery
  console.log('\n-- one gift, 8 simultaneous claims, then 8 simultaneous delivery calls');
  const g1 = await buy(CARD, 'gift', friendId);
  const claims = await Promise.all(Array.from({ length: 8 }, () => rpc(friend, 'claim_gift', { p_gift_id: g1.gift_id, p_fields: {} })));
  const won = claims.filter((c) => c.status === 200).length;
  const lost = claims.filter((c) => /gift_already_claimed/.test(c.json?.message ?? '')).length;
  check('exactly one claim wins, 7 are told "already claimed"', won === 1 && lost === 7, `won=${won} already=${lost}`);
  const d1 = await deliveryOf(friend, g1.gift_id);
  check('...and exactly one delivery order exists, the recipient\'s, waiting to be delivered', d1 && d1.status === 'pending' && d1.user_id === friendId && (await rest(friend, `orders?gift_id=eq.${g1.gift_id}&select=id`)).length === 1);
  const runs = await Promise.all(Array.from({ length: 8 }, () => fulfill(friend, d1.id)));
  const outcomes = runs.reduce((m, r) => ({ ...m, [`${r.outcome}${r.reason ? `:${r.reason}` : ''}`]: (m[`${r.outcome}${r.reason ? `:${r.reason}` : ''}`] ?? 0) + 1 }), {});
  const [afterD1] = sql(`select o.status, (select count(*) from public.vault_codes where order_id = o.id) as codes, (select count(*) from public.portal_coin_transactions where order_id = o.id) as coins from public.orders o where o.id = '${d1.id}'`);
  check('8 delivery calls at once: delivered ONCE -- one completed order, one code, one Portal Coin credit', afterD1.status === 'completed' && Number(afterD1.codes) === 1 && Number(afterD1.coins) === 1, `${JSON.stringify(outcomes)} ${JSON.stringify(afterD1)}`);
  check('a later retry changes nothing', (await fulfill(friend, d1.id)).reason === 'status_completed' && Number(sql(`select count(*) as n from public.vault_codes where order_id = '${d1.id}'`)[0].n) === 1);
  const friendCodes = await rest(friend, `vault_codes?order_id=eq.${d1.id}&select=code`);
  check("the code is in the RECIPIENT's vault (and not the buyer's)", friendCodes.length === 1 && (await rest(buyer, `vault_codes?order_id=eq.${d1.id}&select=code`)).length === 0);

  // ---- 2. a pack that needs a player ID (supplier-checked, region-locked ME)
  console.log('\n-- a pack that needs a player ID');
  const g2 = await buy(MENA, 'gift', friendId);
  const noId = await rpc(friend, 'claim_gift', { p_gift_id: g2.gift_id, p_fields: {} });
  check('claiming without the ID: refused as "player_id_required", nothing created', /player_id_required/.test(noId.json?.message ?? '') && !(await deliveryOf(friend, g2.gift_id)));
  const unchecked = await rpc(friend, 'claim_gift', { p_gift_id: g2.gift_id, p_fields: { player_id: REAL_GARENA_ID } });
  check('with the ID but before the supplier has checked it: refused as "id_not_validated"', /id_not_validated/.test(unchecked.json?.message ?? ''));
  const [{ region_id: menaRegion }] = sql(`select region_id from public.product_options where id = '${MENA}'`);
  const v = await (await fetch(`${URL_}/functions/v1/validate-id`, { method: 'POST', headers: headers(friend), body: JSON.stringify({ region_id: menaRegion, fields: { player_id: REAL_GARENA_ID } }) })).json();
  check('the real ID check (validate-id -> the supplier) accepts the real account, region ME', v?.status === 'valid' || v?.valid === true || v?.account_region === 'ME' || v?.accountRegion === 'ME', JSON.stringify({ ...v, player_name: v?.player_name ? '<name>' : undefined }).slice(0, 160));
  const withId = await rpc(friend, 'claim_gift', { p_gift_id: g2.gift_id, p_fields: { player_id: REAL_GARENA_ID } });
  const d2 = await deliveryOf(friend, g2.gift_id);
  const out2 = d2 ? await fulfill(friend, d2.id) : null;
  const [o2] = d2 ? sql(`select status, delivery ->> 'account_id' as account, validated_account_region as region from public.orders where id = '${d2.id}'`) : [{}];
  check('claimed with it: delivered once as a top-up to that account', withId.status === 200 && out2?.outcome === 'completed' && o2.status === 'completed' && o2.account === REAL_GARENA_ID && o2.region === 'ME', JSON.stringify({ out2, o2: { ...o2, account: o2.account ? '<id>' : null } }));

  // ---- 3. a redeem code: redeemed, then claimed by the redeemer
  console.log('\n-- a redeem code, redeemed and claimed');
  const c1 = await buy(CARD, 'redeem_code');
  const red = await rpc(other, 'redeem_code', { p_code: c1.code });
  const claimRed = await rpc(other, 'claim_gift', { p_gift_id: red.json?.gift_id, p_fields: {} });
  const d3 = await deliveryOf(other, red.json?.gift_id);
  const out3 = d3 ? await fulfill(other, d3.id) : null;
  check("redeemed -> a gift -> claimed -> delivered once, into the REDEEMER's vault", red.json?.ok === true && claimRed.status === 200 && out3?.outcome === 'completed' && (await rest(other, `vault_codes?order_id=eq.${d3.id}&select=code`)).length === 1);

  // ---- 4. a delivery that never went through: recovered by the normal admin path
  console.log('\n-- a claim whose delivery call never succeeds (the app closed, the supplier failed)');
  const g4 = await buy(CARD, 'gift', friendId);
  await rpc(friend, 'claim_gift', { p_gift_id: g4.gift_id, p_fields: {} });
  const d4 = await deliveryOf(friend, g4.gift_id);
  // (no fulfill-order call: the step that would have delivered it never succeeded)
  const queue = await rest(admin, `orders?select=id&gift_kind=is.null&status=in.(pending,paid)&limit=1000`);
  check('the claimed gift is not lost: its delivery order waits in the admin queue like any undelivered order', d4?.status === 'pending' && queue.some((o) => o.id === d4.id));
  const refund = await rpc(admin, 'admin_set_order_status', { p_order_id: d4.id, p_status: 'failed' });
  check("...and can't be 'failed' into a wallet refund of the gift's value", /gift_delivery_locked/.test(refund.json?.message ?? ''));
  const manual = await rpc(admin, 'admin_deliver_order', { p_order_id: d4.id, p_code: 'GDEL-MANUAL-CODE' });
  check("the admin's normal manual delivery completes it: the code lands in the recipient's vault", manual.status === 200 && (await rest(friend, `vault_codes?order_id=eq.${d4.id}&select=code`))[0]?.code === 'GDEL-MANUAL-CODE');

  // ---- 5. what both sides see
  console.log('\n-- the Orders list and the Vault, on both sides');
  const buyerOrders = await rest(buyer, `orders?select=id,status,gift_kind,gift_id,gifts!gifts_order_id_fkey(status),redeem_codes(status)&user_id=not.is.null&order=created_at.desc`);
  // the app's rule (lib/orders.ts): a redeem-code order reads its CODE's state, a gift order its gift's
  const state = (id) => { const o = buyerOrders.find((x) => x.id === id); return (o?.gift_kind === 'redeem_code' ? o?.redeem_codes?.status : o?.gifts?.status) ?? null; };
  check("the sender's Orders list reads each gift order's real state", state(g1.order_id) === 'claimed' && state(c1.order_id) === 'redeemed' && buyerOrders.filter((o) => o.gift_kind).length === 4, JSON.stringify(buyerOrders.filter((o) => o.gift_kind).map((o) => [o.gift_kind, state(o.id)])));
  const friendOrders = await rest(friend, `orders?select=id,status,gift_id&order=created_at.desc`);
  check("the recipient's Orders list has each delivery as a 'gift received' order, with its real status", friendOrders.filter((o) => o.gift_id).length === 3 && friendOrders.filter((o) => o.gift_id).every((o) => o.status === 'completed'));
  const vault = (await rpc(friend, 'my_vault_gifts', {})).json;
  check("the recipient's vault: every gift claimed and delivered, with the sender's name", vault.length === 3 && vault.every((g) => g.status === 'claimed' && g.delivery_status === 'completed' && g.sender_name === 'GDEL buyer'));
  const codes = (await rpc(buyer, 'my_redeem_codes', {})).json;
  check("the buyer's vault: their redeem code, marked redeemed", codes.length === 1 && codes[0].code === c1.code && codes[0].status === 'redeemed');
} finally {
  const [left] = sql(CLEANUP);
  check('cleanup: throwaway accounts and everything they made are gone', Number(left.users_left) === 0);
}
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
