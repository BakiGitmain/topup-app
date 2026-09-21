import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const M1 = read('migrations/20260920120000_roles_wallet_catalog.sql');
const M2 = read('migrations/20260921090000_orders_vault_admin.sql');
const M3 = read('migrations/20260922100000_catalog_curation.sql');
const M4 = read('migrations/20260922140000_multifield_purchase_and_guards.sql');
const M5 = read('migrations/20260923090000_region_matching.sql');
const M6 = read('migrations/20260924090000_id_validation.sql');
const SEED = read('tests/fixtures/placeholder-catalog.sql');

const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
async function as(role, uid, sql) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await db.query(sql); } finally { await db.exec('reset role;'); }
}
async function rejects(name, role, uid, sql, pattern) {
  try { await as(role, uid, sql); fail++; console.log('  FAIL', name, '(no error thrown)'); }
  catch (e) { const g = pattern.test(e.message); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', name, g ? '' : `-> got: ${e.message}`); }
}
const one = async (role, uid, sql) => (await as(role, uid, sql)).rows[0];
const bal = async (uid) => (await one('authenticated', uid, `select balance::float b from wallets`)).b;

console.log('\n# apply both migrations + seed, each twice (re-runnable)');
await db.exec(M1); await db.exec(M2); await db.exec(M3); await db.exec(M4); await db.exec(M5); await db.exec(M6); await db.exec(M1); await db.exec(M2); await db.exec(M3); await db.exec(M4); await db.exec(M5); await db.exec(M6);
await db.exec(SEED); await db.exec(SEED);
const seeded = (await db.query(`select (select count(*) from products)::int p, (select count(*) from product_options)::int o,
  (select count(*) from products where category in ('games','gift-cards','game-keys','subscriptions'))::int c`)).rows[0];
ok('seed idempotent: 12 products, 38 options, all in shop categories', seeded.p === 12 && seeded.o === 38 && seeded.c === 12, JSON.stringify(seeded));

const A = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ('a@x.com','{"display_name":"Alice"}') returning id`)).rows[0].id;
const B = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ('b@x.com','{"role":"admin"}') returning id`)).rows[0].id;
const C = (await db.query(`insert into auth.users (email) values ('c@x.com') returning id`)).rows[0].id;
await db.exec(`update profiles set role='admin' where id='${C}'`);
ok('metadata role ignored', (await db.query(`select role from profiles where id='${B}'`)).rows[0].role === 'user');
await as('authenticated', C, `select admin_adjust_balance('${A}', 5000, 'seed money')`);
await as('authenticated', C, `select admin_adjust_balance('${B}', 5000, 'seed money')`);

console.log('\n# customers cannot escalate, touch money, or forge things');
await rejects('cannot set own role', 'authenticated', A, `update profiles set role='admin' where id='${A}'`, /permission denied/);
await rejects('cannot write balance', 'authenticated', A, `update wallets set balance=9 where user_id='${A}'`, /permission denied/);
await rejects('cannot forge order', 'authenticated', A, `insert into orders (user_id, product_name, option_label, amount) values ('${A}','x','y',1)`, /permission denied/);
await rejects('cannot forge vault code', 'authenticated', A, `insert into vault_codes (order_id, user_id, code) values (gen_random_uuid(), '${A}', 'X')`, /permission denied/);
await rejects('anon cannot read vault', 'anon', null, `select * from vault_codes`, /permission denied/);
{
  const r = await as('authenticated', A, `update profiles set language='am' where id='${A}'`);
  ok('customer can set own language to am', r.affectedRows === 1);
  await rejects('language must be en or am', 'authenticated', A, `update profiles set language='fr' where id='${A}'`, /check constraint/);
}
{
  const r = await as('authenticated', A, `update profiles set language='en' where id='${B}'`);
  ok('...and touches 0 rows of another user', r.affectedRows === 0);
}

console.log('\n# admin catalog: new categories allowed, junk rejected');
{
  const r = await as('authenticated', C, `insert into products (slug,name,category) values ('gk2','Key 2','game-keys') returning id`);
  ok('admin adds a game-keys product', r.rows.length === 1);
  await rejects('unknown category rejected', 'authenticated', C, `insert into products (slug,name,category) values ('zz','Z','nonsense')`, /check constraint/);
}

const opt = async (slug, label) => (await db.query(`select o.id, o.price::float p from product_options o join products p on p.id=o.product_id where p.slug='${slug}' and o.label='${label}'`)).rows[0];
const ff = await opt('freefire', '100 Diamonds');       // topup, Br 55
const gp = await opt('google-play', 'Br 250 card');      // code,  Br 250

console.log('\n# game ID is required for top-ups and validated on the server');
await rejects('topup without account_id', 'authenticated', A, `select purchase_product_option('${ff.id}')`, /account_id_required/);
await rejects('topup with blank account_id', 'authenticated', A, `select purchase_product_option('${ff.id}', '{"account_id":"   "}')`, /account_id_required/);
await rejects('topup with huge account_id', 'authenticated', A, `select purchase_product_option('${ff.id}', '{"account_id":"${'9'.repeat(65)}"}')`, /account_id_invalid/);
ok('failed attempts charged nothing', (await bal(A)) === 5000);
const o1 = (await one('authenticated', A, `select * from purchase_product_option('${ff.id}', '{"account_id":" 123456789 ","evil":"x","role":"admin"}')`));
ok('topup order: pending, topup, id trimmed, junk keys stripped',
  o1.status === 'pending' && o1.fulfillment === 'topup' && JSON.stringify(o1.delivery) === '{"account_id":"123456789"}', JSON.stringify(o1));
