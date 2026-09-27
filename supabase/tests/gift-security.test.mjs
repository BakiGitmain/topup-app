// Gifts part 4 (20261019090000): the security pass. Who can call and read what (every gift function and table, found
// by reading the gift migrations, so a function added later is covered without editing this file), SECURITY DEFINER
// functions pinned to a search_path, the sender's privacy, and codes without look-alike characters. The same
// permission checks against the LIVE project: scripts/gift-security-audit.sql.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const FILES = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
const MIGRATIONS = FILES.map((f) => read(`migrations/${f}`));
const GIFT_FILES = FILES.filter((f) => /_(gifts_and_redeem_codes|gift_checkout|gift_delivery|gift_hardening|gift_server_choice)\.sql$/.test(f));

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

// ------------------------------------------------------------------ who may call what
console.log('\n-- every gift function: callable only by the role it is meant for');
const GIFT_FUNCTIONS = [...new Set(GIFT_FILES.flatMap((f) => [...read(`migrations/${f}`).matchAll(/create (?:or replace )?function public\.(\w+)\s*\(/g)].map((m) => m[1])))].sort();
// What a signed-in customer calls from the app. Everything else is internal (called by other functions or triggers),
// except the expiry sweep, which only the server (service_role) runs.
const CUSTOMER = new Set(['checkout_gift', 'claim_gift', 'find_recipient_by_email', 'gift_order_summary', 'my_redeem_codes', 'my_vault_gifts', 'redeem_code']);
const SERVER = new Set(['expire_gifts_and_codes']);
ok(`found the gift functions by reading ${GIFT_FILES.length} migrations`, GIFT_FILES.length === 5 && GIFT_FUNCTIONS.length >= 20 && [...CUSTOMER, ...SERVER].every((f) => GIFT_FUNCTIONS.includes(f)), GIFT_FUNCTIONS.join(' '));
const privs = (await db.query(`
  select p.proname, pg_get_function_identity_arguments(p.oid) args,
         has_function_privilege('anon', p.oid, 'execute') anon,
         has_function_privilege('authenticated', p.oid, 'execute') authed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any($1)`, [GIFT_FUNCTIONS])).rows;
ok('every one of them exists in the database (no stale name in a migration)', GIFT_FUNCTIONS.every((f) => privs.some((p) => p.proname === f)), GIFT_FUNCTIONS.filter((f) => !privs.some((p) => p.proname === f)).join(' '));
const anonCan = privs.filter((p) => p.anon);
ok('signed out (anon): NOT ONE gift function is callable', anonCan.length === 0, anonCan.map((p) => p.proname).join(' '));
const wrongAuthed = privs.filter((p) => p.authed !== CUSTOMER.has(p.proname));
ok('signed in: exactly the 7 customer functions are callable, every internal one is not', wrongAuthed.length === 0, wrongAuthed.map((p) => `${p.proname}(${p.args})=${p.authed}`).join(' '));
ok('the expiry sweep is the server\'s alone', (await one(`select has_function_privilege('service_role', 'public.expire_gifts_and_codes()', 'execute') s`)).s === true);

console.log('\n-- SECURITY DEFINER functions cannot be hijacked through search_path');
const unpinned = (await db.query(`
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`)).rows.map((r) => r.proname);
ok('every SECURITY DEFINER function in the schema pins its search_path (not only the gift ones)', unpinned.length === 0, unpinned.join(' '));

// ------------------------------------------------------------------ who may read/write what
console.log('\n-- gift tables: read-only for customers (RLS-scoped), nothing for anyone signed out');
const TABLES = ['gifts', 'redeem_codes', 'redeem_code_attempts', 'email_lookup_attempts'];
for (const t of TABLES) {
  const r = await one(`select c.relrowsecurity rls,
      has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete') anon_any,
      has_table_privilege('authenticated', c.oid, 'select') a_sel,
      has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate') a_write
    from pg_class c where c.oid = ('public.' || $1)::regclass`, [t]);
  const readable = t === 'gifts' || t === 'redeem_codes';
  ok(`${t}: RLS on, anon nothing, customers ${readable ? 'SELECT only' : 'nothing at all'}`, r.rls && !r.anon_any && r.a_sel === readable && !r.a_write, JSON.stringify(r));
}
const ordersWrite = await one(`select has_table_privilege('authenticated', 'public.orders', 'update') u, has_table_privilege('authenticated', 'public.orders', 'insert') i`);
ok("orders: customers can't write it at all, so gift_kind / gift_recipient_id / gift_id can't be forged", !ordersWrite.u && !ordersWrite.i);

// ------------------------------------------------------------------ fixtures
const mkUser = async (email, name) => (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
const BUYER = await mkUser('abel.secret@x.com', 'Abel'), FRIEND = await mkUser('friend@x.com', 'Bruk'), STRANGER = await mkUser('stranger@x.com', 'Chala'), ADM = await mkUser('admin@x.com', 'Boss');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await db.exec(`update profiles set avatar_url='https://x/abel.png' where id='${BUYER}'`);
await as('authenticated', ADM, `select admin_adjust_balance($1, 5000, 'funds')`, [BUYER]);
const P = (await one(`insert into products (slug, name, category, is_active) values ('roblox','Roblox','gift-cards',true) returning id`)).id;
const R = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'gl','Global','[]'::jsonb,'none',true) returning id`, [P])).id;
const O = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'800 Robux',300,true) returning id`, [P, R])).id;
const buy = async (kind, to = null) => (await rows('authenticated', BUYER, `select checkout_gift($1, $2, $3) r`, [O, kind, to]))[0].r;
const redeem = async (uid, c) => (await rows('authenticated', uid, `select redeem_code($1) r`, [c]))[0].r;
const vaultOf = async (uid) => (await rows('authenticated', uid, `select my_vault_gifts() v`))[0].v;

