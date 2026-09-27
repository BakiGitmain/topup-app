// Gifts part 3 (20261018090000): claiming creates the recipient's delivery order in the same transaction, it goes
// through the ordinary delivery funnel exactly once, it can never be failed/refunded into money, a recipient with a
// pending gift can't be deleted, and what the vault reads. The supplier call itself (attemptFulfillment) is TypeScript,
// tested in _shared/fulfillment.test.mjs; here system_fulfill_order stands in for its success step, exactly as it is
// called in production. True concurrency: scripts/gift-delivery-live.mjs.
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
const BUYER = await mkUser('buyer@x.com', 'Abel'), FRIEND = await mkUser('friend@x.com', 'Bruk'), OTHER = await mkUser('other@x.com', 'Chala'), ADM = await mkUser('admin@x.com', 'Boss');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await db.exec(`update profiles set avatar_url='https://x/abel.png' where id='${BUYER}'`);
await as('authenticated', ADM, `select admin_adjust_balance($1, 5000, 'funds')`, [BUYER]);

const product = async (slug, category) => (await one(`insert into products (slug, name, category, is_active, image_url) values ($1, $1, $2, true, 'https://x/' || $1 || '.png') returning id`, [slug, category])).id;
const P_CARD = await product('Roblox', 'gift-cards');
const R_CARD = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [P_CARD])).id;
const O_CARD = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'800 Robux',300,true) returning id`, [P_CARD, R_CARD])).id;
const P_TOP = await product('Free Fire', 'games');
const R_TOP = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'me','MENA','[{"key":"player_id","label":"Player ID","type":"text"}]'::jsonb,'supplier',true) returning id`, [P_TOP])).id;
const O_TOP = (await one(`insert into product_options (product_id, region_id, label, price, is_active, region_locked, account_region_codes) values ($1,$2,'100 Diamonds',180,true,true,array['ME']) returning id`, [P_TOP, R_TOP])).id;

const buy = async (option, kind, to = null) => (await rows('authenticated', BUYER, `select checkout_gift($1, $2, $3) r`, [option, kind, to]))[0].r;
const claim = (uid, id, fields = {}) => rows('authenticated', uid, `select * from claim_gift($1, $2::jsonb)`, [id, JSON.stringify(fields)]);
const deliveries = (giftId) => db.query(`select * from orders where gift_id = $1`, [giftId]).then((r) => r.rows);

// ------------------------------------------------------------------ claim -> one delivery order, same transaction
console.log('\n-- claiming creates the recipient\'s delivery order, in the same transaction');
const g1 = await buy(O_CARD, 'gift', FRIEND);
ok('before the claim: no delivery order', (await deliveries(g1.gift_id)).length === 0);
await claim(FRIEND, g1.gift_id);
const [d1] = await deliveries(g1.gift_id);
// Br 0 since 20261021090000: the recipient's delivery order is not a sale and never shows what their friend paid.
ok('after: exactly one, for the RECIPIENT, that pack, no price (Br 0), waiting for delivery like any order', d1 && d1.user_id === FRIEND && d1.option_id === O_CARD && Number(d1.amount) === 0 && d1.status === 'pending' && d1.fulfillment === 'code' && !d1.gift_kind, JSON.stringify(d1));
ok("it is NOT the buyer's order, which stays frozen 'paid'", d1.id !== g1.order_id && (await one(`select status from orders where id = $1`, [g1.order_id])).status === 'paid');
await rejects('a claim that is refused creates nothing (it all rolls back together)', 'authenticated', FRIEND, `select claim_gift($1)`, /gift_already_claimed/, [g1.gift_id]);
ok('...still exactly one', (await deliveries(g1.gift_id)).length === 1);
await rejects('a second delivery order for the same gift is impossible (unique gift_id)', 'postgres', null, `insert into orders (user_id, option_id, product_name, option_label, amount, status, fulfillment, gift_id) values ($1,$2,'x','y',1,'pending','code',$3)`, /duplicate key|unique/, [FRIEND, O_CARD, g1.gift_id]);
ok('the admin queue sees it (pending, no gift_kind): the normal safety net if delivery does not go through', (await count(`select count(*) n from orders where id = '${d1.id}' and status in ('pending','paid') and gift_kind is null`)) === 1);

