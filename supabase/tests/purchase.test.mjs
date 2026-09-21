// Multi-field buyer IDs (server-side validation), the legacy single-ID path, and the data-layer guards.
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

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable
await db.exec(SEED);

const A = (await db.query(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id; // customer
const C = (await db.query(`insert into auth.users (email) values ('c@x.com') returning id`)).rows[0].id; // admin
await db.exec(`update profiles set role='admin' where id='${C}'`);
await as('authenticated', C, `select admin_adjust_balance('${A}', 100000, 'seed')`);

const bal = async () => Number((await rows('authenticated', A, `select balance from wallets`))[0].balance);
const orderCount = async () => (await rows('authenticated', A, `select count(*)::int c from orders`))[0].c;
const buy = (opt, delivery, checked = true) => as('authenticated', A, `select * from purchase_product_option('${opt}', '${JSON.stringify(delivery).replace(/'/g, "''")}'::jsonb, ${checked})`);

// ---- catalog fixtures (as the admin)
const mk = async (sql) => (await rows('authenticated', C, sql))[0];
const MLBB = await mk(`insert into products (slug,name,category,is_active) values ('mlbb-t','Mobile Legends','games',true) returning id`);
const F2 = JSON.stringify([
  { key: 'player_id', label: 'User ID', type: 'text' },
  { key: 'server_id', label: 'Zone ID', type: 'text' },
]);
const R2 = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${MLBB.id}','global','Global','${F2}',true) returning id`);
const O2 = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${MLBB.id}','86 Diamonds',60,'${R2.id}',true) returning id`);

const FF = await mk(`insert into products (slug,name,category,is_active) values ('ff-t','Free Fire','games',true) returning id`);
const F1 = JSON.stringify([{ key: 'player_id', label: 'Player ID', type: 'text' }]);
const R1 = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${FF.id}','bd','BD','${F1}',true) returning id`);
const O1 = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${FF.id}','25 Diamonds',20,'${R1.id}',true) returning id`);

const GEN = await mk(`insert into products (slug,name,category,is_active) values ('gen-t','Some Game','games',true) returning id`);
const FS = JSON.stringify([
  { key: 'user_id', label: 'User ID', type: 'text' },
  { key: 'server', label: 'Server', type: 'select', options: [{ label: 'Asia', value: 'Asia' }, { label: 'Europe', value: 'Europe' }] },
]);
const R3 = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${GEN.id}','sea','SEA','${FS}',true) returning id`);
const O3 = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${GEN.id}','60 Gems',30,'${R3.id}',true) returning id`);

const NOF = await mk(`insert into products (slug,name,category,is_active) values ('nof-t','No Fields Game','games',true) returning id`);
const R4 = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${NOF.id}','all','All','[]',true) returning id`);
const O4 = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${NOF.id}','Pack',10,'${R4.id}',true) returning id`);

const GC = await mk(`insert into products (slug,name,category,is_active) values ('gc-t','Some Gift Card','gift-cards',true) returning id`);
const R5 = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${GC.id}','eur','EUR','[]',true) returning id`);
const O5 = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${GC.id}','10 EUR',700,'${R5.id}',true) returning id`);

const R6 = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${FF.id}','off','Off region','${F1}',false) returning id`);
const O6 = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${FF.id}','5 Diamonds',5,'${R6.id}',true) returning id`);

console.log('\n# LEGACY path: packages without a region behave exactly as before');
const legacyOpt = (await db.query(`select o.id from product_options o join products p on p.id=o.product_id where p.slug='freefire' and o.label='100 Diamonds'`)).rows[0].id;
{
  const start = await bal();
  const o = (await buy(legacyOpt, { account_id: ' 123456789 ', evil: 'x', role: 'admin' })).rows[0];
  ok('single account_id accepted and trimmed, junk keys stripped', JSON.stringify(o.delivery) === '{"account_id": "123456789"}' || JSON.stringify(o.delivery) === '{"account_id":"123456789"}', JSON.stringify(o.delivery));
  ok('no region label on a legacy order', o.region_label === null);
  ok('charged the server-side price (Br 55)', (await bal()) === start - 55);
}
await rejects('legacy: game ID still required', 'authenticated', A, `select * from purchase_product_option('${legacyOpt}', '{}')`, /account_id_required/);
await rejects('legacy: huge ID still rejected', 'authenticated', A, `select * from purchase_product_option('${legacyOpt}', '{"account_id":"${'9'.repeat(65)}"}')`, /account_id_invalid/);
{
  const gift = (await db.query(`select o.id from product_options o join products p on p.id=o.product_id where p.slug='google-play' and o.label='Br 250 card'`)).rows[0].id;
  const o = (await buy(gift, {})).rows[0];
  ok('legacy gift card: no ID needed', o.fulfillment === 'code' && JSON.stringify(o.delivery).replace(/\s/g, '') === '{}');
}

console.log('\n# MULTI-FIELD path: a region declares the form, the server enforces it');
{
  const start = await bal(); const n = await orderCount();
  const o = (await buy(O2.id, { player_id: ' 123456 ', server_id: '2214' })).rows[0];
  ok('valid two-field call stored as JSONB under "fields", trimmed', JSON.stringify(o.delivery.fields) === '{"player_id":"123456","server_id":"2214"}' || (o.delivery.fields.player_id === '123456' && o.delivery.fields.server_id === '2214' && Object.keys(o.delivery.fields).length === 2), JSON.stringify(o.delivery));
  ok('account_id mirrors the first declared field (old screens keep working)', o.delivery.account_id === '123456');
  ok('the region label is snapshotted on the order', o.region_label === 'Global');
  ok('charged once, at the server price', (await bal()) === start - 60 && (await orderCount()) === n + 1);
  ok('the customer can read their own fields back', (await rows('authenticated', A, `select delivery -> 'fields' ->> 'server_id' s from orders where id='${o.id}'`))[0].s === '2214');
}
const noChange = async (name, opt, delivery, re) => {
  const start = await bal(); const n = await orderCount();
  await rejects(name, 'authenticated', A, `select * from purchase_product_option('${opt}', '${JSON.stringify(delivery).replace(/'/g, "''")}'::jsonb, true)`, re);
  ok(`  ...and nothing was charged or created`, (await bal()) === start && (await orderCount()) === n);
};
await noChange('unknown key is rejected', O2.id, { player_id: '1', server_id: '2', hacker: 'x' }, /buyer_field_unknown/);
await noChange('the old key on a two-field region is rejected (not silently mapped)', O2.id, { account_id: '1' }, /buyer_field_unknown/);
await noChange('missing required field is rejected', O2.id, { player_id: '1' }, /buyer_field_required/);
await noChange('empty call is rejected', O2.id, {}, /buyer_field_required/);
await noChange('blank value is rejected', O2.id, { player_id: '1', server_id: '' }, /buyer_field_required/);
await noChange('whitespace-only value is rejected', O2.id, { player_id: '   ', server_id: '2' }, /buyer_field_required/);
await noChange('null value is rejected', O2.id, { player_id: '1', server_id: null }, /buyer_field_required/);
await noChange('object value is rejected', O2.id, { player_id: { a: 1 }, server_id: '2' }, /buyer_field_required/);
await noChange('array value is rejected', O2.id, { player_id: ['1'], server_id: '2' }, /buyer_field_required/);
await noChange('129-char value is rejected', O2.id, { player_id: '9'.repeat(129), server_id: '2' }, /buyer_field_invalid/);
{
  const o = (await buy(O2.id, { player_id: 123456, server_id: 2214 })).rows[0];
  ok('a JSON number is accepted and stored as text', o.delivery.fields.player_id === '123456');
}
await rejects('non-object delivery (array) is treated as empty, so required fails', 'authenticated', A, `select * from purchase_product_option('${O2.id}', '["1","2"]'::jsonb)`, /buyer_field_required/);
await rejects('non-object delivery (string) is treated as empty, so required fails', 'authenticated', A, `select * from purchase_product_option('${O2.id}', '"abc"'::jsonb)`, /buyer_field_required/);

console.log('\n# dropdown fields');
{
  const o = (await buy(O3.id, { user_id: '77', server: 'Europe' })).rows[0];
  ok('a declared dropdown value is accepted', o.delivery.fields.server === 'Europe' && o.delivery.account_id === '77');
}
await noChange('a value that is not in the dropdown is rejected', O3.id, { user_id: '77', server: 'Mars' }, /buyer_field_invalid/);
await noChange('dropdown matching is exact (case)', O3.id, { user_id: '77', server: 'europe' }, /buyer_field_invalid/);

console.log('\n# legacy single-ID call onto a ONE-field region still works');
{
  const o = (await buy(O1.id, { account_id: '555000' })).rows[0];
  ok('{"account_id"} is mapped onto the single declared field', o.delivery.fields.player_id === '555000' && o.delivery.account_id === '555000' && o.region_label === 'BD', JSON.stringify(o.delivery));
  const o2 = (await buy(O1.id, { player_id: '777' })).rows[0];
  ok('the new-style call for the same region works too', o2.delivery.fields.player_id === '777');
}
await noChange('one-field region: extra unknown key next to account_id is rejected', O1.id, { account_id: '1', extra: 'x' }, /buyer_field_unknown/);

console.log('\n# regions with no fields, gift cards, and switched-off regions');
{
  const o = (await buy(O4.id, {})).rows[0];
  ok('a region with zero declared fields accepts {}', JSON.stringify(o.delivery.fields) === '{}' && o.delivery.account_id === undefined);
  const g = (await buy(O5.id, {})).rows[0];
  ok('a gift card region needs no ID', g.fulfillment === 'code' && g.region_label === 'EUR');
}
await noChange('a region with zero fields still rejects unknown keys', O4.id, { anything: '1' }, /buyer_field_unknown/);
await noChange('a package in a switched-off region cannot be bought', O6.id, { player_id: '1' }, /option_unavailable/);

console.log('\n# money safety');
{
  await as('authenticated', C, `select admin_adjust_balance('${A}', -${await bal()}, 'drain')`);
  await as('authenticated', C, `select admin_adjust_balance('${A}', 10, 'tiny')`);
  await noChange('not enough balance on the multi-field path', O2.id, { player_id: '1', server_id: '2' }, /insufficient_balance/);
  await as('authenticated', C, `select admin_adjust_balance('${A}', 100000, 'refill')`);
}
{
  const r = await db.query(`select w.balance::float b, coalesce(sum(t.amount),0)::float s from wallets w left join wallet_transactions t on t.user_id=w.user_id group by w.user_id, w.balance`);
  ok('every wallet still equals its ledger', r.rows.every((x) => x.b === x.s), JSON.stringify(r.rows));
}

console.log('\n# GUARD: we never collect game passwords');
const region = (fields) => `insert into product_regions (product_id, code, label, buyer_fields) values ('${MLBB.id}','g${Math.random().toString(36).slice(2, 7)}','x','${JSON.stringify(fields).replace(/'/g, "''")}')`;
await rejects('a "password" field cannot exist (by key)', 'authenticated', C, region([{ key: 'password', label: 'Password', type: 'text' }]), /buyer_fields_safe|check constraint/);
await rejects('a secret hidden behind an innocent KEY but labelled "Password" (the Mongil shape)', 'authenticated', C, region([{ key: 'user_id', label: 'Email', type: 'text' }, { key: 'server_id', label: 'Password', type: 'text' }]), /buyer_fields_safe|check constraint/);
await rejects('a "Game Password" label is caught', 'authenticated', C, region([{ key: 'pw', label: 'Game Password', type: 'text' }]), /buyer_fields_safe|check constraint/);
await rejects('key "passcode" is caught', 'authenticated', C, region([{ key: 'passcode', label: 'Code', type: 'text' }]), /buyer_fields_safe|check constraint/);
await rejects('key "account_pin" is caught', 'authenticated', C, region([{ key: 'account_pin', label: 'PIN', type: 'text' }]), /buyer_fields_safe|check constraint/);
await rejects('an "OTP" label is caught', 'authenticated', C, region([{ key: 'code', label: 'OTP code', type: 'text' }]), /buyer_fields_safe|check constraint/);
await rejects('a field type "password" is not allowed', 'authenticated', C, region([{ key: 'x', label: 'X', type: 'password' }]), /buyer_fields_safe|check constraint/);
await rejects('buyer_fields must be an array', 'authenticated', C, `insert into product_regions (product_id, code, label, buyer_fields) values ('${MLBB.id}','obj','x','{"key":"a"}')`, /buyer_fields_safe|check constraint/);
await rejects('an unsafe form cannot be slipped in by UPDATE either', 'authenticated', C, `update product_regions set buyer_fields = '[{"key":"password","label":"Password","type":"text"}]' where id='${R1.id}'`, /buyer_fields_safe|check constraint/);
for (const [name, f] of [
  ['user_id + server dropdown', FS],
  ['player_id + server_id', F2],
  ['riot id', JSON.stringify([{ key: 'riot_id', label: 'Riot ID', type: 'text' }])],
  ['an email WITHOUT a password is fine', JSON.stringify([{ key: 'email', label: 'Email', type: 'text' }])],
  ['"Passport" is not a password', JSON.stringify([{ key: 'passport_no', label: 'Passport number', type: 'text' }])],
]) {
  const r = await as('authenticated', C, region(JSON.parse(f)) + ' returning id');
  ok(`legitimate form accepted: ${name}`, r.rows.length === 1);
}

console.log('\n# GUARD: blocked supplier categories cannot be linked to a region');
const link = (cat, extra = '') => `insert into product_region_supplier (region_id, family, category_id${extra ? ', validation_category_id' : ''}) values ('${R1.id}','topups','${cat}'${extra ? `,'${extra}'` : ''})`;
for (const id of ['genshin_impact_login', 'tower_of_fantasy_login', 'love_and_deepspace_login', 'mongil_star_dive', 'arknight_endfield_login', 'neverness_to_everness_login', 'solo_leveling_arise_login']) {
  await rejects(`blocked: ${id}`, 'authenticated', C, link(id), /blocked_supplier_category/);
}
await rejects('a FUTURE login-style category is caught by pattern', 'authenticated', C, link('some_new_game_login'), /blocked_supplier_category/);
await rejects('login-style with an infix is caught too', 'authenticated', C, link('some_login_v2'), /blocked_supplier_category/);
await as('authenticated', C, link('free_fire_bd', 'free_fire'));
ok('a normal category links fine', (await rows('authenticated', C, `select count(*)::int c from product_region_supplier`))[0].c === 1);
await rejects('changing an existing link to a blocked category is refused too', 'authenticated', C, `update product_region_supplier set category_id = 'genshin_impact_login' where region_id='${R1.id}'`, /blocked_supplier_category/);
ok('login is not matched inside ordinary words ("blogin" style)', (await db.query(`select ('cyclogin_x' ~* '(^|_)login($|_)') m`)).rows[0].m === false);
ok('a customer cannot read the blocklist', (await rows('authenticated', A, `select * from blocked_supplier_categories`)).length === 0);
ok('an admin can read the blocklist (7 entries)', (await rows('authenticated', C, `select * from blocked_supplier_categories`)).length === 7);

console.log('\n# GUARD: offers that only work once per account cannot be imported');
let n = 0;
const freshOption = async () => (await mk(`insert into product_options (product_id,label,price) values ('${FF.id}','imp-${++n}',99) returning id`)).id;
const insertOffer = (optionId, name) => `insert into product_option_supplier (option_id, family, category_id, offer_ref, supplier_offer_name) values ('${optionId}','topups','cat','ref-${n}',$$${name}$$)`;
const importOffer = async (name) => { const id = await freshOption(); await as('authenticated', C, insertOffer(id, name)); return id; };
const importOfferReject = async (name) => rejects(`blocked: ${name}`, 'authenticated', C, insertOffer(await freshOption(), name), /first_purchase_only_not_sellable/);
for (const name of [
  '250 (FIRST PURCHASE ONLY)', '50 + 50 Diamonds (First Top-Up Bonus)', 'First Recharge 100 (100 + 50 Bonus)',
  'Takoyaki First Purchase Pack', 'Perk Subscription (First-time buy at half price)', 'First Purchase Pack', '1st recharge 50', 'first top up bonus',
]) await importOfferReject(name);
{
  const safe = await importOffer('25 Diamonds');
  await rejects('renaming an imported offer to a first-purchase one is refused', 'authenticated', C, `update product_option_supplier set supplier_offer_name = 'X (FIRST PURCHASE ONLY)' where option_id='${safe}'`, /first_purchase_only_not_sellable/);
}
for (const name of ['Weekly Membership', 'First Blood Pack', 'Firstborn Crystals 60', '1st Place Trophy Pack', 'Top-Up Bonus 50', 'Monthly Card', 'Level Up Package - Level 6']) {
  await importOffer(name);
  ok(`allowed: ${name}`, true);
}



console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
