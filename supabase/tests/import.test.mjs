// admin_import_product (atomic import) and the supplier_catalog cache table.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Every migration in order, so this suite also proves the import behaves as before after the later changes.
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
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };
async function as(role, uid, sql, params) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}
async function rejects(n, role, uid, sql, re, params) {
  try { await as(role, uid, sql, params); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const rows = async (role, uid, sql, params) => (await as(role, uid, sql, params)).rows;

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const U = (await db.query(`insert into auth.users (email) values ('u@x.com') returning id`)).rows[0].id; // customer
const A = (await db.query(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id; // admin
await db.exec(`update profiles set role='admin' where id='${A}'`);

const importAs = (role, uid, payload) => as(role, uid, `select public.admin_import_product($1::jsonb) as id`, [JSON.stringify(payload)]);
const doImport = async (payload) => (await importAs('authenticated', A, payload)).rows[0].id;
const rejectsImport = (n, payload, re, who = A) => rejects(n, 'authenticated', who, `select public.admin_import_product($1::jsonb)`, re, [JSON.stringify(payload)]);
const counts = async () => (await db.query(`
  select (select count(*)::int from products) p, (select count(*)::int from product_regions) r,
         (select count(*)::int from product_options) o, (select count(*)::int from product_region_supplier) rs,
         (select count(*)::int from product_option_supplier) os`)).rows[0];

const pack = (ref, name, extra = {}) => ({
  offer_ref: ref, offer_name: name, label: name, price: 100, cost_usd: '0.9456', group_label: 'Diamonds',
  region_locked: true, account_region_codes: ['ME'], ...extra,
});
const FF_FIELDS = [{ key: 'player_id', label: 'Player ID', type: 'text' }];
const ffRegion = (extra = {}) => ({
  code: 'mena', label: 'MENA', buyer_fields: FF_FIELDS, id_validation: 'supplier', family: 'topups', category_id: 'free_fire_mena',
  validation_category_id: 'free_fire', validation_field_map: {},
  packs: [pack('110_diamonds', '110 Diamonds'), pack('231_diamonds', '231 Diamonds', { cost_usd: '1.8913' })],
  ...extra,
});
const ffPayload = (extra = {}) => ({ name: 'Free Fire Diamonds', category: 'games', tagline: 'Diamonds', currency_label: 'Diamonds', image_url: null, regions: [ffRegion()], ...extra });

console.log('\n# a good import creates everything, switched off');
const before = await counts();
const productId = await doImport(ffPayload({ image_url: 'https://x.supabase.co/storage/v1/object/public/product-art/p/1.jpg' }));
const after = await counts();
ok('one product, one region, two packs, and both kinds of supplier link', after.p - before.p === 1 && after.r - before.r === 1 && after.o - before.o === 2 && after.rs - before.rs === 1 && after.os - before.os === 2, JSON.stringify(after));
const prod = (await db.query(`select * from products where id=$1`, [productId])).rows[0];
ok('the product is OFF', prod.is_active === false);
ok('the product keeps its name, category, unit word and artwork', prod.name === 'Free Fire Diamonds' && prod.category === 'games' && prod.currency_label === 'Diamonds' && /product-art/.test(prod.image_url));
ok('the region is OFF, with its buyer form and supplier check', (await db.query(`select bool_and(not is_active) off, min(id_validation) v, min(buyer_fields::text) f from product_regions where product_id=$1`, [productId])).rows[0].off === true);
ok('every pack is OFF', (await db.query(`select bool_and(not is_active) off from product_options where product_id=$1`, [productId])).rows[0].off === true);
const links = (await db.query(`
  select s.supplier_offer_name, s.offer_ref, s.category_id, s.family, s.supplier_cost_usd::text cost, o.price::text price, o.region_locked, o.account_region_codes
    from product_option_supplier s join product_options o on o.id = s.option_id where o.product_id=$1 order by o.sort_order`, [productId])).rows;
ok('every pack records the supplier offer name, id, category and cost', links.length === 2 && links.every((l) => l.supplier_offer_name && l.offer_ref && l.category_id === 'free_fire_mena' && l.family === 'topups') && links[0].supplier_offer_name === '110 Diamonds' && links[1].cost === '1.8913', JSON.stringify(links));
ok('birr prices, lock and codes are stored per pack', links.every((l) => l.price === '100.00' && l.region_locked === true && l.account_region_codes.join() === 'ME'));
const rs = (await db.query(`select s.category_id, s.validation_category_id, s.validation_field_map::text m from product_region_supplier s join product_regions r on r.id=s.region_id where r.product_id=$1`, [productId])).rows[0];
ok('the region is linked to its supplier category and the ID check', rs.category_id === 'free_fire_mena' && rs.validation_category_id === 'free_fire' && rs.m === '{}');
ok('a customer cannot see the imported product (it is off)', (await rows('authenticated', U, `select id from products where id='${productId}'`)).length === 0);
ok('a customer cannot see the supplier links or costs', (await rows('authenticated', U, `select * from product_option_supplier`)).length === 0);

console.log('\n# refused outright');
await rejectsImport('a customer cannot import', ffPayload(), /forbidden/, U);
await rejects('an anonymous caller cannot import', 'anon', null, `select public.admin_import_product('{}'::jsonb)`, /permission denied|forbidden/);

console.log('\n# all or nothing');
{
  const c0 = await counts();
  await rejectsImport('a first-purchase offer refuses the WHOLE import', ffPayload({ name: 'Atomic A', regions: [ffRegion({ code: 'a', packs: [pack('a1', '50 Diamonds'), pack('a2', '100 Diamonds (First Purchase Only)')] })] }), /first_purchase_only_not_sellable/);
  ok('...and leaves nothing behind (no product, region, pack or link)', JSON.stringify(await counts()) === JSON.stringify(c0));
  await rejectsImport('a login (password) category is refused', ffPayload({ name: 'Atomic B', regions: [ffRegion({ code: 'b', category_id: 'genshin_impact_login', packs: [pack('b1', '60 Crystals')] })] }), /blocked_supplier_category/);
  ok('...and leaves nothing behind', JSON.stringify(await counts()) === JSON.stringify(c0));
  await rejectsImport('a login-looking category that is not on the list is refused too', ffPayload({ name: 'Atomic C', regions: [ffRegion({ code: 'c', category_id: 'brand_new_game_login', packs: [pack('c1', '60 Crystals')] })] }), /blocked_supplier_category/);
  await rejectsImport('a form that asks for a password is refused', ffPayload({ name: 'Atomic D', regions: [ffRegion({ code: 'd', buyer_fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }, { key: 'server_id', label: 'Password', type: 'text' }], packs: [pack('d1', '60 Crystals')] })] }), /import_invalid/);
  ok('...and leaves nothing behind', JSON.stringify(await counts()) === JSON.stringify(c0));
  await rejectsImport('a second region failing rolls back the first region', ffPayload({ name: 'Atomic E', regions: [ffRegion({ code: 'e1', category_id: 'free_fire_bd', packs: [pack('e1', '25 Diamonds')] }), ffRegion({ code: 'e2', category_id: 'free_fire_br', packs: [pack('e2', '25 Diamonds'), pack('e3', 'First Recharge 50')] })] }), /first_purchase_only_not_sellable/);
  ok('...and leaves nothing behind', JSON.stringify(await counts()) === JSON.stringify(c0));
}

console.log('\n# the supplier offer name is always recorded');
{
  const c0 = await counts();
  for (const [n, name] of [['missing', undefined], ['null', null], ['empty', ''], ['blank', '   ']]) {
    const p = pack('n1', '5 Diamonds'); if (name === undefined) delete p.offer_name; else p.offer_name = name;
    await rejectsImport(`${n} offer name is refused`, ffPayload({ name: 'Names', regions: [ffRegion({ code: 'n', packs: [p] })] }), /offer_name_required/);
  }
  ok('...and nothing was created', JSON.stringify(await counts()) === JSON.stringify(c0));
}

console.log('\n# the same supplier offer twice');
{
  const c0 = await counts();
  await rejectsImport('importing an offer that already exists is refused', ffPayload({ name: 'Second try' }), /already_imported/);
  ok('...and leaves nothing behind', JSON.stringify(await counts()) === JSON.stringify(c0));
  await rejectsImport('the same offer twice in one import is refused', ffPayload({ name: 'Dupes', regions: [ffRegion({ code: 'x', category_id: 'free_fire_th', packs: [pack('t1', '10 Diamonds'), pack('t1', '10 Diamonds again')] })] }), /already_imported/);
  ok('...and leaves nothing behind', JSON.stringify(await counts()) === JSON.stringify(c0));
}

console.log('\n# prices and the region lock');
{
  const c0 = await counts();
  for (const price of [0, -5, 'abc', null, 1.005, 10000000000]) {
    await rejectsImport(`price ${JSON.stringify(price)} is refused`, ffPayload({ name: 'Prices', regions: [ffRegion({ code: 'p', category_id: 'free_fire_vn', packs: [pack('v1', '10 Diamonds', { price })] })] }), /import_invalid|price_check/);
  }
  ok('...and nothing was created', JSON.stringify(await counts()) === JSON.stringify(c0));
  await rejectsImport('account region codes on an unlocked pack are refused', ffPayload({ name: 'Codes', regions: [ffRegion({ code: 'q', category_id: 'free_fire_ph', packs: [pack('q1', '10 Diamonds', { region_locked: false, account_region_codes: ['ME'] })] })] }), /codes_need_lock/);
  await rejectsImport('a code that is not a plain short code is refused', ffPayload({ name: 'Codes2', regions: [ffRegion({ code: 'q', category_id: 'free_fire_ph', packs: [pack('q1', '10 Diamonds', { account_region_codes: ['not ok!'] })] })] }), /region_codes_safe/);

  const id = await doImport(ffPayload({ name: 'Locked draft', regions: [ffRegion({ code: 'bd', label: 'BD', category_id: 'free_fire_bd', packs: [pack('bd1', '25 Diamonds', { account_region_codes: [] })] })] }));
  ok('a region-locked pack with NO codes imports (as an off draft)', !!id);
  await rejects('...but cannot be switched on until the codes are typed', 'authenticated', A, `update product_options set is_active = true where product_id='${id}'`, /locked_needs_codes_to_be_live/);
  await as('authenticated', A, `update product_options set account_region_codes = array['BD'] where product_id='${id}'`);
  await as('authenticated', A, `update product_options set is_active = true where product_id='${id}'`);
  ok('...and can once it has them', (await db.query(`select is_active from product_options where product_id=$1`, [id])).rows[0].is_active === true);
}

console.log('\n# gift cards and unvalidated games');
{
  const gid = await doImport({
    name: 'Amazon', category: 'gift-cards', tagline: '', currency_label: null, image_url: null,
    regions: [{ code: 'us', label: 'US', buyer_fields: [], id_validation: 'none', family: 'giftcards', category_id: 'amazon_us', validation_category_id: null, validation_field_map: {},
      packs: [pack('5_usd', '5 USD', { region_locked: false, account_region_codes: [], group_label: null })] }],
  });
  const g = (await db.query(`select p.category, r.buyer_fields::text f, r.id_validation v, o.region_locked from products p join product_regions r on r.product_id=p.id join product_options o on o.region_id=r.id where p.id=$1`, [gid])).rows[0];
  ok('a gift card imports with no buyer form, no ID check and no lock', g.category === 'gift-cards' && g.f === '[]' && g.v === 'none' && g.region_locked === false, JSON.stringify(g));
  const tid = await doImport(ffPayload({ name: 'Blood Strike', regions: [ffRegion({ code: 'mena', category_id: 'blood_strike_mena', id_validation: 'none', validation_category_id: null, packs: [pack('bs1', '100 Gold', { region_locked: false, account_region_codes: [] })] })] }));
  ok('an unvalidated game imports with the tick (id_validation none) and no supplier check stored', (await db.query(`select s.validation_category_id vc, r.id_validation v from product_regions r join product_region_supplier s on s.region_id=r.id where r.product_id=$1`, [tid])).rows[0].vc === null);
  await rejectsImport('a supplier-checked region without its validation game is refused', ffPayload({ name: 'NoVal', regions: [ffRegion({ code: 'z', category_id: 'free_fire_tw', validation_category_id: null, packs: [pack('tw1', '10 Diamonds')] })] }), /import_invalid/);
}

console.log('\n# the cache table');
{
  const row = { family: 'topups', category_id: 'free_fire_mena', name: 'Free Fire (MENA)', game_name: 'Free Fire' };
  const ins = (extra = '') => `insert into supplier_catalog (family, category_id, name, game_name${extra ? ', ' + extra.split('|')[0] : ''}) values ('${row.family}','${row.category_id}','${row.name}','${row.game_name}'${extra ? ', ' + extra.split('|')[1] : ''})`;
  await as('service_role', null, ins());
  ok('the service role can write it', (await rows('service_role', null, `select count(*)::int c from supplier_catalog`))[0].c === 1);
  ok('an admin can read it', (await rows('authenticated', A, `select count(*)::int c from supplier_catalog`))[0].c === 1);
  ok('a customer sees no rows', (await rows('authenticated', U, `select count(*)::int c from supplier_catalog`))[0].c === 0);
  await rejects('a customer cannot write it', 'authenticated', U, ins().replace('free_fire_mena', 'x1'), /permission denied|row-level security/);
  await rejects('an admin cannot write it from the app either (only the function can)', 'authenticated', A, ins().replace('free_fire_mena', 'x2'), /permission denied|row-level security/);
  await rejects('anon cannot read it', 'anon', null, `select * from supplier_catalog`, /permission denied/);
  await rejects('offers must be a list', 'service_role', null, `update supplier_catalog set offers = '{"a":1}'::jsonb`, /supplier_catalog_offers_shape/);
  await as('service_role', null, `update supplier_catalog set offers = '[{"ref":"a","name":"A","cost_usd":"1"}]'::jsonb, offers_fetched_at = now()`);
  ok('a list is accepted', (await rows('authenticated', A, `select jsonb_array_length(offers) n from supplier_catalog`))[0].n === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