console.log('\n-- delivered exactly once, through the normal steps');
await as('service_role', null, `select system_fulfill_order($1, 'ROBLOX-CODE-1')`, [d1.id]);
ok('the supplier step (system_fulfill_order) completes it: the code lands in the RECIPIENT\'s vault', (await one(`select status from orders where id = $1`, [d1.id])).status === 'completed' && (await one(`select user_id, code from vault_codes where order_id = $1`, [d1.id]))?.user_id === FRIEND);
await rejects('a second success for the same order is refused (a retried or double delivery)', 'service_role', null, `select system_fulfill_order($1, 'ROBLOX-CODE-2')`, /invalid_transition/, [d1.id]);
ok('...one code, the first one', (await count(`select count(*) n from vault_codes where order_id = '${d1.id}'`)) === 1 && (await one(`select code from vault_codes where order_id = $1`, [d1.id])).code === 'ROBLOX-CODE-1');
ok('the recipient reads their delivered code like any other vault code', (await rows('authenticated', FRIEND, `select code from vault_codes`)).some((r) => r.code === 'ROBLOX-CODE-1'));

console.log('\n-- it is never a money path');
const g2 = await buy(O_CARD, 'gift', FRIEND);
await claim(FRIEND, g2.gift_id);
const [d2] = await deliveries(g2.gift_id);
const walletBefore = Number((await one(`select balance from wallets where user_id = $1`, [FRIEND])).balance);
await rejects("admin 'failed' (which refunds an order's amount) is refused", 'authenticated', ADM, `select admin_set_order_status($1, 'failed')`, /gift_delivery_locked/, [d2.id]);
ok("...so the gift's value never lands in the recipient's wallet", Number((await one(`select balance from wallets where user_id = $1`, [FRIEND])).balance) === walletBefore);
await as('authenticated', ADM, `select admin_set_order_status($1, 'processing')`, [d2.id]);
ok("the admin's normal 'start processing' works", (await one(`select status from orders where id = $1`, [d2.id])).status === 'processing');
await as('authenticated', ADM, `select admin_deliver_order($1, 'MANUAL-CODE')`, [d2.id]);
ok('...and the manual delivery (the recovery path when the supplier call fails) completes it', (await one(`select status from orders where id = $1`, [d2.id])).status === 'completed' && (await one(`select code from vault_codes where order_id = $1`, [d2.id])).code === 'MANUAL-CODE');
await rejects('a delivered gift cannot be refunded', 'authenticated', ADM, `select admin_set_order_status($1, 'refunded')`, /gift_delivery_locked|code_already_delivered/, [d2.id]);
await rejects('its gift link cannot be changed', 'postgres', null, `update orders set gift_id = null where id = $1`, /gift_delivery_locked/, [d2.id]);
await rejects('nor can an ordinary order be turned into a delivery', 'postgres', null, `update orders set gift_id = $2 where id = $1`, /gift_delivery_locked/, [g1.order_id, g2.gift_id]);

console.log('\n-- a top-up gift: the ID it was claimed with is what gets delivered');
const g3 = await buy(O_TOP, 'gift', FRIEND);
await db.query(`insert into id_validations (user_id, region_id, fields, account_region, player_name, expires_at) values ($1,$2,'{"player_id":"12345"}','ME','BRUK99',now() + interval '10 minutes')`, [FRIEND, R_TOP]);
await rejects('without the ID: refused, nothing created', 'authenticated', FRIEND, `select claim_gift($1)`, /player_id_required/, [g3.gift_id]);
ok('...no delivery order', (await deliveries(g3.gift_id)).length === 0);
await claim(FRIEND, g3.gift_id, { player_id: '12345' });
const [d3] = await deliveries(g3.gift_id);
ok('with it: a top-up order carrying the ID (fields + account_id) and the check it passed', d3.fulfillment === 'topup' && d3.delivery.fields.player_id === '12345' && d3.delivery.account_id === '12345' && d3.validated_player_name === 'BRUK99' && d3.validated_account_region === 'ME');

