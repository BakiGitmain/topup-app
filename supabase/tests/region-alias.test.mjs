// The ID check returns "ME"; packs had been saved with "MENA". Account region aliases make both sides speak one vocabulary,
// so a real ME account can buy a MENA pack, and a BR account still cannot. Runs every migration.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const FILES = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
const MIGRATIONS = FILES.map((f) => read(`migrations/${f}`));
const ALIAS_MIGRATION = read('migrations/20260929090000_region_code_aliases.sql');

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

const mkUser = async (email) => (await one(`insert into auth.users (email) values ($1) returning id`, [email])).id;
const A = await mkUser('a@x.com'), B = await mkUser('b@x.com'), ADM = await mkUser('admin@x.com');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);

// Free Fire, MENA region, supplier-validated, with packs saved the way the live ones were: with the label "MENA".
const F1 = JSON.stringify([{ key: 'player_id', label: 'Player ID', type: 'text' }]);
const FF = (await one(`insert into products (slug,name,category,is_active) values ('ff','Free Fire','games',true) returning id`)).id;
const R = (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'mena','MENA',$2,'supplier',true) returning id`, [FF, F1])).id;
const pack = async (label, price, codes) => (await as('authenticated', ADM, `insert into product_options (product_id,label,price,region_id,is_active,region_locked,account_region_codes) values ($1,$2,$3,$4,true,true,$5) returning id, account_region_codes`, [FF, label, price, R, codes])).rows[0];
const P_MENA = await pack('110 Diamonds', 100, ['MENA']);
const P_MENA_LOWER = await pack('231 Diamonds', 200, [' mena ']);
const P_BOTH = await pack('583 Diamonds', 300, ['MENA', 'ME']);
const P_BR = await pack('BR only', 50, ['br']);

console.log('\n# the mapping table');
ok('it is seeded with ONE alias: MENA -> ME (the only one confirmed with real accounts)', JSON.stringify((await db.query(`select alias, code from account_region_aliases order by alias`)).rows) === JSON.stringify([{ alias: 'MENA', code: 'ME' }]));
for (const [input, want] of [['MENA', 'ME'], ['mena', 'ME'], [' Mena ', 'ME'], ['ME', 'ME'], ['me', 'ME'], ['BR', 'BR'], ['ind', 'IND'], ['LATAM', 'LATAM'], ['NA', 'NA'], [null, null]]) {
  const got = (await one(`select canonical_region_code($1) v`, [input])).v;
  ok(`canonical_region_code(${JSON.stringify(input)}) = ${JSON.stringify(want)}`, got === want, String(got));
}
ok('an unknown code is NOT guessed at: LATAM stays LATAM', (await one(`select canonical_region_code('LATAM') v`)).v === 'LATAM');

console.log('\n# packs saved with "MENA" are stored as "ME"');
ok('"MENA" -> ["ME"]', JSON.stringify(P_MENA.account_region_codes) === '["ME"]', JSON.stringify(P_MENA.account_region_codes));
ok('" mena " -> ["ME"]', JSON.stringify(P_MENA_LOWER.account_region_codes) === '["ME"]');
ok('["MENA","ME"] collapses to ["ME"]', JSON.stringify(P_BOTH.account_region_codes) === '["ME"]');
ok('other codes are untouched (br -> BR)', JSON.stringify(P_BR.account_region_codes) === '["BR"]');
await as('authenticated', ADM, `update product_options set account_region_codes = array['mena','br'] where id = $1`, [P_BR.id]);
ok('an admin edit later goes through the same mapping (mena,br -> BR,ME)', JSON.stringify((await one(`select account_region_codes c from product_options where id = $1`, [P_BR.id])).c) === '["BR","ME"]');
await as('authenticated', ADM, `update product_options set account_region_codes = array['br'] where id = $1`, [P_BR.id]);

console.log('\n# the ID check\'s answer is stored in the same vocabulary');
const record = async (user, fields, region) => (await as('service_role', null, `select * from record_id_validation($1,$2,$3::jsonb,$4,'Player')`, [user, R, JSON.stringify(fields), region])).rows[0];
const stored = async (id) => (await one(`select account_region r from id_validations where id = $1`, [id])).r;
ok('the supplier says ME -> stored ME', (await stored((await record(A, { player_id: '111' }, 'ME')).validation_id)) === 'ME');
ok('if a validator ever said MENA -> stored ME too', (await stored((await record(A, { player_id: '112' }, 'MENA')).validation_id)) === 'ME');
ok('BR stays BR; IND stays IND', (await stored((await record(A, { player_id: '113' }, 'BR')).validation_id)) === 'BR' && (await stored((await record(A, { player_id: '114' }, 'IND')).validation_id)) === 'IND');
ok('no region reported stays "none" (never guessed)', (await stored((await record(A, { player_id: '115' }, null)).validation_id)) === null);

console.log('\n# a real ME account can now BUY the MENA packs (the bug)');
await as('authenticated', ADM, `select admin_adjust_balance($1, 5000, 'seed')`, [A]);
await as('authenticated', ADM, `select admin_adjust_balance($1, 5000, 'seed')`, [B]);
const buy = (user, opt, id) => as('authenticated', user, `select * from purchase_product_option($1, $2::jsonb)`, [opt, JSON.stringify({ player_id: id })]);
const bal = async (u) => Number((await one(`select balance from wallets where user_id = $1`, [u])).balance);
await record(A, { player_id: '111' }, 'ME');
const order = (await buy(A, P_MENA.id, '111')).rows[0];
ok('an ME account buys the pack that was saved as "MENA"', order && order.status === 'pending' && Number(order.amount) === 100, JSON.stringify(order));
ok('...and the order records the validated region', (await one(`select validated_account_region r from orders where id = $1`, [order.id])).r === 'ME');
await record(A, { player_id: '111' }, 'ME');
ok('the other MENA-typed packs sell too', (await buy(A, P_MENA_LOWER.id, '111')).rows.length === 1 && (await buy(A, P_BOTH.id, '111')).rows.length === 1);

console.log('\n# ...and the lock still protects: other regions are refused');
for (const [region, id] of [['BR', '221'], ['ID', '222'], ['IND', '223']]) {
  await record(B, { player_id: id }, region);
  const before = await bal(B);
  await rejects(`a ${region} account cannot buy a MENA pack`, 'authenticated', B, `select * from purchase_product_option('${P_MENA.id}', '${JSON.stringify({ player_id: id })}'::jsonb)`, /region_mismatch/);
  ok(`   ...no money moved (${region})`, (await bal(B)) === before);
}
await record(B, { player_id: '224' }, null);
await rejects('an account with NO region reported still cannot buy a locked pack', 'authenticated', B, `select * from purchase_product_option('${P_MENA.id}', '{"player_id":"224"}'::jsonb)`, /region_unverified/);
await record(B, { player_id: '225' }, 'BR');
ok('a BR account buys a pack that serves BR', (await buy(B, P_BR.id, '225')).rows.length === 1);

console.log('\n# checkout (cart) uses the same rule');
{
  await db.exec(`delete from cart_items`);
  await record(A, { player_id: '111' }, 'ME');
  await as('authenticated', A, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,1,'{"player_id":"111"}'::jsonb,false)`, [A, P_MENA.id]);
  const c = (await as('authenticated', A, `select checkout_cart() r`)).rows[0].r;
  ok('an ME account checks out a MENA pack', c.order_id && c.paid === true, JSON.stringify(c));
  await db.exec(`delete from cart_items`);
  await record(B, { player_id: '226' }, 'ID');
  await as('authenticated', B, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,1,'{"player_id":"226"}'::jsonb,false)`, [B, P_MENA.id]);
  let err = null;
  try { await as('authenticated', B, `select checkout_cart()`); } catch (e) { err = e; }
  ok('an ID account is refused at checkout, naming the problem', err && /cart_unavailable/.test(err.message) && /region_mismatch/.test(err.detail ?? ''), err?.message + ' ' + (err?.detail ?? ''));
  await db.exec(`delete from cart_items`);
}

console.log('\n# existing data: packs saved with the label get fixed by the migration');
await db.exec(`alter table product_options disable trigger product_options_region_codes_normalize`);
const legacy = (await one(`insert into product_options (product_id,label,price,region_id,is_active,region_locked,account_region_codes) values ($1,'Legacy pack',10,$2,true,true,array['MENA']) returning id, account_region_codes`, [FF, R]));
await db.exec(`alter table product_options enable trigger product_options_region_codes_normalize`);
ok('(setup) a legacy row really holds "MENA"', JSON.stringify(legacy.account_region_codes) === '["MENA"]');
await db.exec(ALIAS_MIGRATION);
ok('re-running the migration fixes it to ["ME"]', JSON.stringify((await one(`select account_region_codes c from product_options where id = $1`, [legacy.id])).c) === '["ME"]');
ok('...and did not touch the packs that were already right', JSON.stringify((await one(`select account_region_codes c from product_options where id = $1`, [P_BR.id])).c) === '["BR"]');

console.log('\n# the alias table itself');
ok('a customer can read it', (await rows('authenticated', A, `select alias from account_region_aliases`)).length === 1);
await rejects('a customer cannot add an alias', 'authenticated', A, `insert into account_region_aliases (alias, code) values ('LATAM','BR')`, /row-level security/);
{
  const r = await as('authenticated', A, `update account_region_aliases set code = 'XX' where alias = 'MENA'`);
  ok('...(an update by a customer changes nothing)', r.affectedRows === 0 && (await one(`select code from account_region_aliases where alias = 'MENA'`)).code === 'ME');
}
await rejects('anonymous cannot read it', 'anon', null, `select * from account_region_aliases`, /permission denied/);
await as('authenticated', ADM, `insert into account_region_aliases (alias, code) values ('MIDDLE_EAST','ME')`);
ok('an admin can add one', (await one(`select canonical_region_code('middle_east') v`)).v === 'ME');
await rejects('no chains: an alias cannot point at another alias', 'authenticated', ADM, `insert into account_region_aliases (alias, code) values ('X1','MENA')`, /region_alias_chain/);
await rejects('no chains: a code that is already an alias target cannot itself become an alias', 'authenticated', ADM, `insert into account_region_aliases (alias, code) values ('ME','XX')`, /region_alias_chain/);
await rejects('an alias cannot equal its code', 'authenticated', ADM, `insert into account_region_aliases (alias, code) values ('BR','BR')`, /not_self|check constraint/);
await rejects('an alias must be a short plain code', 'authenticated', ADM, `insert into account_region_aliases (alias, code) values ('has space','ME')`, /check constraint/);
await db.exec(`delete from account_region_aliases where alias = 'MIDDLE_EAST'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