ok('charged Br 55', (await bal(A)) === 4945);
const o2 = (await one('authenticated', A, `select * from purchase_product_option('${gp.id}')`));
ok('gift card order: fulfillment=code, no game ID needed', o2.fulfillment === 'code' && JSON.stringify(o2.delivery) === '{}');

console.log('\n# admin work queue: processing, delivery, failure');
await rejects('customer cannot deliver', 'authenticated', A, `select admin_deliver_order('${o1.id}')`, /forbidden/);
await rejects('completed via set_status is not allowed', 'authenticated', C, `select admin_set_order_status('${o1.id}', 'completed')`, /invalid_status/);
{
  const r = await one('authenticated', C, `select (admin_set_order_status('${o1.id}', 'processing')).status s`);
  ok('pending -> processing', r.s === 'processing');
  const d = await one('authenticated', C, `select (admin_deliver_order('${o1.id}')).status s, true as done`);
  ok('topup delivered without a code -> completed, completed_at set', d.s === 'completed' && (await db.query(`select completed_at is not null ok from orders where id='${o1.id}'`)).rows[0].ok);
  const v = await as('authenticated', A, `select id from vault_codes`);
  ok('a diamonds/UC delivery never creates a vault row', v.rows.length === 0);
}
await rejects('cannot deliver twice', 'authenticated', C, `select admin_deliver_order('${o1.id}')`, /invalid_transition/);
await rejects('gift card delivery needs a code', 'authenticated', C, `select admin_deliver_order('${o2.id}')`, /code_required/);
await rejects('blank code rejected', 'authenticated', C, `select admin_deliver_order('${o2.id}', '   ')`, /code_required/);
let vaultId;
{
  await as('authenticated', C, `select admin_deliver_order('${o2.id}', '  ABCD-1234-EFGH  ')`);
  const v = (await as('authenticated', A, `select id, code, is_used from vault_codes`)).rows;
  ok('code lands in the buyer vault, trimmed, unused', v.length === 1 && v[0].code === 'ABCD-1234-EFGH' && v[0].is_used === false);
  vaultId = v[0].id;
  ok('other customers cannot see it', (await as('authenticated', B, `select id from vault_codes`)).rows.length === 0);
  ok('admin can see it', (await as('authenticated', C, `select id from vault_codes`)).rows.length === 1);
}

console.log('\n# vault: owner may only flip used/unused, nothing is deletable');
{
  const r = await as('authenticated', A, `update vault_codes set is_used = true where id='${vaultId}'`);
  ok('owner marks code used', r.affectedRows === 1);
  const r2 = await as('authenticated', A, `update vault_codes set is_used = false where id='${vaultId}'`);
  ok('...and unused again', r2.affectedRows === 1);
  await rejects('owner cannot edit the code', 'authenticated', A, `update vault_codes set code='HACK' where id='${vaultId}'`, /permission denied/);
  await rejects('owner cannot delete', 'authenticated', A, `delete from vault_codes where id='${vaultId}'`, /permission denied/);
  await rejects('admin (via API) cannot delete either', 'authenticated', C, `delete from vault_codes where id='${vaultId}'`, /permission denied/);
  const r3 = await as('authenticated', B, `update vault_codes set is_used = true where id='${vaultId}'`);
  ok('another customer cannot flip it (0 rows)', r3.affectedRows === 0);
}

console.log('\n# refunds');
{
  await rejects('completed gift-card order cannot be refunded (they hold the code)', 'authenticated', C, `select admin_set_order_status('${o2.id}', 'refunded')`, /code_already_delivered/);
  const before = await bal(A);
  const r = await one('authenticated', C, `select (admin_set_order_status('${o1.id}', 'refunded')).status s`);
  ok('completed top-up can be refunded', r.s === 'refunded' && (await bal(A)) === before + 55);
}
{
  const p = await one('authenticated', B, `select (purchase_product_option('${ff.id}', '{"account_id":"777"}')).id id`);
  const before = await bal(B);
  await as('authenticated', C, `select admin_set_order_status('${p.id}', 'failed')`);
  ok('pending -> failed refunds the customer', (await bal(B)) === before + 55);
  await rejects('cannot fail twice (no double refund)', 'authenticated', C, `select admin_set_order_status('${p.id}', 'failed')`, /invalid_transition/);
  const p2 = await one('authenticated', B, `select (purchase_product_option('${ff.id}', '{"account_id":"888"}')).id id`);
  await as('authenticated', C, `select admin_set_order_status('${p2.id}', 'processing')`);
  const b2 = await bal(B);
  await as('authenticated', C, `select admin_set_order_status('${p2.id}', 'failed')`);
  ok('processing -> failed refunds too', (await bal(B)) === b2 + 55);
}

console.log('\n# visibility + ledger');
{
  ok('customers see only their own orders', (await as('authenticated', A, `select id from orders`)).rows.every((r) => true) &&
     (await as('authenticated', A, `select id from orders where user_id <> '${A}'`)).rows.length === 0);
  const r = await db.query(`select w.balance::float b, coalesce(sum(t.amount),0)::float s from wallets w left join wallet_transactions t on t.user_id=w.user_id group by w.user_id, w.balance`);
  ok('every wallet balance equals its ledger sum', r.rows.every((x) => x.b === x.s), JSON.stringify(r.rows));
  const emb = await as('authenticated', C, `select o.id, p.email from orders o join profiles p on p.id = o.user_id limit 1`);
  ok('admin can join orders to customers (queue rows)', emb.rows.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