console.log('\n-- a redeemed code: the redeemer claims, the redeemer gets it');
const c = await buy(O_CARD, 'redeem_code');
const red = (await rows('authenticated', OTHER, `select redeem_code($1) r`, [c.code]))[0].r;
await claim(OTHER, red.gift_id);
const [d4] = await deliveries(red.gift_id);
ok('the delivery order is the REDEEMER\'s', d4?.user_id === OTHER && d4.status === 'pending');

// ------------------------------------------------------------------ recipient deletion
console.log('\n-- a recipient with a pending gift cannot be deleted (it would silently lose a paid gift)');
const TEMP = await mkUser('temp@x.com', 'T');
const g5 = await buy(O_CARD, 'gift', TEMP);
await rejects('deleting that account is refused', 'postgres', null, `delete from auth.users where id = $1`, /recipient_has_pending_gifts/, [TEMP]);
ok('...the gift is still there', (await count(`select count(*) n from gifts where id = '${g5.gift_id}'`)) === 1);
await claim(TEMP, g5.gift_id);
await db.query(`delete from auth.users where id = $1`, [TEMP]);
ok('once claimed there is nothing left to lose: deletion goes through', (await count(`select count(*) n from profiles where id = '${TEMP}'`)) === 0);

// ------------------------------------------------------------------ what the vault reads
console.log('\n-- the vault');
const g6 = await buy(O_TOP, 'gift', FRIEND);
const vg = (await rows('authenticated', FRIEND, `select my_vault_gifts() v`))[0].v;
const pending = vg.find((x) => x.id === g6.gift_id);
ok('received gifts, the claimable one first', vg[0].id === g6.gift_id && vg.length === 4 && vg[0].status === 'pending', JSON.stringify(vg.map((x) => x.status)));
ok('the claim card has: product art, pack, sender name + picture, the ID the pack needs, the region lock', pending.product_name === 'Free Fire' && pending.image_url === 'https://x/Free Fire.png' && pending.option_label === '100 Diamonds' && pending.sender_name === 'Abel' && pending.sender_avatar === 'https://x/abel.png' && pending.buyer_fields[0].key === 'player_id' && pending.id_validation === 'supplier' && pending.region_locked === true && pending.account_region_codes[0] === 'ME');
ok('a claimed one shows its delivery order and where it stands', vg.some((x) => x.id === g1.gift_id && x.status === 'claimed' && x.delivery_order_id === d1.id && x.delivery_status === 'completed'));
ok('nobody else sees them', (await rows('authenticated', OTHER, `select my_vault_gifts() v`))[0].v.every((x) => x.sender_name !== 'Abel' || x.from_code === true));
const paidNoGift = (await one(`insert into orders (user_id, option_id, product_name, option_label, amount, status, fulfillment, payment_provider, payment_mode, paid_at, payment_verified_amount) values ($1,$2,'Roblox','800 Robux',300,'paid','code','wallet','wallet',now(),300) returning id`, [BUYER, O_CARD])).id;
const exp = (await one(`insert into gifts (order_id, product_id, option_id, sender_id, recipient_user_id, expires_at, created_at) values ($1,$2,$3,$4,$5, now() - interval '1 second', now() - interval '90 days') returning id`, [paidNoGift, P_CARD, O_CARD, BUYER, FRIEND])).id;
ok('a gift past its time reads as expired even before the sweep, and is not claimable', (await rows('authenticated', FRIEND, `select my_vault_gifts() v`))[0].v.find((x) => x.id === exp)?.status === 'expired');
await rejects('...claiming it says expired', 'authenticated', FRIEND, `select claim_gift($1)`, /gift_expired/, [exp]);
const codes = (await rows('authenticated', BUYER, `select my_redeem_codes() v`))[0].v;
ok("the buyer's own codes, with status (the redeemed one says so), for the second place to copy it", codes.length === 1 && codes[0].code === c.code && codes[0].status === 'redeemed' && codes[0].option_label === '800 Robux');
ok('nobody else sees them', (await rows('authenticated', FRIEND, `select my_redeem_codes() v`))[0].v.length === 0);
ok("the sender's side: the gift's status is readable on their own order (the Orders list label)", (await rows('authenticated', BUYER, `select g.status from gifts g where g.order_id = $1`, [g1.order_id]))[0].status === 'claimed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
