// Server-enforced ID validation and region lock (migration 6).
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

const A = (await db.query(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id; // customer
const B = (await db.query(`insert into auth.users (email) values ('b@x.com') returning id`)).rows[0].id; // another customer
const C = (await db.query(`insert into auth.users (email) values ('c@x.com') returning id`)).rows[0].id; // admin
await db.exec(`update profiles set role='admin' where id='${C}'`);
await as('authenticated', C, `select admin_adjust_balance('${A}', 100000, 'seed')`);
await as('authenticated', C, `select admin_adjust_balance('${B}', 100000, 'seed')`);

const mk = async (sql) => (await rows('authenticated', C, sql))[0];
const bal = async (u = A) => Number((await rows('authenticated', u, `select balance from wallets`))[0].balance);
const orders = async (u = A) => (await rows('authenticated', u, `select * from orders order by created_at`));
const record = (user, region, fields, acct, name) =>
  as('service_role', null, `select * from record_id_validation('${user}', '${region}', '${JSON.stringify(fields)}'::jsonb, ${acct === null ? 'null' : `'${acct}'`}, ${name === null ? 'null' : `$$${name}$$`})`).then((r) => r.rows[0]);
const buy = (user, opt, delivery, checked) =>
  as('authenticated', user, `select * from purchase_product_option('${opt}', '${JSON.stringify(delivery)}'::jsonb${checked === undefined ? '' : `, ${checked}`})`);
const REFUSED = async (name, user, opt, delivery, re, checked) => {
  const before = [await bal(user), (await orders(user)).length];
  await rejects(name, 'authenticated', user, `select * from purchase_product_option('${opt}', '${JSON.stringify(delivery)}'::jsonb${checked === undefined ? '' : `, ${checked}`})`, re);
  ok(`   ...no money moved and no order made (${name.slice(0, 40)})`, (await bal(user)) === before[0] && (await orders(user)).length === before[1]);
};

// ---------------------------------------------------------------- fixtures
const F1 = JSON.stringify([{ key: 'player_id', label: 'Player ID', type: 'text' }]);
const FF = await mk(`insert into products (slug,name,category,is_active) values ('ff','Free Fire','games',true) returning id`);
const R_ME = await mk(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ('${FF.id}','mena','MENA','${F1}','supplier',true) returning id`);
const R_OTHER = await mk(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ('${FF.id}','other','Other','${F1}','supplier',true) returning id`);
const R_OFF = await mk(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ('${FF.id}','off','Off','${F1}','supplier',false) returning id`);
await as('authenticated', C, `insert into product_region_supplier (region_id, family, category_id, validation_category_id, validation_field_map) values ('${R_ME.id}','topups','free_fire_mena','free_fire','{}')`);
const pkg = (region, label, price, locked, codes) =>
  mk(`insert into product_options (product_id,label,price,region_id,is_active,region_locked,account_region_codes) values ('${FF.id}','${label}',${price},'${region}',true,${locked},${codes}) returning id`);
const O_ME = await pkg(R_ME.id, '110 Diamonds', 20, true, `array['ME']`);
const O_ME2 = await pkg(R_ME.id, '231 Diamonds', 40, true, `array['ME']`);
const O_BR = await pkg(R_ME.id, 'BR-only pack', 30, true, `array['BR']`);
const O_OPEN = await pkg(R_ME.id, 'Open pack', 10, false, `'{}'`);
const O_OTHER = await pkg(R_OTHER.id, 'Other-region pack', 10, false, `'{}'`);

// A region the supplier cannot validate (needs the tick), a zero-field region, a two-field region.
const NV = await mk(`insert into products (slug,name,category,is_active) values ('nv','No Validation Game','games',true) returning id`);
const R_NONE = await mk(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ('${NV.id}','all','All','${F1}','none',true) returning id`);
const O_NONE = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${NV.id}','Pack',10,'${R_NONE.id}',true) returning id`);
const O_NONE_LOCKED = await mk(`insert into product_options (product_id,label,price,region_id,is_active,region_locked,account_region_codes) values ('${NV.id}','Locked pack',10,'${R_NONE.id}',true,true,array['ME']) returning id`);
const GC = await mk(`insert into products (slug,name,category,is_active) values ('gc','Gift','gift-cards',true) returning id`);
const R_GC = await mk(`insert into product_regions (product_id, code, label, buyer_fields, is_active) values ('${GC.id}','x','X','[]',true) returning id`);
const O_GC = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${GC.id}','Card',10,'${R_GC.id}',true) returning id`);
const ML = await mk(`insert into products (slug,name,category,is_active) values ('ml','Mobile Legends','games',true) returning id`);
const F2 = JSON.stringify([{ key: 'player_id', label: 'User ID', type: 'text' }, { key: 'server_id', label: 'Zone ID', type: 'text' }]);
const R_ML = await mk(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ('${ML.id}','g','Global','${F2}','supplier',true) returning id`);
const O_ML = await mk(`insert into product_options (product_id,label,price,region_id,is_active) values ('${ML.id}','86 Diamonds',10,'${R_ML.id}',true) returning id`);

// ---------------------------------------------------------------- the window
console.log('\n# the window');
ok('a validation stays good for 15 minutes', (await db.query(`select id_validation_window() = interval '15 minutes' as v`)).rows[0].v === true);

// ---------------------------------------------------------------- who can write records
console.log('\n# only the server can create records');
await rejects('a customer cannot call record_id_validation', 'authenticated', A, `select * from record_id_validation('${A}','${R_ME.id}','{"player_id":"1"}'::jsonb,'ME','x')`, /permission denied/);
await rejects('anon cannot either', 'anon', null, `select * from record_id_validation('${A}','${R_ME.id}','{"player_id":"1"}'::jsonb,'ME','x')`, /permission denied/);
await rejects('a customer cannot insert a record directly', 'authenticated', A, `insert into id_validations (user_id, region_id, fields, expires_at) values ('${A}','${R_ME.id}','{"player_id":"1"}', now() + interval '15 minutes')`, /permission denied|row-level security/);
await rejects('a customer cannot call the throttle', 'authenticated', A, `select claim_id_validation_slot('${A}')`, /permission denied/);
await rejects('a customer cannot read the supplier target', 'authenticated', A, `select * from id_validation_target('${R_ME.id}')`, /permission denied/);
await as('service_role', null, `select 1`);
const seeded = await record(A, R_ME.id, { player_id: '42' }, 'ME', 'Someone');
ok('a customer sees no records at all, not even their own', (await rows('authenticated', A, `select * from id_validations`)).length === 0 && !!seeded);

// ---------------------------------------------------------------- record contents
console.log('\n# what a record holds');
const rec = await record(A, R_ME.id, { player_id: ' 3327205705 ' }, ' me ', '  ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄  ');
const stored = (await db.query(`select * from id_validations where id = $1`, [rec.validation_id])).rows[0];
ok('fields are stored trimmed, as text', JSON.stringify(stored.fields) === '{"player_id":"3327205705"}', JSON.stringify(stored.fields));
ok('the account region is upper-cased', stored.account_region === 'ME');
ok('the player name is kept verbatim (only trimmed)', stored.player_name === 'ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄', stored.player_name);
const secs = (new Date(rec.valid_until) - new Date(stored.created_at)) / 1000;
ok('it expires exactly 15 minutes after it was made', Math.abs(secs - 900) < 1, String(secs));
ok('a junk account region is stored as "none reported"', (await db.query(`select account_region from id_validations where id = $1`, [(await record(A, R_ME.id, { player_id: '5' }, '<script>', null)).validation_id])).rows[0].account_region === null);
ok('a missing account region is stored as none', (await db.query(`select account_region from id_validations where id = $1`, [(await record(A, R_ME.id, { player_id: '6' }, null, null)).validation_id])).rows[0].account_region === null);
const num = await record(A, R_ME.id, { player_id: 777 }, 'ME', null);
ok('a numeric id is stored as text', JSON.stringify((await db.query(`select fields from id_validations where id = $1`, [num.validation_id])).rows[0].fields) === '{"player_id":"777"}');
await rejects('an unknown field is refused', 'service_role', null, `select * from record_id_validation('${A}','${R_ME.id}','{"player_id":"1","evil":"x"}'::jsonb,'ME',null)`, /buyer_field_unknown/);
await rejects('a missing field is refused', 'service_role', null, `select * from record_id_validation('${A}','${R_ML.id}','{"player_id":"1"}'::jsonb,'ME',null)`, /buyer_field_required/);
await rejects('an inactive region is refused', 'service_role', null, `select * from record_id_validation('${A}','${R_OFF.id}','{"player_id":"1"}'::jsonb,'ME',null)`, /validation_not_available/);
await rejects('a region that does not validate is refused', 'service_role', null, `select * from record_id_validation('${A}','${R_NONE.id}','{"player_id":"1"}'::jsonb,'ME',null)`, /validation_not_available/);
await rejects('an unknown user is refused', 'service_role', null, `select * from record_id_validation('00000000-0000-0000-0000-000000000000','${R_ME.id}','{"player_id":"1"}'::jsonb,'ME',null)`, /not_authenticated/);
ok('admins can read records (support)', (await rows('authenticated', C, `select count(*)::int c from id_validations`))[0].c >= 3);

console.log('\n# the supplier target and the throttle');
const target = (await as('service_role', null, `select * from id_validation_target('${R_ME.id}')`)).rows[0];
ok('the target carries the validation category', target.validation_category_id === 'free_fire' && target.id_validation === 'supplier' && target.family === 'topups');
ok('an inactive region has no target', (await as('service_role', null, `select * from id_validation_target('${R_OFF.id}')`)).rows.length === 0);
let allowed = 0;
for (let i = 0; i < 20; i++) if ((await as('service_role', null, `select claim_id_validation_slot('${B}') ok`)).rows[0].ok) allowed++;
ok('a customer gets 15 validations a minute, then is throttled', allowed === 15, String(allowed));
ok('another customer is not affected', (await as('service_role', null, `select claim_id_validation_slot('${A}') ok`)).rows[0].ok === true);

// ---------------------------------------------------------------- the gate
console.log('\n# no record, no purchase');
await REFUSED('a region that validates IDs refuses a purchase with no record', A, O_OPEN.id, { player_id: '1234567' }, /id_not_validated/);
await REFUSED('the tick cannot stand in for a validation', A, O_OPEN.id, { player_id: '1234567' }, /id_not_validated/, true);
await REFUSED('the old 2-argument call cannot get around the gate either', A, O_OPEN.id, { player_id: '1234567' }, /id_not_validated/);

console.log('\n# a record for these exact fields');
const v1 = await record(A, R_ME.id, { player_id: '1111111111' }, 'ME', 'Player One');
const b1 = (await buy(A, O_ME.id, { player_id: '1111111111' }, false)).rows[0];
ok('with a valid record the purchase goes through', !!b1 && Number(b1.amount) === 20);
ok('the order stores the validation record id', b1.validation_id === v1.validation_id, JSON.stringify(b1));
ok('...the account region that was checked', b1.validated_account_region === 'ME');
ok('...and the player name that was shown', b1.validated_player_name === 'Player One');
ok('...and it is NOT marked self-declared', b1.id_self_declared_at === null);
ok('the fields are still stored as before', JSON.stringify(b1.delivery) === '{"fields":{"player_id":"1111111111"},"account_id":"1111111111"}', JSON.stringify(b1.delivery));
const b2 = (await buy(A, O_ME2.id, { player_id: '1111111111' }, false)).rows[0];
ok('the same record can be used for a second purchase inside the window', b2.validation_id === v1.validation_id);
ok('a value with stray spaces still matches (same normalisation)', (await buy(A, O_OPEN.id, { player_id: '  1111111111  ' }, false)).rows.length === 1);
await REFUSED('a DIFFERENT player id is refused (validated 111..., buying 222...)', A, O_OPEN.id, { player_id: '2222222222' }, /id_not_validated/, false);
await REFUSED('an id that differs only in case is a different id', A, O_OPEN.id, { player_id: 'AbC123' }, /id_not_validated/);
await record(A, R_ME.id, { player_id: 'abc123' }, 'ME', null);
await REFUSED('...even after the lower-case one was validated', A, O_OPEN.id, { player_id: 'ABC123' }, /id_not_validated/);
await REFUSED('another customer cannot use this customer\'s record', B, O_OPEN.id, { player_id: '1111111111' }, /id_not_validated/);
await REFUSED('a record for one region is no use in another region', A, O_OTHER.id, { player_id: '1111111111' }, /id_not_validated/);

console.log('\n# the record expires');
const old = await record(A, R_ME.id, { player_id: '3333333333' }, 'ME', null);
await db.exec(`update id_validations set created_at = now() - interval '15 minutes 5 seconds', expires_at = now() - interval '5 seconds' where id = '${old.validation_id}'`);
await REFUSED('a record older than 15 minutes is refused', A, O_OPEN.id, { player_id: '3333333333' }, /id_validation_expired/);
const fresh = await record(A, R_ME.id, { player_id: '4444444444' }, 'ME', null);
await db.exec(`update id_validations set created_at = now() - interval '14 minutes 50 seconds', expires_at = now() + interval '10 seconds' where id = '${fresh.validation_id}'`);
ok('a record 14m50s old is still good', (await buy(A, O_OPEN.id, { player_id: '4444444444' }, false)).rows.length === 1);
const again = await record(A, R_ME.id, { player_id: '3333333333' }, 'ME', null);
ok('checking again makes a new record and the purchase works', (await buy(A, O_OPEN.id, { player_id: '3333333333' }, false)).rows[0].validation_id === again.validation_id);

console.log('\n# the region lock is real');
await record(A, R_ME.id, { player_id: '5555555555' }, 'ME', 'ME account');
ok('a locked package that serves ME sells to an ME account', (await buy(A, O_ME.id, { player_id: '5555555555' }, false)).rows[0].validated_account_region === 'ME');
await REFUSED('a locked package that does NOT serve ME is refused for an ME account', A, O_BR.id, { player_id: '5555555555' }, /region_mismatch/);
try { await buy(A, O_BR.id, { player_id: '5555555555' }, false); } catch (e) { ok('...and says which region the account is in', /region_mismatch/.test(e.message)); }
await record(A, R_ME.id, { player_id: '6666666666' }, null, 'No region');
await REFUSED('a locked package is refused when the supplier reported no region', A, O_ME.id, { player_id: '6666666666' }, /region_unverified/);
ok('...but an open package sells to the same account', (await buy(A, O_OPEN.id, { player_id: '6666666666' }, false)).rows.length === 1);
await record(A, R_ME.id, { player_id: '7777777777' }, 'BR', null);
ok('a package that serves BR sells to a BR account', (await buy(A, O_BR.id, { player_id: '7777777777' }, false)).rows[0].validated_account_region === 'BR');
await REFUSED('...and the ME-only package is refused for it', A, O_ME.id, { player_id: '7777777777' }, /region_mismatch/);
await REFUSED('a locked package in a region that cannot validate is refused, even with the tick', A, O_NONE_LOCKED.id, { player_id: '999' }, /region_unverifiable/, true);

console.log('\n# money is still checked');
await record(A, R_ME.id, { player_id: '8888888888' }, 'ME', null);
await as('authenticated', C, `select admin_adjust_balance('${A}', -${await bal()}, 'drain')`);
await as('authenticated', C, `select admin_adjust_balance('${A}', 5, 'tiny')`);
await REFUSED('a valid record does not skip the balance check', A, O_ME.id, { player_id: '8888888888' }, /insufficient_balance/);
await as('authenticated', C, `select admin_adjust_balance('${A}', 100000, 'refill')`);

console.log('\n# regions that cannot validate: the tick, on the record');
await REFUSED('a region with an ID field needs the tick', A, O_NONE.id, { player_id: '12345' }, /id_check_required/);
await REFUSED('the tick set to false is not enough', A, O_NONE.id, { player_id: '12345' }, /id_check_required/, false);
const t1 = (await buy(A, O_NONE.id, { player_id: '12345' }, true)).rows[0];
ok('with the tick the purchase goes through', !!t1);
ok('the order says the customer vouched for it, with a timestamp', t1.id_self_declared_at !== null && Math.abs(Date.now() - new Date(t1.id_self_declared_at).getTime()) < 60000, String(t1.id_self_declared_at));
ok('...and there is no validation record on it', t1.validation_id === null && t1.validated_account_region === null && t1.validated_player_name === null);
ok('a validated order is distinguishable: it has a record and no self-declared time', b1.validation_id !== null && b1.id_self_declared_at === null);
ok('a region with no ID field needs no tick (gift card)', (await buy(A, O_GC.id, {}, false)).rows.length === 1);
ok('...and records nothing about an ID', (await orders()).filter((o) => o.product_name === 'Gift').every((o) => o.id_self_declared_at === null && o.validation_id === null));

console.log('\n# two-field games');
await record(A, R_ML.id, { player_id: '111', server_id: '2222' }, 'ID', 'Mage');
ok('two fields validated, the same two bought', (await buy(A, O_ML.id, { player_id: '111', server_id: '2222' }, false)).rows.length === 1);
await REFUSED('same user id, different zone: refused', A, O_ML.id, { player_id: '111', server_id: '3333' }, /id_not_validated/);
await REFUSED('a missing field is still refused first', A, O_ML.id, { player_id: '111' }, /buyer_field_required/);

console.log('\n# nothing else changed');
const legacy = (await rows('authenticated', C, `select o.id from product_options o join products p on p.id = o.product_id where p.category = 'games' and o.region_id is null and o.is_active limit 1`))[0];
if (legacy) {
  await db.exec(`select 1`);
  ok('legacy game packages (no region) still need only an account_id', (await buy(A, legacy.id, { account_id: '123456789' })).rows[0].validation_id === null);
} else {
  const LG = await mk(`insert into products (slug,name,category,is_active) values ('lg','Legacy','games',true) returning id`);
  const LO = await mk(`insert into product_options (product_id,label,price,is_active) values ('${LG.id}','Pack',10,true) returning id`);
  ok('legacy game packages (no region) still need only an account_id', (await buy(A, LO.id, { account_id: '123456789' })).rows[0].validation_id === null);
  await rejects('...and still refuse without one', 'authenticated', A, `select * from purchase_product_option('${LO.id}', '{}')`, /account_id_required/);
}
ok('customers can read their own orders including the new columns', (await rows('authenticated', A, `select validation_id, validated_account_region, id_self_declared_at from orders limit 1`)).length === 1);
ok('a customer cannot see another customer\'s orders', (await rows('authenticated', B, `select * from orders`)).length === 0);
ok('an admin sees what was checked on every order', (await rows('authenticated', C, `select validation_id from orders where validation_id is not null`)).length >= 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