// ------------------------------------------------------------------ sender privacy
console.log("\n-- a code's buyer stays anonymous to whoever redeems it");
const c1 = await buy('redeem_code');
const r1 = await redeem(STRANGER, c1.code);
const strangerVault = await vaultOf(STRANGER);
const fromCode = strangerVault.find((g) => g.id === r1.gift_id);
ok('the redeemed gift is in the stranger\'s vault, marked as from a code', fromCode && fromCode.from_code === true);
ok('...with no sender name and no sender picture', fromCode && fromCode.sender_name === null && fromCode.sender_avatar === null, JSON.stringify(fromCode));
const wire = JSON.stringify(strangerVault);
ok("...and nothing of the buyer anywhere in the reply: not the name, the picture, or the email", !/\bAbel\b|abel\.png|abel\.secret/.test(wire), wire.slice(0, 200));
ok("...and the gift row the stranger can read has no display data either (sender_id only, profiles are private)", (await rows('authenticated', STRANGER, `select p.* from profiles p join gifts g on g.sender_id = p.id where g.id = $1`, [r1.gift_id])).length === 0);

console.log('\n-- a direct gift shows its sender by name, never by email');
const g1 = await buy('gift', FRIEND);
ok('the friend sees "Abel" and the picture', (await vaultOf(FRIEND)).some((g) => g.id === g1.gift_id && g.sender_name === 'Abel' && g.sender_avatar === 'https://x/abel.png'));
await db.exec(`update profiles set display_name = '' where id = '${BUYER}'`);
const noName = (await vaultOf(FRIEND)).find((g) => g.id === g1.gift_id);
ok('a sender with no name set: "Portal user", never a piece of the email', noName.sender_name === 'Portal user' && !JSON.stringify(noName).includes('abel.secret'), noName.sender_name);
await db.exec(`update profiles set display_name = 'Abel' where id = '${BUYER}'`);

// ------------------------------------------------------------------ unambiguous codes
console.log('\n-- new codes never contain 0, O, 1 or I');
const N = 3200;
const codes = (await db.query(`select generate_redeem_code() c from generate_series(1, ${N})`)).rows.map((r) => r.c);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
ok('every code is 10 characters from the 32-character set', codes.every((c) => c.length === 10 && [...c].every((ch) => ALPHABET.includes(ch))), codes.find((c) => ![...c].every((ch) => ALPHABET.includes(ch))));
ok('...never a 0, O, 1 or I', codes.every((c) => !/[01IO]/.test(c)));
ok('...and still fit the column rule (^[A-Z0-9]{10}$)', codes.every((c) => /^[A-Z0-9]{10}$/.test(c)));
ok(`${N} codes, all different`, new Set(codes).size === N);
const freq = {}; for (const c of codes) for (const ch of c) freq[ch] = (freq[ch] ?? 0) + 1;
const expected = (N * 10) / 32;
ok('all 32 characters appear, each within 20% of an even share (no bias)', Object.keys(freq).length === 32 && Object.values(freq).every((n) => Math.abs(n - expected) / expected < 0.2), JSON.stringify(freq));
ok('the code bought just now uses the new set', /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{10}$/.test(c1.code), c1.code);

console.log('\n-- codes made before this change still redeem, however they are typed');
const c2 = await buy('redeem_code');
await db.exec(`set session_replication_role = replica; update redeem_codes set code = 'O0I1O0I1AB' where code = '${c2.code}'; set session_replication_role = origin;`);
ok('an old-style code with 0/O/1/I, typed lower-case with a dash and spaces, redeems', (await redeem(FRIEND, 'o0i1o-0i1 ab')).ok === true);

console.log('\n-- the constant helpers are internal');
await rejects('signed out: the rate limits are not readable', 'anon', null, `select * from redeem_limits()`, /permission denied/);
await rejects('signed in: the rate limits are not readable', 'authenticated', FRIEND, `select * from redeem_limits()`, /permission denied/);
ok('...but redeeming (which reads them, as the owner) still works', (await redeem(FRIEND, 'NOTACODE22')).error === 'invalid_code');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
