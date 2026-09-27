// Gifts (20261020090000): the buyer picks the pack's dropdown fields (e.g. the server) when buying; the recipient only
// types their own ID at claim and can't change the choice. Also: the admin queue's customer join stays unambiguous
// now that orders has two links to profiles (user_id, gift_recipient_id).
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
await as('authenticated', ADM, `select admin_adjust_balance($1, 5000, 'funds')`, [BUYER]);

const P = (await one(`insert into products (slug, name, category, is_active) values ('ml','Mobile Legends','games',true) returning id`)).id;
const SERVER_FIELDS = [
  { key: 'player_id', label: 'Player ID', type: 'text' },
  { key: 'server', label: 'Server', type: 'select', options: [{ label: 'Asia', value: 'asia' }, { label: 'Europe', value: 'eu' }] },
];
const R = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global',$2::jsonb,'none',true) returning id`, [P, JSON.stringify(SERVER_FIELDS)])).id;
const O = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'86 Diamonds',200,true) returning id`, [P, R])).id;
const P2 = (await one(`insert into products (slug, name, category, is_active) values ('roblox','Roblox','gift-cards',true) returning id`)).id;
const R2 = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [P2])).id;
const O2 = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'800 Robux',300,true) returning id`, [P2, R2])).id;

const buy = (option, kind, to, fields) => rows('authenticated', BUYER, `select checkout_gift($1, $2, $3, $4::jsonb) r`, [option, kind, to, JSON.stringify(fields)]).then((r) => r[0].r);
const orders = () => count(`select count(*) n from orders where user_id = '${BUYER}'`);

console.log('\n-- the buyer must pick the server, from the offered ones, and nothing else');
const before = await orders();
await rejects('no server: "server_required", nothing created', 'authenticated', BUYER, `select checkout_gift($1, 'gift', $2)`, /server_required/, [O, FRIEND]);
await rejects('a server that is not offered: "gift_fields_invalid"', 'authenticated', BUYER, `select checkout_gift($1, 'gift', $2, '{"server":"mars"}'::jsonb)`, /gift_fields_invalid/, [O, FRIEND]);
await rejects('the player ID from the buyer: refused (the recipient types it)', 'authenticated', BUYER, `select checkout_gift($1, 'gift', $2, '{"server":"eu","player_id":"123"}'::jsonb)`, /gift_fields_invalid/, [O, FRIEND]);
await rejects('an unknown key: refused', 'authenticated', BUYER, `select checkout_gift($1, 'gift', $2, '{"server":"eu","x":"1"}'::jsonb)`, /gift_fields_invalid/, [O, FRIEND]);
ok('...and none of those created an order', (await orders()) === before);

console.log('\n-- a gift with the server chosen');
const g = await buy(O, 'gift', FRIEND, { server: 'eu' });
ok('paid from the wallet, a gift made', g.paid === true && typeof g.gift_id === 'string');
ok('the order keeps the choice', (await one(`select gift_fields from orders where id = $1`, [g.order_id])).gift_fields.server === 'eu');
ok('the gift carries it', (await one(`select preset_fields from gifts where id = $1`, [g.gift_id])).preset_fields.server === 'eu');
const vault = (await rows('authenticated', FRIEND, `select my_vault_gifts() v`))[0].v.find((x) => x.id === g.gift_id);
ok("the recipient's vault shows it (the claim card asks only for the rest)", vault.preset_fields.server === 'eu');
await rejects('the choice cannot be changed afterwards (gift)', 'postgres', null, `update gifts set preset_fields = '{"server":"asia"}' where id = '${g.gift_id}'`, /gift_locked/);
await rejects('...nor on the order', 'postgres', null, `update orders set gift_fields = '{"server":"asia"}' where id = '${g.order_id}'`, /gift_order_locked/);

console.log('\n-- the recipient types only their ID; the buyer\'s server always wins');
await rows('authenticated', FRIEND, `select * from claim_gift($1, '{"player_id":"55555","server":"asia"}'::jsonb)`, [g.gift_id]);
const d = await one(`select delivery from orders where gift_id = $1`, [g.gift_id]);
ok('delivered with the recipient\'s ID and the BUYER\'s server (their "asia" was overruled)', d.delivery.fields.player_id === '55555' && d.delivery.fields.server === 'eu', JSON.stringify(d.delivery));
const g2 = await buy(O, 'gift', FRIEND, { server: 'asia' });
await rows('authenticated', FRIEND, `select * from claim_gift($1, '{"player_id":"777"}'::jsonb)`, [g2.gift_id]);
ok('the ID alone is enough: the server comes from the gift', (await one(`select delivery from orders where gift_id = $1`, [g2.gift_id])).delivery.fields.server === 'asia');

console.log('\n-- a redeem code carries the choice to whoever redeems it');
const c = await buy(O, 'redeem_code', null, { server: 'eu' });
const r = (await rows('authenticated', OTHER, `select redeem_code($1) r`, [c.code]))[0].r;
ok('the gift made from the code has the buyer\'s server', (await one(`select preset_fields from gifts where id = $1`, [r.gift_id])).preset_fields.server === 'eu');

console.log('\n-- packs without a dropdown are unchanged');
const plain = (await rows('authenticated', BUYER, `select checkout_gift($1, 'gift', $2) r`, [O2, FRIEND]))[0].r;
ok('the three-argument call still works (older app versions)', plain.paid === true);
ok('...with nothing preset', (await one(`select preset_fields from gifts where id = $1`, [plain.gift_id])).preset_fields && Object.keys((await one(`select preset_fields from gifts where id = $1`, [plain.gift_id])).preset_fields).length === 0);
ok('only one checkout_gift exists (the old 3-argument one was dropped, no ambiguous overload)', (await count(`select count(*) n from pg_proc where proname = 'checkout_gift'`)) === 1);

console.log('\n-- the admin queue\'s customer join (orders has two links to profiles now)');
const fks = (await db.query(`select conname from pg_constraint where conrelid = 'public.orders'::regclass and confrelid = 'public.profiles'::regclass and contype = 'f'`)).rows.map((x) => x.conname).sort();
ok('orders -> profiles has more than one link, so an unqualified embed is ambiguous', fks.length >= 2 && fks.includes('orders_user_id_fkey'), fks.join(' '));
const admin = fs.readFileSync(new URL('../../src/lib/admin.ts', import.meta.url), 'utf8');
ok("the queue names the link it means (profiles!user_id), and no orders query embeds profiles unqualified", /profiles!user_id \(/.test(admin) && !/[,\s]profiles \(/.test(admin));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
