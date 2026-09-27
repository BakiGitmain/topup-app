// 20261023090000: Free Fire opens on MENA (listed first), LATAM second; nothing else moves.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const FILES = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
const FIX = read(`migrations/${FILES.find((f) => f.includes('free_fire_mena_first'))}`);

const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
`);
for (const f of FILES) await db.exec(read(`migrations/${f}`));

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const order = async (product) => (await db.query(`select label, sort_order from product_regions where product_id = $1 order by sort_order, label`, [product])).rows.map((r) => `${r.label}:${r.sort_order}`).join(' ');

console.log('\n-- Free Fire: MENA first, LATAM second');
const FF = (await one(`insert into products (slug, name, category) values ('ff', 'Free Fire', 'games') returning id`)).id;
// Tied, like live: the label broke the tie and LATAM came first.
await db.exec(`insert into product_regions (product_id, code, label, sort_order) values ('${FF}', 'latam', 'LATAM', 0), ('${FF}', 'mena', 'MENA', 0), ('${FF}', 'eu', 'EU', 0)`);
const CARD = (await one(`insert into products (slug, name, category) values ('ffc', 'Free Fire Cards', 'gift-cards') returning id`)).id;
await db.exec(`insert into product_regions (product_id, code, label, sort_order) values ('${CARD}', 'gl', 'Global', 5)`);
const OTHER = (await one(`insert into products (slug, name, category) values ('pubg', 'PUBG Mobile', 'games') returning id`)).id;
await db.exec(`insert into product_regions (product_id, code, label, sort_order) values ('${OTHER}', 'latam', 'LATAM', 0), ('${OTHER}', 'mena', 'MENA', 0)`);
ok('before: LATAM sorts first (the reported bug)', (await order(FF)).startsWith('EU:0 LATAM:0'));

await db.exec(FIX);
ok('after: MENA 0, LATAM 1, any other region after them', (await order(FF)) === 'MENA:0 LATAM:1 EU:2', await order(FF));
await db.exec(FIX);
ok('re-running changes nothing', (await order(FF)) === 'MENA:0 LATAM:1 EU:2');
ok('only Free Fire: another game with the same two regions is untouched', (await order(OTHER)) === 'LATAM:0 MENA:0', await order(OTHER));
ok('...and a product without both regions is untouched', (await order(CARD)) === 'Global:5');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
