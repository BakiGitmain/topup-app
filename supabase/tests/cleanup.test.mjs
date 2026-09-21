// 20260925110000_remove_placeholder_products.sql: removes the placeholders and the test product, keeps
// everything else, and refuses to run (deleting nothing) if an order points at them.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATIONS = [
  'migrations/20260920120000_roles_wallet_catalog.sql',
  'migrations/20260921090000_orders_vault_admin.sql',
  'migrations/20260922100000_catalog_curation.sql',
  'migrations/20260922140000_multifield_purchase_and_guards.sql',
  'migrations/20260923090000_region_matching.sql',
  'migrations/20260924090000_id_validation.sql',
  'migrations/20260925090000_supplier_catalog_cache.sql',
  'migrations/20260925100000_admin_import.sql',
].map(read);
const CLEANUP = read('migrations/20260925110000_remove_placeholder_products.sql');
const FIXTURE = read('tests/fixtures/placeholder-catalog.sql');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };

/** A fresh database shaped like the live one: the placeholders, two hand-made airtime products, the Free Fire test product, and one keeper. */
async function world() {
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
  for (const m of MIGRATIONS) await db.exec(m);
  await db.exec(FIXTURE);
  await db.exec(`
    insert into products (slug, name, category, is_active, sort_order) values
      ('ethio-airtime', 'Ethio telecom airtime', 'airtime', false, 0), ('safaricom-airtime', 'Safaricom Ethiopia airtime', 'airtime', false, 0);
    insert into product_options (product_id, label, price, is_active)
      select id, 'Br 10', 10, false from products where slug in ('ethio-airtime', 'safaricom-airtime');

    -- the Free Fire test product: region, supplier links, an ID check
    insert into products (slug, name, category, is_active) values ('free-fire-diamonds-test', 'Free Fire Diamonds', 'games', true);
    insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active)
      select id, 'mena', 'MENA', '[{"key":"player_id","label":"Player ID","type":"text"}]', 'supplier', true from products where slug = 'free-fire-diamonds-test';
    insert into product_region_supplier (region_id, family, category_id, validation_category_id)
      select id, 'topups', 'free_fire_mena', 'free_fire' from product_regions where code = 'mena';
    insert into product_options (product_id, label, price, region_id, region_locked, account_region_codes, is_active)
      select p.id, '110 Diamonds', 100, r.id, true, array['ME'], false from products p join product_regions r on r.product_id = p.id where p.slug = 'free-fire-diamonds-test';
    insert into product_option_supplier (option_id, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name)
      select o.id, 'topups', 'free_fire_mena', '110_diamonds', 0.9456, '110 Diamonds' from product_options o join products p on p.id = o.product_id where p.slug = 'free-fire-diamonds-test';
    insert into auth.users (email) values ('c@x.com');
    insert into id_validations (user_id, region_id, fields, account_region, player_name, expires_at)
      select (select id from auth.users limit 1), r.id, '{"player_id":"1"}', 'ME', 'x', now() + interval '15 minutes' from product_regions r where code = 'mena';

    -- a product that must survive: imported later, with its own region and links
    insert into products (slug, name, category, is_active) values ('keeper-abc123', 'Keeper', 'games', false);
    insert into product_regions (product_id, code, label, buyer_fields, id_validation)
      select id, 'bd', 'BD', '[]', 'none' from products where slug = 'keeper-abc123';
    insert into product_options (product_id, label, price, region_id)
      select p.id, '25 Diamonds', 20, r.id from products p join product_regions r on r.product_id = p.id where p.slug = 'keeper-abc123';
    insert into product_region_supplier (region_id, family, category_id)
      select id, 'topups', 'free_fire_bd' from product_regions where code = 'bd' and product_id = (select id from products where slug = 'keeper-abc123');
    insert into product_option_supplier (option_id, family, category_id, offer_ref, supplier_cost_usd, supplier_offer_name)
      select o.id, 'topups', 'free_fire_bd', '25_diamonds', 0.5, '25 Diamonds' from product_options o join products p on p.id = o.product_id where p.slug = 'keeper-abc123';

    -- the saved supplier catalog
    insert into supplier_catalog (family, category_id, name, game_name) values ('topups', 'free_fire_mena', 'Free Fire (MENA)', 'Free Fire');
  `);
  return db;
}
const one = async (db, sql) => (await db.query(sql)).rows[0];
const counts = (db) => one(db, `select (select count(*)::int from products) products, (select count(*)::int from product_options) packs,
  (select count(*)::int from product_regions) regions, (select count(*)::int from product_region_supplier) region_links,
  (select count(*)::int from product_option_supplier) pack_links, (select count(*)::int from id_validations) checks,
  (select count(*)::int from supplier_catalog) catalog, (select count(*)::int from orders) orders`);

