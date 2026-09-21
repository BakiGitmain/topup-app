// Per-package region lock (region_locked + account_region_codes) and the
// per-package supplier category guard. Migration 5.
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

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const A = (await db.query(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id;
const C = (await db.query(`insert into auth.users (email) values ('c@x.com') returning id`)).rows[0].id;
await db.exec(`update profiles set role='admin' where id='${C}'`);

const mk = async (sql) => (await rows('authenticated', C, sql))[0];
const P1 = await mk(`insert into products (slug,name,category,is_active) values ('ff','Free Fire','games',true) returning id`);
const P2 = await mk(`insert into products (slug,name,category,is_active) values ('mlbb','Mobile Legends','games',true) returning id`);
const opt = (pid, label, { active = false, locked = false, codes = `'{}'` } = {}) =>
  `insert into product_options (product_id,label,price,is_active,region_locked,account_region_codes) values ('${pid}','${label}',60,${active},${locked},${codes}) returning id, is_active, region_locked, account_region_codes`;

console.log('\n# defaults: existing and manual packages are untouched');
const plain = await mk(`insert into product_options (product_id,label,price,is_active) values ('${P1.id}','Manual pack',50,true) returning region_locked, account_region_codes, is_active`);
ok('a package that says nothing is NOT region-locked and stays live', plain.region_locked === false && plain.account_region_codes.length === 0 && plain.is_active === true);

console.log('\n# a locked package with unknown codes cannot go live');
const draft = await mk(opt(P1.id, 'Draft locked', { locked: true }));
ok('it CAN be saved as an inactive draft', draft.region_locked === true && draft.is_active === false);
await rejects('...but not switched on', 'authenticated', C, `update product_options set is_active = true where id='${draft.id}'`, /locked_needs_codes_to_be_live/);
await rejects('a new locked package with no codes cannot be inserted live', 'authenticated', C, opt(P1.id, 'Live locked', { active: true, locked: true }), /locked_needs_codes_to_be_live/);
await rejects('blank/whitespace-only codes do not count as known', 'authenticated', C, opt(P1.id, 'Blank', { active: true, locked: true, codes: `array['  ']` }), /region_codes_safe|locked_needs_codes/);
await as('authenticated', C, `update product_options set account_region_codes = array[' me '] where id='${draft.id}'`);
await as('authenticated', C, `update product_options set is_active = true where id='${draft.id}'`);
const live = (await rows('authenticated', C, `select is_active, region_locked, account_region_codes c from product_options where id='${draft.id}'`))[0];
ok('with codes it can go live, and the codes were normalized', live.is_active && live.region_locked && JSON.stringify(live.c) === '["ME"]', JSON.stringify(live));

console.log('\n# a live locked package cannot lose its codes or its lock inconsistently');
await rejects('clearing the codes on a live locked package is refused', 'authenticated', C, `update product_options set account_region_codes = '{}' where id='${draft.id}'`, /locked_needs_codes_to_be_live/);
await rejects('dropping the lock but keeping the codes is refused', 'authenticated', C, `update product_options set region_locked = false where id='${draft.id}'`, /codes_need_lock/);
await as('authenticated', C, `update product_options set region_locked = false, account_region_codes = '{}' where id='${draft.id}'`);
ok('an explicit "not region-locked" (lock off AND codes cleared) is allowed', true);
await as('authenticated', C, `update product_options set region_locked = true, account_region_codes = array['ME'] where id='${draft.id}'`);
await rejects('codes on a package that is not locked are refused', 'authenticated', C, opt(P1.id, 'Codes no lock', { locked: false, codes: `array['ME']` }), /codes_need_lock/);

console.log('\n# many packages, many products, may share a code (it is a property of the package)');
const d2 = await mk(opt(P1.id, 'Second ME pack', { active: true, locked: true, codes: `array['me']` }));
const d3 = await mk(opt(P1.id, 'BR pack', { active: true, locked: true, codes: `array['br','BR',' br']` }));
const d4 = await mk(opt(P2.id, 'Other product ME', { active: true, locked: true, codes: `array['ME']` }));
ok('two packages of one product can both serve ME', JSON.stringify(d2.account_region_codes) === '["ME"]');
ok('duplicates collapse', JSON.stringify(d3.account_region_codes) === '["BR"]', JSON.stringify(d3.account_region_codes));
ok('another product can serve ME too', JSON.stringify(d4.account_region_codes) === '["ME"]');
const multi = await mk(opt(P1.id, 'SEA pack', { active: true, locked: true, codes: `array['sg','my','ph']` }));
ok('one package can serve several account regions, sorted', JSON.stringify(multi.account_region_codes) === '["MY","PH","SG"]');

console.log('\n# only short plain codes');
for (const bad of [`array['has space']`, `array['a;drop']`, `array['${'x'.repeat(17)}']`, `array['<b>']`, `array[null]::text[]`]) {
  await rejects(`refused: ${bad.slice(0, 26)}`, 'authenticated', C, opt(P2.id, 'bad', { locked: true, codes: bad }), /region_codes_safe|check constraint|null/);
}

console.log('\n# customers');
const seen = (await rows('authenticated', A, `select region_locked, account_region_codes c from product_options where id='${d2.id}'`))[0];
ok('a customer can read the lock and codes of a live package', seen?.region_locked === true && JSON.stringify(seen.c) === '["ME"]', JSON.stringify(seen));
const r = await as('authenticated', A, `update product_options set account_region_codes = array['XX'] where id='${d2.id}'`);
ok('a customer cannot change the codes', r.affectedRows === 0);
const r2 = await as('authenticated', A, `update product_options set region_locked = false, account_region_codes = '{}' where id='${d2.id}'`);
ok('a customer cannot unlock a package', r2.affectedRows === 0);
await rejects('a customer cannot add a package', 'authenticated', A, opt(P2.id, 'evil'), /row-level security/);

console.log('\n# the lock is enforced at purchase: nothing can verify the account here, so it is refused');
await as('authenticated', C, `select admin_adjust_balance('${A}', 1000, 'seed')`);
const GC = await mk(`insert into products (slug,name,category,is_active) values ('gc-r','Gift','gift-cards',true) returning id`);
const RG = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${GC.id}','x','X','[]',true) returning id`);
const GO = await mk(`insert into product_options (product_id,label,price,region_id,is_active,region_locked,account_region_codes) values ('${GC.id}','Pack',100,'${RG.id}',true,true,array['ME']) returning id`);
await rejects('a locked package in a region that cannot validate IDs is refused', 'authenticated', A, `select * from purchase_product_option('${GO.id}', '{}')`, /region_unverifiable/);
ok('...and no money moved', Number((await rows('authenticated', A, `select balance from wallets`))[0].balance) === 1000);

console.log('\n# supplier category is per package: password-login categories are blocked there too');
const OS = await mk(opt(P1.id, 'Supplier pack'));
const link = (cat, ref) => `insert into product_option_supplier (option_id, family, category_id, offer_ref, supplier_offer_name) values ('${OS.id}','topups','${cat}','${ref}','110 Diamonds')`;
await as('authenticated', C, link('free_fire_mena', 'r1'));
ok('a normal category is accepted on a package', true);
await rejects('a listed password category is refused on a package', 'authenticated', C, `update product_option_supplier set category_id='genshin_impact_login' where option_id='${OS.id}'`, /blocked_supplier_category/);
const OS2 = await mk(opt(P1.id, 'Supplier pack 2'));
const link2 = (cat) => `insert into product_option_supplier (option_id, family, category_id, offer_ref, supplier_offer_name) values ('${OS2.id}','topups','${cat}','r2','x')`;
await rejects('...including on a fresh insert', 'authenticated', C, link2('tower_of_fantasy_login'), /blocked_supplier_category/);
await rejects('...and a brand-new *_login category nobody listed yet', 'authenticated', C, link2('some_new_game_login'), /blocked_supplier_category/);
await rejects('...and the mislabelled Mongil one', 'authenticated', C, link2('mongil_star_dive'), /blocked_supplier_category/);
await as('authenticated', C, link2('free_fire_bd'));
ok('a different, normal category on another package is fine', true);

console.log('\n# region-level supplier link: category is optional now, still guarded');
const RS = await mk(`insert into product_regions (product_id, code, label) values ('${P1.id}','mena','MENA') returning id`);
await as('authenticated', C, `insert into product_region_supplier (region_id, family, category_id, validation_category_id) values ('${RS.id}','topups',null,'free_fire')`);
ok('a region can be linked for validation only, with no purchase category', true);
const RS2 = await mk(`insert into product_regions (product_id, code, label) values ('${P1.id}','x2','X2') returning id`);
await rejects('a blocked category is still refused at region level', 'authenticated', C, `insert into product_region_supplier (region_id, family, category_id) values ('${RS2.id}','topups','genshin_impact_login')`, /blocked_supplier_category/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
