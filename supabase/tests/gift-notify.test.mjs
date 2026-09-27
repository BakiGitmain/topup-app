// Gifts (20261021090000): who is told what, and when (gift_received, gift_claimed, code_redeemed, gift_delivered);
// and receipts are the buyer's -- the recipient's delivery order carries no price.
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

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const mkUser = async (email, name) => (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
const BUYER = await mkUser('abel.private@x.com', 'Abel'), FRIEND = await mkUser('friend@x.com', 'Bruk'), STRANGER = await mkUser('stranger.private@x.com', 'Chala'), ADM = await mkUser('admin@x.com', 'Boss');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await as('authenticated', ADM, `select admin_adjust_balance($1, 1000, 'funds')`, [BUYER]);
const P = (await one(`insert into products (slug, name, category, is_active) values ('roblox','Roblox','gift-cards',true) returning id`)).id;
const R = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [P])).id;
const O = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'800 Robux',300,true) returning id`, [P, R])).id;

const buy = (kind, to) => rows('authenticated', BUYER, `select checkout_gift($1, $2, $3) r`, [O, kind, to]).then((r) => r[0].r);
const inbox = (uid) => rows('authenticated', uid, `select type, title, body, data from notifications where user_id = auth.uid() order by created_at`);
const ofType = async (uid, type) => (await inbox(uid)).filter((n) => n.type === type);

console.log('\n-- a gift waiting for a bank transfer says nothing yet; payment is what tells the recipient');
await as('authenticated', ADM, `select admin_adjust_balance($1, -900, 'spend it down')`, [BUYER]);
const unpaid = await buy('gift', FRIEND);
ok('not paid (the wallet was short)', unpaid.paid === false);
ok('...and the friend has no notification yet', (await ofType(FRIEND, 'gift_received')).length === 0);
await as('authenticated', ADM, `select admin_adjust_balance($1, 900, 'top up')`, [BUYER]);
await rows('authenticated', BUYER, `select pay_order_with_wallet($1)`, [unpaid.order_id]);
const received = await ofType(FRIEND, 'gift_received');
ok('paid: the friend is told, once, who sent what', received.length === 1 && received[0].data.sender_name === 'Abel' && received[0].data.product_name === 'Roblox' && received[0].data.pack_label === '800 Robux', JSON.stringify(received));
ok('...pointing at the gift (the Vault opens on it)', typeof received[0].data.gift_id === 'string');
ok('...and never the sender\'s email', !JSON.stringify(received).includes('abel.private'));
ok('the buyer is not told about their own purchase', (await ofType(BUYER, 'gift_received')).length === 0);

console.log('\n-- claiming tells the buyer');
const giftId = received[0].data.gift_id;
await rows('authenticated', FRIEND, `select * from claim_gift($1, '{}'::jsonb)`, [giftId]);
const claimed = await ofType(BUYER, 'gift_claimed');
ok('the buyer hears their friend claimed it, with the order to open (their receipt)', claimed.length === 1 && claimed[0].data.recipient_name === 'Bruk' && claimed[0].data.order_id === unpaid.order_id, JSON.stringify(claimed));

console.log('\n-- the recipient gets no receipt: their delivery order carries no price');
const delivery = (await rows('authenticated', FRIEND, `select id, amount, created_at from orders where gift_id = $1`, [giftId]))[0];
ok('the delivery order the recipient can read says Br 0, not what their friend paid', Number(delivery.amount) === 0);
ok("the buyer's own order still carries the price (their receipt)", Number((await one(`select amount from orders where id = $1`, [unpaid.order_id])).amount) === 300);
await rejects('a Br 0 order is only possible for a gift delivery', 'postgres', null, `insert into orders (user_id, option_id, product_name, option_label, amount, status) values ('${BUYER}', '${O}', 'x', 'y', 0, 'pending')`, /orders_amount_check/);

console.log('\n-- delivery: instant = no notification (they watched it), late = "your gift has arrived"');
await as('authenticated', ADM, `select admin_deliver_order($1, 'CODE-1')`, [delivery.id]);
ok('delivered right after the claim: nothing extra', (await ofType(FRIEND, 'gift_delivered')).length === 0);
const g2 = await buy('gift', FRIEND);
await rows('authenticated', FRIEND, `select * from claim_gift($1, '{}'::jsonb)`, [g2.gift_id]);
const d2 = await one(`select id from orders where gift_id = $1`, [g2.gift_id]);
await db.exec(`update orders set created_at = now() - interval '3 hours' where id = '${d2.id}'`);
await as('authenticated', ADM, `select admin_deliver_order($1, 'CODE-2')`, [d2.id]);
const arrived = await ofType(FRIEND, 'gift_delivered');
ok('delivered hours later (queued, by hand): the recipient is told it has arrived', arrived.length === 1 && arrived[0].data.order_id === d2.id && arrived[0].data.fulfillment === 'code', JSON.stringify(arrived));

console.log('\n-- a redeem code: the buyer hears it was used, never by whom');
const c = await buy('redeem_code', null);
ok('buying a code tells nobody', (await ofType(BUYER, 'code_redeemed')).length === 0 && (await ofType(STRANGER, 'gift_received')).length === 0);
const r = (await rows('authenticated', STRANGER, `select redeem_code($1) r`, [c.code]))[0].r;
const used = await ofType(BUYER, 'code_redeemed');
ok('redeemed: the buyer is told, with their order (receipt) to open', used.length === 1 && used[0].data.order_id === c.order_id);
ok('...and nothing about the redeemer: no name, no email, no id', !/Chala|stranger|private/i.test(JSON.stringify(used)) && !JSON.stringify(used).includes(STRANGER));
ok('the redeemer gets no "you received a gift" (they just did it themselves)', (await ofType(STRANGER, 'gift_received')).length === 0);
const claimedBefore = (await ofType(BUYER, 'gift_claimed')).length;
await rows('authenticated', STRANGER, `select * from claim_gift($1, '{}'::jsonb)`, [r.gift_id]);
ok('claiming a code\'s gift sends the buyer no "gift claimed" (they already heard "redeemed")', (await ofType(BUYER, 'gift_claimed')).length === claimedBefore);

console.log('\n-- each notification reaches only its own person');
ok('the stranger sees none of the friend\'s or buyer\'s', (await inbox(STRANGER)).every((n) => !['gift_received', 'gift_claimed', 'code_redeemed', 'gift_delivered'].includes(n.type)));
ok('the friend sees none of the buyer\'s', (await inbox(FRIEND)).every((n) => !['gift_claimed', 'code_redeemed'].includes(n.type)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
