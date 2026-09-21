// Catalog curation rules: visibility, defaults, price guards, supplier secrecy.
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
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
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
const state = async () => ({
  products: (await db.query(`select id, is_active from products order by id`)).rows,
  options: (await db.query(`select id, price::float p, is_active from product_options order by id`)).rows,
});

console.log('\n# migration preserves everything that exists (run 1 and 2, seed, snapshot, then 3)');
await db.exec(M1); await db.exec(M2); await db.exec(SEED);
// an admin-switched-off product and an off package must stay off too
await db.exec(`update products set is_active = false where slug = 'spotify'`);
await db.exec(`update product_options set is_active = false where id = (select id from product_options order by id limit 1)`);
const snap = await state();
await db.exec(M3); await db.exec(M3); await db.exec(M4); await db.exec(M5); await db.exec(M6); // twice: re-runnable
const after = await state();
ok('same number of products and packages', after.products.length === snap.products.length && after.options.length === snap.options.length && snap.products.length === 12);
ok('every product keeps its exact on/off state', JSON.stringify(after.products) === JSON.stringify(snap.products));
ok('every package keeps its exact price and on/off state', JSON.stringify(after.options) === JSON.stringify(snap.options));
ok('the previously active ones are still active', after.products.filter((p) => p.is_active).length === 11);
ok('new columns are null on old rows', (await db.query(`select count(*)::int c from product_options where old_price is not null or region_id is not null or group_label is not null`)).rows[0].c === 0);