console.log('# a clean database');
{
  const db = await world();
  const before = await counts(db);
  ok('the world starts with 12 + 2 + 1 placeholders/test products and one keeper', before.products === 16, JSON.stringify(before));
  await db.exec(CLEANUP);
  const after = await counts(db);
  ok('only the keeper product remains', after.products === 1 && (await one(db, `select slug from products`)).slug === 'keeper-abc123', JSON.stringify(after));
  ok('the keeper keeps its region, pack and both supplier links', after.regions === 1 && after.packs === 1 && after.region_links === 1 && after.pack_links === 1, JSON.stringify(after));
  ok('every removed product took its packs, regions, supplier links and ID checks with it', after.checks === 0 && before.packs - after.packs > 40, JSON.stringify(after));
  ok('the saved supplier catalog is untouched', after.catalog === 1);
  ok('none of the 15 slugs is left', (await one(db, `select count(*)::int n from products where slug in ('freefire','pubg','mlbb','codm','roblox','google-play','netflix','steam','spotify','pc-game-keys','telegram-premium','playstation-plus','ethio-airtime','safaricom-airtime','free-fire-diamonds-test')`)).n === 0);
  await db.exec(CLEANUP);
  ok('running it again does nothing', JSON.stringify(await counts(db)) === JSON.stringify(after));
  const cat = (await one(db, `select count(*)::int n from products`)).n;
  ok('a product imported afterwards is not affected by a re-run', cat === 1);
}

console.log('\n# an empty database (a fresh project)');
{
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
  for (const m of MIGRATIONS) await db.exec(m);
  await db.exec(read('seed.sql'));
  ok('the real seed.sql adds no products', (await one(db, `select count(*)::int n from products`)).n === 0);
  await db.exec(CLEANUP);
  ok('the cleanup on an empty database is a no-op', (await one(db, `select count(*)::int n from products`)).n === 0);
}

console.log('\n# order history is protected');
{
  const db = await world();
  const user = (await one(db, `select id from auth.users limit 1`)).id;
  await db.exec(`update profiles set role='admin' where id='${user}'`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${user}', false); select admin_adjust_balance('${user}', 1000, 'seed')`);
  const opt = (await one(db, `select o.id from product_options o join products p on p.id = o.product_id where p.slug = 'freefire' and o.label = '100 Diamonds'`)).id;
  await db.exec(`select * from purchase_product_option('${opt}', '{"account_id":"123"}'::jsonb, true)`);
  ok('an order exists for a placeholder pack', (await one(db, `select count(*)::int n from orders`)).n === 1);

  const before = await counts(db);
  let message = '';
  try { await db.exec(CLEANUP); } catch (e) { message = e.message + ' ' + (e.detail ?? ''); }
  ok('the cleanup refuses, naming the orders', /placeholder_cleanup_blocked_by_orders/.test(message), message);
  ok('...and deleted NOTHING (products, packs, regions, links, checks, orders)', JSON.stringify(await counts(db)) === JSON.stringify(before));

  // The other direction: an order pointing at a Free Fire test ID check.
  const db2 = await world();
  const u2 = (await one(db2, `select id from auth.users limit 1`)).id;
  await db2.exec(`update profiles set role='admin' where id='${u2}'`);
  await db2.exec(`select set_config('request.jwt.claim.sub', '${u2}', false); select admin_adjust_balance('${u2}', 1000, 'seed')`);
  await db2.exec(`update products set is_active = true where slug = 'free-fire-diamonds-test'; update product_options set is_active = true where label = '110 Diamonds' and price = 100; update product_options set account_region_codes = array['ME'] where label = '110 Diamonds' and price = 100`);
  const ffOpt = (await one(db2, `select o.id from product_options o join products p on p.id = o.product_id where p.slug = 'free-fire-diamonds-test'`)).id;
  await db2.exec(`select * from purchase_product_option('${ffOpt}', '{"player_id":"1"}'::jsonb, false)`);
  const before2 = await counts(db2);
  let m2 = '';
  try { await db2.exec(CLEANUP); } catch (e) { m2 = e.message; }
  ok('an order for the Free Fire test product also blocks it', /placeholder_cleanup_blocked_by_orders/.test(m2), m2);
  ok('...and deleted nothing', JSON.stringify(await counts(db2)) === JSON.stringify(before2));
  const o = await one(db2, `select product_name, option_label, amount::text a, validated_account_region v from orders`);
  ok('the order carries its own copy of what was bought (why deleting would not have erased history anyway)', o.product_name === 'Free Fire Diamonds' && o.option_label === '110 Diamonds' && o.a === '100.00' && o.v === 'ME', JSON.stringify(o));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
