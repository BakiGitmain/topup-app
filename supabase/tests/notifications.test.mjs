// In-app notifications (20261013090000): broadcast vs targeted visibility, read state, 3-day expiry with
// query-time cleanup, the product-sale trigger (the discount-code one was removed), and that nobody can write the
// tables directly. The four targeted money types are tested where their real functions are already driven:
// this file (refund), wallet-requests.test.mjs (deposit, withdrawal), discount-codes.test.mjs (commission).
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
const A = await mkUser('a@x.com', 'Abel'), B = await mkUser('b@x.com', 'Bruk'), ADM = await mkUser('admin@x.com', 'Boss'), CR = await mkUser('cr@x.com', 'Chaltu');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await as('authenticated', ADM, `select admin_set_content_creator($1, true)`, [CR]);

const mine = (uid) => rows('authenticated', uid, `select * from my_notifications()`);
const unread = async (uid) => (await mine(uid)).filter((r) => !r.seen).length;
const count = async (sql, params) => Number((await one(sql, params)).n);

// ------------------------------------------------------------------ discount codes no longer announce
console.log('\n-- creating or re-activating a discount code announces nothing (trigger removed)');
await as('authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent, created_by) values ('SAVE15', $1, 15, 5, $2)`, [CR, ADM]);
const codeId = (await one(`select id from discount_codes where code = 'SAVE15'`)).id;
await as('authenticated', ADM, `update discount_codes set active = false where id = $1`, [codeId]);
await as('authenticated', ADM, `update discount_codes set active = true where id = $1`, [codeId]);
ok('no notification from creating, pausing or re-activating a code', (await count(`select count(*) n from notifications`)) === 0);
ok('the old trigger and its function are gone', (await count(`select count(*) n from pg_trigger where tgname = 'discount_codes_notify'`)) === 0 && (await count(`select count(*) n from pg_proc where proname = 'notify_discount_code_active'`)) === 0);

// ------------------------------------------------------------------ a pack going on sale
console.log('\n-- a pack going ON SALE is announced to every customer, once per sale');
const sales = async () => (await db.query(`select * from notifications where type = 'product_discount' order by created_at, id`)).rows;
const P = (await one(`insert into products (slug, name, category, is_active) values ('pubg','PUBG Mobile','games',true) returning id`)).id;
const PR = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [P])).id;
const O = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'60 UC',100,true) returning id`, [P, PR])).id;
ok('an active pack at full price: nothing', (await sales()).length === 0);
await db.query(`update product_options set old_price = 120 where id = $1`, [O]);
let s1 = await sales();
ok('old price 120 over price 100: announced once, as a broadcast', s1.length === 1 && s1[0].user_id === null);
ok('names the product and pack and the percent the shop badge shows (17%)', s1[0].body === 'PUBG Mobile 60 UC now 17% off' && s1[0].data.discount_percent === 17 && s1[0].data.option_id === O, s1[0].body);
await db.query(`update product_options set price = 90 where id = $1`, [O]);
await db.query(`update product_options set old_price = 150 where id = $1`, [O]);
ok('changing the price again while still on sale: not announced again', (await sales()).length === 1);
await db.query(`update product_options set old_price = null where id = $1`, [O]);
ok('ending the sale: nothing', (await sales()).length === 1);
await db.query(`update product_options set old_price = 110 where id = $1`, [O]);
ok('putting it back on sale later is a fresh start: announced again', (await sales()).length === 2);
await db.query(`update product_options set is_active = false where id = $1`, [O]);
await db.query(`update product_options set is_active = true where id = $1`, [O]);
ok('a hidden pack is not "on sale"; showing it again while it has a markdown is a fresh start', (await sales()).length === 3);
await db.query(`update product_options set label = '60 UC (fast)' where id = $1`, [O]);
ok('editing anything else (the label) never announces', (await sales()).length === 3);

const O2 = (await one(`insert into product_options (product_id, region_id, label, price, old_price, is_active) values ($1,$2,'325 UC',500,600,false) returning id`, [P, PR])).id;
ok('a new pack created hidden with a markdown: nothing yet', (await sales()).length === 3);
await db.query(`update product_options set is_active = true where id = $1`, [O2]);
ok('...announced when it is switched on', (await sales()).length === 4);
await db.query(`insert into product_options (product_id, region_id, label, price, old_price, is_active) values ($1,$2,'660 UC',995,1000,true)`, [P, PR]);
ok('a markdown under 1% (995 vs 1000 rounds to 1%)... counts, same as the shop badge', (await sales()).length === 5);
await db.query(`insert into product_options (product_id, region_id, label, price, old_price, is_active) values ($1,$2,'1800 UC',9960,10000,true)`, [P, PR]);
ok('a markdown that rounds to 0% (9960 vs 10000) is not a sale, same as the shop badge', (await sales()).length === 5);
const PH = (await one(`insert into products (slug, name, category, is_active) values ('hidden','Hidden Game','games',false) returning id`)).id;
const PHR = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [PH])).id;
await db.query(`insert into product_options (product_id, region_id, label, price, old_price, is_active) values ($1,$2,'Pack',50,100,true)`, [PH, PHR]);
ok('a pack of a hidden product is never announced', (await sales()).length === 5);
ok('pack_sale_percent matches the shop badge: 99 cap, null below 1%', (await one(`select pack_sale_percent(1, 1000) a, pack_sale_percent(9960, 10000) b, pack_sale_percent(100, 100) c, pack_sale_percent(100, null) d`)).a === 99);
await db.exec(`delete from notifications`);

// ------------------------------------------------------------------ order refunds (real admin_set_order_status)
console.log('\n-- an order refund tells that customer only');
const refunds = async () => (await db.query(`select user_id, data, body from notifications where type = 'refund_credited' order by created_at, id`)).rows;
const mkOrd = async (status, amount) => (await one(`insert into orders (user_id, product_name, option_label, amount, status, fulfillment) values ($1,'PUBG Mobile','60 UC',$2,$3,'topup') returning id`, [A, amount, status])).id;
const oDone = await mkOrd('completed', 55);
await as('authenticated', ADM, `select admin_set_order_status($1, 'refunded')`, [oDone]);
let rf = await refunds();
ok('refunding a completed order: ONE targeted "refund credited" to that customer, with the amount', rf.length === 1 && rf[0].user_id === A && Number(rf[0].data.amount) === 55 && rf[0].data.order_id === oDone && rf[0].body === 'Br 55 refunded to your wallet', JSON.stringify(rf));
ok('...pointing at the refund ledger row', rf[0].data.transaction_id === (await one(`select id from wallet_transactions where order_id = $1 and kind = 'refund'`, [oDone])).id, JSON.stringify(rf[0].data));
ok('another customer never sees it', !(await mine(B)).some((r) => r.type === 'refund_credited') && (await mine(A)).some((r) => r.type === 'refund_credited'));
const oFail = await mkOrd('pending', 30.5);
await as('authenticated', ADM, `select admin_set_order_status($1, 'failed')`, [oFail]);
rf = await refunds();
ok('failing an unfinished order gives the money back too: announced the same way (Br 30.5)', rf.length === 2 && rf[1].data.order_id === oFail && rf[1].body === 'Br 30.5 refunded to your wallet', JSON.stringify(rf));
await as('authenticated', ADM, `select admin_adjust_balance($1, -10, 'test debit')`, [A]);
ok('a debit never announces anything', (await refunds()).length === 2 && (await count(`select count(*) n from notifications where type <> 'refund_credited'`)) === 0);
await db.exec(`delete from notifications`);
console.log('\n-- broadcast vs targeted');
await db.exec(`delete from notifications`);
const bc = (await one(`insert into notifications (type, title, body) values ('discount','B1','b') returning id`)).id;
const forA = (await one(`insert into notifications (type, title, body, user_id) values ('order_delivered','For A','a', $1) returning id`, [A])).id;
ok('a broadcast reaches every customer', (await mine(A)).some((r) => r.id === bc) && (await mine(B)).some((r) => r.id === bc));
ok('a targeted notification reaches only its user', (await mine(A)).some((r) => r.id === forA) && !(await mine(B)).some((r) => r.id === forA));
ok('the same holds for a plain select (the policy Realtime applies to live inserts)',
  (await rows('authenticated', B, `select id from notifications`)).every((r) => r.id !== forA) && (await rows('authenticated', A, `select id from notifications`)).some((r) => r.id === forA));
ok('a new type needed no schema change (order_delivered went straight in)', (await mine(A)).find((r) => r.id === forA)?.type === 'order_delivered');
ok('unread counts both kinds', (await unread(A)) === 2 && (await unread(B)) === 1);
await rejects('signed out: no list', 'anon', null, `select * from my_notifications()`, /permission denied|not_authenticated/);

console.log('\n-- nobody writes the tables directly');
await rejects('a customer cannot insert a notification', 'authenticated', A, `insert into notifications (type, title, body) values ('discount','x','y')`, /permission denied/);
await rejects('a customer cannot edit one', 'authenticated', A, `update notifications set title = 'x'`, /permission denied/);
await rejects('a customer cannot delete one', 'authenticated', A, `delete from notifications`, /permission denied/);
await rejects('a customer cannot write read state directly', 'authenticated', A, `insert into notification_seen (user_id, notification_id) values ($1, $2)`, /permission denied/, [A, bc]);
await rejects('an admin cannot insert directly either (only the trigger/functions write)', 'authenticated', ADM, `insert into notifications (type, title, body) values ('discount','x','y')`, /permission denied/);
await rejects('type must be a plain lowercase word', 'service_role', null, `insert into notifications (type, title, body) values ('Bad Type','x','y')`, /check constraint/);

// ------------------------------------------------------------------ seen
console.log('\n-- read state');
const marked = Number((await one(`select 1`)) && (await rows('authenticated', A, `select mark_notifications_seen($1::uuid[]) as n`, [[bc, forA]]))[0].n);
ok('marking seen records both', marked === 2 && (await unread(A)) === 0);
ok('marking again is harmless', Number((await rows('authenticated', A, `select mark_notifications_seen($1::uuid[]) as n`, [[bc]]))[0].n) === 0);
ok("A's read state doesn't touch B's", (await unread(B)) === 1);
ok("B can't mark A's targeted notification (skipped, not an error)", Number((await rows('authenticated', B, `select mark_notifications_seen($1::uuid[]) as n`, [[forA]]))[0].n) === 0);
ok('seen rows are private', (await rows('authenticated', B, `select * from notification_seen`)).every((r) => r.user_id === B));
await rejects('at most 200 ids at a time', 'authenticated', A, `select mark_notifications_seen(array(select gen_random_uuid() from generate_series(1, 201)))`, /too_many_ids/);

// ------------------------------------------------------------------ expiry
console.log('\n-- 3-day expiry, cleaned up when read');
const old = (await one(`insert into notifications (type, title, body, created_at) values ('discount','Old','o', now() - interval '3 days 1 minute') returning id`)).id;
const edge = (await one(`insert into notifications (type, title, body, created_at) values ('discount','Edge','e', now() - interval '2 days 23 hours') returning id`)).id;
await db.query(`insert into notification_seen (user_id, notification_id) values ($1, $2)`, [B, old]);
const listB = await mine(B);
ok('older than 3 days: not listed, not counted', !listB.some((r) => r.id === old));
ok('just under 3 days: still listed and counted', listB.some((r) => r.id === edge && !r.seen));
ok('reading deleted the expired row', (await count(`select count(*) n from notifications where id = $1`, [old])) === 0);
ok('...and its seen rows with it', (await count(`select count(*) n from notification_seen where notification_id = $1`, [old])) === 0);
ok('an expired id cannot be marked seen', Number((await rows('authenticated', A, `select mark_notifications_seen($1::uuid[]) as n`, [[old]]))[0].n) === 0);

console.log('\n-- more unread than one list holds (found live: the badge undercounted and old unread became unreachable)');
const prior = Number((await mine(B))[0]?.unread_total ?? 0);
await db.exec(`insert into notifications (type, title, body, user_id, created_at) select 'discount', 'n' || g, 'b', '${B}', now() - (g || ' minutes')::interval from generate_series(1, 150) g`);
let manyB = await mine(B);
ok('the list stops at 100 by default', manyB.length === 100);
ok('but unread_total counts every unread one, not just the 100 listed', Number(manyB[0].unread_total) === prior + 150, `${manyB[0].unread_total} vs ${prior + 150}`);
await rows('authenticated', B, `select mark_notifications_seen($1::uuid[])`, [manyB.map((r) => r.id)]);
manyB = await mine(B);
const left = prior + 50;
ok('after marking the 100 shown, the rest are still counted', Number(manyB[0].unread_total) === left, `${manyB[0].unread_total} vs ${left}`);
ok('...and listed first, so the next opening reaches them', manyB.slice(0, left).every((r) => !r.seen) && manyB.slice(left).every((r) => r.seen));
const unreadPart = manyB.slice(0, left);
ok('within the unread ones, newest first', unreadPart.every((r, i) => i === 0 || new Date(unreadPart[i - 1].created_at) >= new Date(r.created_at)));
await rows('authenticated', B, `select mark_notifications_seen($1::uuid[])`, [unreadPart.map((r) => r.id)]);
ok('a second opening clears the rest', Number((await mine(B))[0].unread_total) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