const A = (await db.query(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id; // customer
const C = (await db.query(`insert into auth.users (email) values ('c@x.com') returning id`)).rows[0].id; // admin
await db.exec(`update profiles set role='admin' where id='${C}'`);
await as('authenticated', C, `select admin_adjust_balance('${A}', 5000, 'seed')`);

console.log('\n# new things default to OFF');
const P = (await rows('authenticated', C, `insert into products (slug,name,category) values ('t1','Test One','games') returning id, is_active`))[0];
ok('a new product is off by default', P.is_active === false);
const O1 = (await rows('authenticated', C, `insert into product_options (product_id,label,price) values ('${P.id}','100 Diamonds',55) returning id, is_active`))[0];
ok('a new package is off by default', O1.is_active === false);
const R1 = (await rows('authenticated', C, `insert into product_regions (product_id,code,label) values ('${P.id}','bd','BD') returning id, is_active`))[0];
ok('a new region is off by default', R1.is_active === false);

console.log('\n# customers only see products that are on AND have a package on');
const sees = async () => (await rows('authenticated', A, `select id from products where slug='t1'`)).length;
ok('everything off -> hidden', (await sees()) === 0);
await as('authenticated', C, `update products set is_active = true where id='${P.id}'`);
ok('product on but every package off -> still hidden', (await sees()) === 0);
await as('authenticated', C, `update product_options set is_active = true where id='${O1.id}'`);
ok('product on + one package on -> visible', (await sees()) === 1);
ok('...and that package is visible', (await rows('authenticated', A, `select id from product_options where id='${O1.id}'`)).length === 1);
const O2 = (await rows('authenticated', C, `insert into product_options (product_id,label,price) values ('${P.id}','310 Diamonds',165) returning id`))[0];
ok('an off package stays hidden from customers', (await rows('authenticated', A, `select id from product_options where id='${O2.id}'`)).length === 0);
ok('a region that is off stays hidden', (await rows('authenticated', A, `select id from product_regions`)).length === 0);
await as('authenticated', C, `update product_regions set is_active = true where id='${R1.id}'`);
ok('an active region of a live product is visible', (await rows('authenticated', A, `select id from product_regions`)).length === 1);
ok('admin sees everything, including off packages', (await rows('authenticated', C, `select id from product_options where product_id='${P.id}'`)).length === 2);
await as('authenticated', C, `update product_options set is_active = false where id='${O1.id}'`);
ok('turning the last package off hides the product again', (await sees()) === 0);
await as('authenticated', C, `update product_options set is_active = true where id='${O1.id}'`);

console.log('\n# a normal customer cannot write to the catalog');
await rejects('cannot insert a product', 'authenticated', A, `insert into products (slug,name,category) values ('h','h','games')`, /row-level security/);
await rejects('cannot insert a package', 'authenticated', A, `insert into product_options (product_id,label,price) values ('${P.id}','x',1)`, /row-level security/);
await rejects('cannot insert a region', 'authenticated', A, `insert into product_regions (product_id,code,label) values ('${P.id}','x','x')`, /row-level security/);
const zero = async (n, sql) => { const r = await as('authenticated', A, sql); ok(n, r.affectedRows === 0, `affected=${r.affectedRows}`); };
await zero('cannot change a price', `update product_options set price = 1 where id='${O1.id}'`);
await zero('cannot change a product', `update products set name = 'hacked' where id='${P.id}'`);
await zero('cannot flip is_active on a product', `update products set is_active = false where id='${P.id}'`);
await zero('cannot flip is_active on a package', `update product_options set is_active = false where id='${O1.id}'`);
await zero('cannot flip is_active on a region', `update product_regions set is_active = false where id='${R1.id}'`);
await zero('cannot set an old price', `update product_options set old_price = 999 where id='${O1.id}'`);
ok('the price is unchanged', (await db.query(`select price::float p from product_options where id='${O1.id}'`)).rows[0].p === 55);
await rejects('anon cannot read the catalog', 'anon', null, `select * from products`, /permission denied/);

console.log('\n# supplier ids and wholesale costs are admin only');
await as('authenticated', C, `insert into product_region_supplier (region_id, family, category_id, validation_category_id, validation_field_map) values ('${R1.id}','topups','free_fire_bd','free_fire','{}')`);
await as('authenticated', C, `insert into product_option_supplier (option_id, family, category_id, offer_ref, supplier_cost_usd) values ('${O1.id}','topups','free_fire_bd','25_diamonds',0.1530)`);
ok('admin can read supplier cost', (await rows('authenticated', C, `select supplier_cost_usd::float c from product_option_supplier`))[0]?.c === 0.153);
ok('admin can read the supplier category', (await rows('authenticated', C, `select category_id from product_region_supplier`)).length === 1);
ok('a customer reads ZERO supplier cost rows', (await rows('authenticated', A, `select * from product_option_supplier`)).length === 0);
ok('a customer reads ZERO supplier region rows', (await rows('authenticated', A, `select * from product_region_supplier`)).length === 0);
await rejects('a customer cannot insert supplier data', 'authenticated', A, `insert into product_option_supplier (option_id, family, category_id, offer_ref) values ('${O1.id}','topups','x','y')`, /row-level security/);
await zero('a customer cannot edit a supplier cost', `update product_option_supplier set supplier_cost_usd = 0`);
await rejects('anon cannot read supplier data', 'anon', null, `select * from product_option_supplier`, /permission denied/);
const cols = (await db.query(`select column_name from information_schema.columns where table_name in ('products','product_options','product_regions') and column_name ~ 'supplier|cost|offer_ref'`)).rows;
ok('no supplier/cost column exists on any customer-readable table', cols.length === 0, JSON.stringify(cols));
await rejects('the same supplier SKU cannot be imported twice', 'authenticated', C, `insert into product_option_supplier (option_id, family, category_id, offer_ref) values ('${O2.id}','topups','free_fire_bd','25_diamonds')`, /unique|duplicate/);
await as('authenticated', C, `insert into product_option_supplier (option_id, family, category_id, offer_ref) values ('${O2.id}','topups','free_fire_bd','50_diamonds')`);
ok('a different SKU imports fine', (await rows('authenticated', C, `select count(*)::int c from product_option_supplier`))[0].c === 2);

console.log('\n# price guards');
await rejects('a package cannot be created with a null price', 'authenticated', C, `insert into product_options (product_id,label,price) values ('${P.id}','x',null)`, /not-null|null value/);
await rejects('a package cannot be created with a zero price', 'authenticated', C, `insert into product_options (product_id,label,price) values ('${P.id}','x',0)`, /check constraint/);
await rejects('a package cannot be created with a negative price', 'authenticated', C, `insert into product_options (product_id,label,price) values ('${P.id}','x',-5)`, /check constraint/);
await rejects('an ACTIVE package cannot be repriced to zero', 'authenticated', C, `update product_options set price = 0 where id='${O1.id}'`, /check constraint/);
await rejects('an ACTIVE package cannot be repriced to null', 'authenticated', C, `update product_options set price = null where id='${O1.id}'`, /not-null|null value/);
await rejects('a package cannot be created active with a zero price', 'authenticated', C, `insert into product_options (product_id,label,price,is_active) values ('${P.id}','x',0,true)`, /check constraint/);

console.log('\n# old price');
await rejects('old_price equal to price is rejected', 'authenticated', C, `update product_options set old_price = 55 where id='${O1.id}'`, /check constraint/);
await rejects('old_price below price is rejected', 'authenticated', C, `update product_options set old_price = 40 where id='${O1.id}'`, /check constraint/);
await rejects('old_price on insert must also beat the price', 'authenticated', C, `insert into product_options (product_id,label,price,old_price) values ('${P.id}','x',50,50)`, /check constraint/);
await as('authenticated', C, `update product_options set old_price = 70 where id='${O1.id}'`);
ok('old_price above price is accepted', (await db.query(`select old_price::float o from product_options where id='${O1.id}'`)).rows[0].o === 70);
await rejects('raising the price to or past the old price is rejected', 'authenticated', C, `update product_options set price = 70 where id='${O1.id}'`, /check constraint/);
await as('authenticated', C, `update product_options set old_price = null where id='${O1.id}'`);
ok('old_price can be cleared (null)', (await db.query(`select old_price from product_options where id='${O1.id}'`)).rows[0].old_price === null);

console.log('\n# regions and packages');
await rejects('duplicate region code on one product', 'authenticated', C, `insert into product_regions (product_id,code,label) values ('${P.id}','bd','BD again')`, /unique|duplicate/);
await as('authenticated', C, `update product_options set region_id='${R1.id}' where id='${O1.id}'`);
await rejects('a region with packages cannot be deleted', 'authenticated', C, `delete from product_regions where id='${R1.id}'`, /foreign key|violates/);
ok('migration ran without the storage schema (PGlite has none)', (await db.query(`select to_regclass('storage.buckets') is null n`)).rows[0].n === true);

console.log('\n# buying still works (and only from live products)');
const ord = (await as('authenticated', A, `select * from purchase_product_option('${O1.id}', '{}')`)).rows[0];
ok('a live package can be bought and charged its server-side price', ord && Number(ord.amount) === 55);
await as('authenticated', C, `update products set is_active = false where id='${P.id}'`);
await rejects('a package of a hidden product cannot be bought', 'authenticated', A, `select * from purchase_product_option('${O1.id}', '{}')`, /option_unavailable/);
await rejects('anon cannot call catalog_product_is_live', 'anon', null, `select catalog_product_is_live('${P.id}')`, /permission denied/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
