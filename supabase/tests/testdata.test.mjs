// Checks supabase/test-data/free-fire-mena.test.sql (the real Free Fire test product) against every
// migration. That file holds wholesale costs, so it is git-ignored; this suite skips if it is absent.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const fileUrl = new URL('../test-data/free-fire-mena.test.sql', import.meta.url);
if (!fs.existsSync(fileUrl)) {
  console.log('  SKIP no supabase/test-data/free-fire-mena.test.sql');
  process.exit(0);
}
const TEST_SQL = fs.readFileSync(fileUrl, 'utf8');
const scan = fs.existsSync(new URL('../../scripts/out/fazer-scan.json', import.meta.url))
  ? JSON.parse(fs.readFileSync(new URL('../../scripts/out/fazer-scan.json', import.meta.url), 'utf8'))
  : null;

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATIONS = [
  'migrations/20260920120000_roles_wallet_catalog.sql',
  'migrations/20260921090000_orders_vault_admin.sql',
  'migrations/20260922100000_catalog_curation.sql',
  'migrations/20260922140000_multifield_purchase_and_guards.sql',
  'migrations/20260923090000_region_matching.sql',
  'migrations/20260924090000_id_validation.sql',
].map(read);

const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };
async function as(role, uid, sql) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await db.query(sql); } finally { await db.exec('reset role;'); }
}
async function rejects(n, role, uid, sql, re) {
  try { await as(role, uid, sql); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const rows = async (role, uid, sql) => (await as(role, uid, sql)).rows;
const q1 = async (sql) => (await db.query(sql)).rows;

for (const m of MIGRATIONS) await db.exec(m);
await db.exec(read('tests/fixtures/placeholder-catalog.sql'));

const A = (await db.query(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id;
const C = (await db.query(`insert into auth.users (email) values ('c@x.com') returning id`)).rows[0].id;
await db.exec(`update profiles set role='admin' where id='${C}'`);
await as('authenticated', C, `select admin_adjust_balance('${A}', 100000, 'seed')`);

const SLUG = `'free-fire-diamonds-test'`;

console.log('\n# it applies cleanly through every guard, and everything starts OFF');
await db.exec(TEST_SQL);
const prod = (await q1(`select * from products where slug = ${SLUG}`))[0];
ok('the product exists, is a game, and is OFF', prod && prod.category === 'games' && prod.is_active === false && prod.name === 'Free Fire Diamonds');
const region = (await q1(`select * from product_regions where product_id = '${prod.id}'`))[0];
ok('one MENA region, OFF, checked by the supplier', region.code === 'mena' && region.label === 'MENA' && region.is_active === false && region.id_validation === 'supplier');
const f0 = region.buyer_fields[0];
ok('its form is the supplier\'s real fields[] (player_id)', region.buyer_fields.length === 1 && f0.key === 'player_id' && f0.label === 'Player ID' && f0.type === 'text', JSON.stringify(region.buyer_fields));
if (scan) ok('...identical to the scan\'s fields[]', JSON.stringify(scan.topups.free_fire_mena.fields.map((f) => [f.key, f.label, f.type])) === JSON.stringify(region.buyer_fields.map((f) => [f.key, f.label, f.type])));
const link = (await q1(`select * from product_region_supplier where region_id = '${region.id}'`))[0];
ok('purchases go to free_fire_mena, validation uses free_fire (different namespaces)', link.category_id === 'free_fire_mena' && link.validation_category_id === 'free_fire' && link.family === 'topups');
const opts = await q1(`select o.*, s.offer_ref, s.supplier_cost_usd, s.category_id as sup_cat, s.supplier_offer_name from product_options o join product_option_supplier s on s.option_id = o.id where o.product_id = '${prod.id}' order by o.sort_order`);
ok('five packs, all OFF', opts.length === 5 && opts.every((o) => o.is_active === false));
ok('every pack is region-locked to ME accounts', opts.every((o) => o.region_locked === true && JSON.stringify(o.account_region_codes) === '["ME"]'));
ok('every pack is in the MENA region under "Diamonds"', opts.every((o) => o.region_id === region.id && o.group_label === 'Diamonds'));
ok('prices are obvious placeholders (9999)', opts.every((o) => Number(o.price) === 9999));
ok('offer ids and names are the real ones', opts.map((o) => o.offer_ref).join() === '110_diamonds,231_diamonds,583_diamonds,1188_diamonds,2420_diamonds' && opts.map((o) => o.label).join() === '110 Diamonds,231 Diamonds,583 Diamonds,1188 Diamonds,2420 Diamonds', opts.map((o) => o.offer_ref).join());
ok('each pack orders from free_fire_mena', opts.every((o) => o.sup_cat === 'free_fire_mena'));
ok('USD costs are stored', opts.map((o) => Number(o.supplier_cost_usd)).join() === '0.9456,1.8913,4.75,9.5,18.9128', opts.map((o) => o.supplier_cost_usd).join());
if (scan) {
  const real = scan.topups.free_fire_mena.offers.map((o) => [o.offer_id, Number(o.price_usd)].join(':')).join();
  ok('...and match the scan exactly', opts.map((o) => [o.offer_ref, Number(o.supplier_cost_usd)].join(':')).join() === real, real);
}

console.log('\n# nobody but you can see it, or its costs');
ok('a customer cannot see the product', (await rows('authenticated', A, `select id from products where slug = ${SLUG}`)).length === 0);
ok('a customer cannot see its region or packs', (await rows('authenticated', A, `select id from product_regions where product_id = '${prod.id}'`)).length === 0 && (await rows('authenticated', A, `select id from product_options where product_id = '${prod.id}'`)).length === 0);
ok('a customer cannot read the supplier tables (offer ids, costs)', (await rows('authenticated', A, `select * from product_option_supplier`)).length === 0 && (await rows('authenticated', A, `select * from product_region_supplier`)).length === 0);
ok('an admin can see it', (await rows('authenticated', C, `select id from products where slug = ${SLUG}`)).length === 1);

console.log('\n# re-running changes nothing');
await db.exec(`update product_options set price = 123 where product_id = '${prod.id}' and label = '110 Diamonds'`);
await db.exec(TEST_SQL);
ok('still one product, five packs', (await q1(`select count(*)::int c from products where slug = ${SLUG}`))[0].c === 1 && (await q1(`select count(*)::int c from product_options where product_id = '${prod.id}'`))[0].c === 5);
ok('and the price you set was NOT overwritten', Number((await q1(`select price from product_options where product_id = '${prod.id}' and label = '110 Diamonds'`))[0].price) === 123);

console.log('\n# turning it on, as the file says');
await db.exec(`
  update public.product_options o set price = 100 from public.products p
   where p.id = o.product_id and p.slug = 'free-fire-diamonds-test' and o.label = '110 Diamonds';
  update public.products         set is_active = true where slug = 'free-fire-diamonds-test';
  update public.product_regions  set is_active = true where product_id = (select id from public.products where slug = 'free-fire-diamonds-test');
  update public.product_options  set is_active = true where label = '110 Diamonds' and product_id = (select id from public.products where slug = 'free-fire-diamonds-test');
`);
const vis = await rows('authenticated', A, `select id from products where slug = ${SLUG}`);
ok('with one pack on, customers see the product', vis.length === 1);
ok('...and only that one pack', (await rows('authenticated', A, `select label from product_options where product_id = '${prod.id}'`)).map((r) => r.label).join() === '110 Diamonds');
ok('customers still cannot see the costs', (await rows('authenticated', A, `select * from product_option_supplier`)).length === 0);
const target = (await as('service_role', null, `select * from id_validation_target('${region.id}')`)).rows[0];
ok('the Edge Function finds what it needs (free_fire, supplier, player_id)', target && target.validation_category_id === 'free_fire' && target.id_validation === 'supplier' && target.buyer_fields[0].key === 'player_id');

console.log('\n# the region lock and the ID check, against this product');
const pack = (await q1(`select id from product_options where product_id = '${prod.id}' and label = '110 Diamonds'`))[0].id;
const buy = (delivery, checked = false) => as('authenticated', A, `select * from purchase_product_option('${pack}', '${JSON.stringify(delivery)}'::jsonb, ${checked})`);
await rejects('no validation record: refused', 'authenticated', A, `select * from purchase_product_option('${pack}', '{"player_id":"3327205705"}'::jsonb, false)`, /id_not_validated/);
await rejects('the tick cannot replace the check', 'authenticated', A, `select * from purchase_product_option('${pack}', '{"player_id":"3327205705"}'::jsonb, true)`, /id_not_validated/);
const rec = (id, acct) => as('service_role', null, `select * from record_id_validation('${A}', '${region.id}', '{"player_id":"${id}"}'::jsonb, ${acct === null ? 'null' : `'${acct}'`}, 'Test player')`).then((r) => r.rows[0]);
await rec('1111', 'BR');
await rejects('a BR account is refused (the pack serves ME only)', 'authenticated', A, `select * from purchase_product_option('${pack}', '{"player_id":"1111"}'::jsonb, false)`, /region_mismatch/);
await rec('2222', null);
await rejects('an account with no reported region is refused', 'authenticated', A, `select * from purchase_product_option('${pack}', '{"player_id":"2222"}'::jsonb, false)`, /region_unverified/);
const v = await rec('3327205705', 'ME');
const order = (await buy({ player_id: '3327205705' })).rows[0];
ok('an ME account with a valid record buys it', !!order && Number(order.amount) === 100);
ok('the order records what was checked', order.validation_id === v.validation_id && order.validated_account_region === 'ME' && order.validated_player_name === 'Test player' && order.id_self_declared_at === null);
await rejects('a different ID than the one checked is refused', 'authenticated', A, `select * from purchase_product_option('${pack}', '{"player_id":"9999999"}'::jsonb, false)`, /id_not_validated/);
await rejects('a pack that is still OFF cannot be bought', 'authenticated', A, `select * from purchase_product_option('${opts[1].id}', '{"player_id":"3327205705"}'::jsonb, false)`, /option_unavailable/);

console.log('\n# switching off and removing, as the file says');
await db.exec(`update public.products set is_active = false where slug = 'free-fire-diamonds-test'`);
ok('switched off: customers cannot see it again', (await rows('authenticated', A, `select id from products where slug = ${SLUG}`)).length === 0);
await db.exec(`
  delete from public.product_options where product_id = (select id from public.products where slug = 'free-fire-diamonds-test');
  delete from public.products where slug = 'free-fire-diamonds-test';
`);
ok('removed completely (product, region, packs, supplier rows)', (await q1(`select (select count(*) from products where slug = ${SLUG}) + (select count(*) from product_regions where id = '${region.id}') + (select count(*) from product_options where product_id = '${prod.id}') + (select count(*) from product_region_supplier where region_id = '${region.id}') as n`))[0].n === 0);
ok('the order you placed keeps its history', (await q1(`select count(*)::int c from orders where product_name = 'Free Fire Diamonds'`))[0].c === 1);
await db.exec(TEST_SQL);
ok('and it can be created again after removal', (await q1(`select count(*)::int c from products where slug = ${SLUG}`))[0].c === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
