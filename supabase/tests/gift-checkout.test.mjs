// Gifts part 2 (20261017090000): buying a gift or a redeem code. The gift / redeem_codes row is created by the SAME
// statement that makes the order 'paid' (both payment paths), the order is a gift order from birth and frozen, the
// email lookup is exact and rate-limited. True cross-session concurrency (the delivery job racing the payment) is
// proven live by scripts/gift-checkout-race-live.mjs; PGlite runs one session at a time.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATIONS = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort().map((f) => read(`migrations/${f}`));

const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };
async function as(role, uid, sql, params) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}
const rows = async (role, uid, sql, params) => (await as(role, uid, sql, params)).rows;
async function rejects(n, role, uid, sql, re, params) {
  try { await as(role, uid, sql, params); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message + ' ' + (e.detail ?? '')); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const count = async (sql, params) => Number((await one(sql, params)).n);

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const mkUser = async (email, name) => (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
const BUYER = await mkUser('buyer@x.com', 'Abel'), FRIEND = await mkUser('Friend@Gmail.com', 'Bruk'), ADM = await mkUser('admin@x.com', 'Boss');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await db.exec(`update profiles set avatar_url='https://x/a.png' where id='${FRIEND}'`);
const fund = (u, amount) => as('authenticated', ADM, `select admin_adjust_balance($1, $2, 'test funds')`, [u, amount]);

const product = async (slug, category) => (await one(`insert into products (slug, name, category, is_active) values ($1, $1, $2, true) returning id`, [slug, category])).id;
const P_CARD = await product('Roblox', 'gift-cards');
const R_CARD = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [P_CARD])).id;
const O_CARD = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'800 Robux',300,true) returning id`, [P_CARD, R_CARD])).id;
const P_TOP = await product('Free Fire', 'games');
const R_TOP = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'me','MENA','[{"key":"player_id","label":"Player ID","type":"text"}]'::jsonb,'supplier',true) returning id`, [P_TOP])).id;
const O_TOP = (await one(`insert into product_options (product_id, region_id, label, price, is_active, region_locked, account_region_codes) values ($1,$2,'100 Diamonds',180,true,true,array['ME']) returning id`, [P_TOP, R_TOP])).id;

const checkout = async (uid, option, kind, to = null) => (await rows('authenticated', uid, `select checkout_gift($1, $2, $3) r`, [option, kind, to]))[0].r;
const svc = (sql, params) => as('service_role', null, sql, params);

// ------------------------------------------------------------------ email lookup
console.log('\n-- finding a recipient by email');
const find = async (uid, email) => (await rows('authenticated', uid, `select find_recipient_by_email($1) r`, [email]))[0].r;
const hit = await find(BUYER, '  friend@gmail.COM ');
ok('an exact email (any case, spaces trimmed) finds that one account: id, name, picture', hit.ok === true && hit.id === FRIEND && hit.name === 'Bruk' && hit.avatar_url === 'https://x/a.png', JSON.stringify(hit));
ok('nothing else about the account comes back', Object.keys(hit).sort().join(',') === 'avatar_url,id,name,ok');
ok('no partial matches: "friend" alone finds nothing', (await find(BUYER, 'friend')).error === 'not_found');
ok('...nor a near miss', (await find(BUYER, 'friend@gmail.co')).error === 'not_found');
ok('an unknown email: the plain "not found"', (await find(BUYER, 'nobody@gmail.com')).error === 'not_found');
ok("the buyer's own email: blocked as 'self'", (await find(BUYER, 'BUYER@x.com')).error === 'self');
await rejects('signed out: no lookups', 'anon', null, `select find_recipient_by_email('friend@gmail.com')`, /permission denied/);
ok('the log never stores the email that was looked up', (await count(`select count(*) n from information_schema.columns where table_name = 'email_lookup_attempts' and column_name ilike '%mail%'`)) === 0);
ok('...and no customer can read it', await (async () => { try { await as('authenticated', BUYER, `select * from email_lookup_attempts`); return false; } catch (e) { return /permission denied/.test(e.message); } })());
const SPAM = await mkUser('spam@x.com', 'S');
for (let i = 0; i < 20; i++) await find(SPAM, `guess${i}@gmail.com`);
ok('20 lookups in 10 minutes, then "too many attempts" -- hits count too (a hit is what an enumeration wants)', (await find(SPAM, 'friend@gmail.com')).error === 'too_many_attempts');
await db.exec(`update email_lookup_attempts set created_at = now() - interval '11 minutes' where user_id = '${SPAM}'`);
ok('once the window has passed: allowed again', (await find(SPAM, 'friend@gmail.com')).ok === true);
const ipUsers = [await mkUser('i1@x.com', 'a'), await mkUser('i2@x.com', 'b'), await mkUser('i3@x.com', 'c'), await mkUser('i4@x.com', 'd')];
await db.exec(`select set_config('request.headers', '{"cf-connecting-ip": "198.51.100.7"}', false)`);
for (const u of ipUsers.slice(0, 3)) for (let i = 0; i < 20; i++) await find(u, `x${i}@gmail.com`);
ok('60 from one IP across accounts: the next account on that IP is refused', (await find(ipUsers[3], 'friend@gmail.com')).error === 'too_many_attempts');
await db.exec(`select set_config('request.headers', '', false)`);

// ------------------------------------------------------------------ refusals before any payment
console.log('\n-- refused before anything is created');
const orders = () => count(`select count(*) n from orders where user_id = '${BUYER}'`);
await rejects('gifting yourself', 'authenticated', BUYER, `select checkout_gift($1, 'gift', $2)`, /cannot_gift_self/, [O_CARD, BUYER]);
await rejects('an account that does not exist', 'authenticated', BUYER, `select checkout_gift($1, 'gift', gen_random_uuid())`, /recipient_not_found/, [O_CARD]);
await rejects('a gift with no recipient', 'authenticated', BUYER, `select checkout_gift($1, 'gift', null)`, /recipient_not_found/, [O_CARD]);
await rejects('a redeem code WITH a recipient', 'authenticated', BUYER, `select checkout_gift($1, 'redeem_code', $2)`, /invalid_gift_kind/, [O_CARD, FRIEND]);
await rejects('an unknown kind', 'authenticated', BUYER, `select checkout_gift($1, 'present', null)`, /invalid_gift_kind/, [O_CARD]);
const offPack = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'Off',50,false) returning id`, [P_CARD, R_CARD])).id;
await rejects('a pack that is off', 'authenticated', BUYER, `select checkout_gift($1, 'redeem_code', null)`, /pack_unavailable/, [offPack]);
ok('...none of which created an order', (await orders()) === 0);

// ------------------------------------------------------------------ wallet: paid at once
console.log('\n-- paying from the wallet: order + payment + gift in one step');
await fund(BUYER, 1000);
const g = await checkout(BUYER, O_CARD, 'gift', FRIEND);
ok('paid at once, the new gift named in the reply', g.paid === true && g.kind === 'gift' && !!g.gift_id && Number(g.amount) === 300 && Number(g.balance) === 700, JSON.stringify(g));
const go = await one(`select * from orders where id = $1`, [g.order_id]);
ok('the order: paid, a gift order from birth, for the recipient, the pack itself (no order lines, no player ID)', go.status === 'paid' && go.gift_kind === 'gift' && go.gift_recipient_id === FRIEND && go.option_id === O_CARD && JSON.stringify(go.delivery) === '{}' && (await count(`select count(*) n from order_items where order_id = '${g.order_id}'`)) === 0);
const gift = await one(`select * from gifts where id = $1`, [g.gift_id]);
ok('the gift: pending, sender = buyer, recipient = friend, the chosen pack, same order', gift.status === 'pending' && gift.sender_id === BUYER && gift.recipient_user_id === FRIEND && gift.option_id === O_CARD && gift.product_id === P_CARD && gift.order_id === g.order_id);
ok('the wallet was charged once, as a purchase of that order', (await count(`select count(*) n from wallet_transactions where order_id = '${g.order_id}' and kind = 'purchase' and amount = -300`)) === 1);

const c = await checkout(BUYER, O_TOP, 'redeem_code');
ok('a redeem code: paid at once, the code in the reply (the one time it is handed over)', c.paid === true && /^[A-Z0-9]{10}$/.test(c.code), JSON.stringify({ ...c, code: c.code ? 'XXXXXXXXXX' : null }));
const code = await one(`select * from redeem_codes where order_id = $1`, [c.order_id]);
ok('the code row: active, created_by = buyer, the chosen pack (a region-locked top-up: the player ID waits for claim time)', code.status === 'active' && code.created_by === BUYER && code.option_id === O_TOP && code.code === c.code);
ok('the buyer can read it back later (their vault, part 3)', (await rows('authenticated', BUYER, `select code from redeem_codes where order_id = $1`, [c.order_id]))[0]?.code === c.code);

// ------------------------------------------------------------------ bank transfer: paid later
console.log('\n-- paying by bank transfer: the gift appears in the SAME statement that marks the order paid');
const POOR = await mkUser('poor@x.com', 'P');
const b = await checkout(POOR, O_CARD, 'gift', FRIEND);
ok('not enough in the wallet: the order waits, unpaid, and no gift exists yet', b.paid === false && !b.gift_id && (await count(`select count(*) n from gifts where order_id = '${b.order_id}'`)) === 0 && (await one(`select status from orders where id = $1`, [b.order_id])).status === 'pending_payment');
await rejects('one unpaid order per customer, as in the cart (the unpaid order is named)', 'authenticated', POOR, `select checkout_gift($1, 'redeem_code', null)`, new RegExp(`pending_order_exists.*${b.order_id}`), [O_CARD]);
await svc(`select begin_payment_verification($1, $2, 'telebirr', 'FT25GIFTBANK001')`, [b.order_id, POOR]);
// The whole finish -- the flip to 'paid' and whatever the trigger does -- inside one transaction that we inspect
// BEFORE it commits: the gift is already there at the first moment the order is paid.
const inTx = await db.transaction(async (tx) => {
  await tx.query(`set local role service_role`);
  await tx.query(`select finish_payment_verification($1, 'paid', 300, 'test', 200, '{}'::jsonb)`, [b.order_id]);
  return (await tx.query(`select o.status, (select count(*)::int from gifts where order_id = o.id) as gifts from orders o where o.id = $1`, [b.order_id])).rows[0];
});
ok('inside the payment transaction, before commit: paid AND the gift already exists', inTx.status === 'paid' && inTx.gifts === 1, JSON.stringify(inTx));
ok('...and after commit: one gift, for the friend', (await one(`select recipient_user_id from gifts where order_id = $1`, [b.order_id])).recipient_user_id === FRIEND);
ok('a failed/rolled-back payment leaves no gift behind (it was never a separate step)', await (async () => {
  const x = await checkout(await mkUser('rb@x.com', 'R'), O_CARD, 'redeem_code');
  try { await db.transaction(async (tx) => { await tx.query(`update orders set status = 'paid', paid_at = now(), payment_verified_amount = 300 where id = $1`, [x.order_id]); throw new Error('rollback'); }); } catch { /* expected */ }
  return (await count(`select count(*) n from redeem_codes where order_id = '${x.order_id}'`)) === 0 && (await one(`select status from orders where id = $1`, [x.order_id])).status === 'pending_payment';
})());

// the /pay screen's "pay from wallet" on an unpaid gift order: same trigger
const LATER = await mkUser('later@x.com', 'L');
const l = await checkout(LATER, O_CARD, 'redeem_code');
await fund(LATER, 500);
await as('authenticated', LATER, `select pay_order_with_wallet($1)`, [l.order_id]);
ok('paying an unpaid gift order from the wallet later creates the code the same way', (await count(`select count(*) n from redeem_codes where order_id = '${l.order_id}'`)) === 1);

// ------------------------------------------------------------------ the order stays out of every delivery path
console.log('\n-- a gift order is never delivered, failed or refunded by the normal paths');
await rejects('admin_deliver_order on a paid gift order', 'authenticated', ADM, `select admin_deliver_order($1, 'X')`, /gift_order_locked/, [g.order_id]);
await rejects('admin_set_order_status processing', 'authenticated', ADM, `select admin_set_order_status($1, 'processing')`, /gift_order_locked/, [g.order_id]);
await rejects('admin_set_order_status failed (a refund)', 'authenticated', ADM, `select admin_set_order_status($1, 'failed')`, /gift_order_locked/, [g.order_id]);
const u2 = await checkout(await mkUser('u2@x.com', 'U'), O_CARD, 'gift', FRIEND);
await rejects('...even BEFORE it is paid (it is a gift order from birth): a raw write to processing', 'postgres', null, `update orders set status = 'processing' where id = $1`, /gift_order_locked/, [u2.order_id]);
await rejects('...or straight to completed', 'postgres', null, `update orders set status = 'completed', completed_at = now() where id = $1`, /gift_order_locked/, [u2.order_id]);
await rejects('the gift marker can never be removed or changed', 'postgres', null, `update orders set gift_kind = null where id = $1`, /gift_order_immutable/, [u2.order_id]);
await rejects('...nor the recipient swapped', 'postgres', null, `update orders set gift_recipient_id = $2 where id = $1`, /gift_order_immutable/, [u2.order_id, ADM]);
ok('no vault code was written for any gift order', (await count(`select count(*) n from vault_codes v join orders o on o.id = v.order_id where o.gift_kind is not null`)) === 0);
ok('an ordinary order is unaffected (processing still allowed)', await (async () => {
  const n = (await one(`insert into orders (user_id, option_id, product_name, option_label, amount, status, fulfillment) values ($1,$2,'x','y',1,'pending','code') returning id`, [BUYER, O_CARD])).id;
  await as('authenticated', ADM, `select admin_set_order_status($1, 'processing')`, [n]);
  return (await one(`select status from orders where id = $1`, [n])).status === 'processing';
})());

console.log('\n-- cancelling an unpaid gift order');
const CAN = await mkUser('can@x.com', 'C');
const cn = await checkout(CAN, O_CARD, 'gift', FRIEND);
await as('authenticated', CAN, `select cancel_pending_order($1)`, [cn.order_id]);
ok('cancelled, nothing created, and the pack does NOT land in the cart as an ordinary purchase', (await one(`select status from orders where id = $1`, [cn.order_id])).status === 'cancelled' && (await count(`select count(*) n from gifts where order_id = '${cn.order_id}'`)) === 0 && (await count(`select count(*) n from cart_items where user_id = '${CAN}'`)) === 0);
ok('...and the next gift checkout is allowed', (await checkout(CAN, O_CARD, 'redeem_code')).paid === false);

console.log('\n-- the payment never fails because of the gift');
const EDGE = await mkUser('edge@x.com', 'E'), GONE = await mkUser('gone@x.com', 'G');
const e1 = await checkout(EDGE, O_CARD, 'gift', GONE);
await db.query(`delete from auth.users where id = $1`, [GONE]);
ok("the recipient's account deleted before the transfer landed: the link empties, the order stays a gift order", (await one(`select gift_kind, gift_recipient_id from orders where id = $1`, [e1.order_id])).gift_recipient_id === null);
await svc(`select begin_payment_verification($1, $2, 'telebirr', 'FT25GIFTGONE001')`, [e1.order_id, EDGE]);
await svc(`select finish_payment_verification($1, 'paid', 300, 'test', 200, '{}'::jsonb)`, [e1.order_id]);
ok('...the payment still goes through, and the buyer gets a redeem code instead (money never lost)', (await one(`select status from orders where id = $1`, [e1.order_id])).status === 'paid' && (await one(`select created_by from redeem_codes where order_id = $1`, [e1.order_id]))?.created_by === EDGE);
const EDGE2 = await mkUser('edge2@x.com', 'E2');
const e2 = await checkout(EDGE2, O_CARD, 'redeem_code');
await db.query(`update product_options set is_active = false where id = $1`, [O_CARD]);
await svc(`select begin_payment_verification($1, $2, 'telebirr', 'FT25GIFTOFF0001')`, [e2.order_id, EDGE2]);
await svc(`select finish_payment_verification($1, 'paid', 300, 'test', 200, '{}'::jsonb)`, [e2.order_id]);
ok('a pack switched off between order and transfer: still paid, still a code (claim checks availability later)', (await count(`select count(*) n from redeem_codes where order_id = '${e2.order_id}'`)) === 1);
await db.query(`update product_options set is_active = true where id = $1`, [O_CARD]);

console.log('\n-- the done screen');
const sum = (await rows('authenticated', BUYER, `select gift_order_summary($1) s`, [c.order_id]))[0].s;
ok('the buyer gets the code and the pack for their redeem-code order', sum.kind === 'redeem_code' && sum.code === c.code && sum.option_label === '100 Diamonds');
const gs = (await rows('authenticated', BUYER, `select gift_order_summary($1) s`, [g.order_id]))[0].s;
ok("...and who a gift went to (name + picture), nothing more", gs.kind === 'gift' && gs.recipient_name === 'Bruk' && gs.recipient_avatar === 'https://x/a.png' && gs.code === null);
ok('nobody else gets anything for that order', (await rows('authenticated', FRIEND, `select gift_order_summary($1) s`, [c.order_id]))[0].s === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
