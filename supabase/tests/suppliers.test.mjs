// Two suppliers side by side: supplier names on every link, one supplier per region and its packs, the supplier-aware import,
// what validate-id is told, and the exchange-rate setting. Runs every migration.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATION_FILES = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
const MIGRATIONS = MIGRATION_FILES.map((f) => read(`migrations/${f}`));

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
async function rejects(n, role, uid, sql, re, params) {
  try { await as(role, uid, sql, params); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message + ' ' + (e.detail ?? '')); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

for (const m of MIGRATIONS) await db.exec(m);
// The three creator-commission migrations can be applied a second time without error (each says 'safe to
// re-run') -- but only together, in order: 20261008090000's own migrate-before-drop logic reads a column that
// only exists because 20261007090000 just (re-)created it in the same pass. Selected by filename, not
// `.slice(-3)` -- a positional slice breaks the moment any migration is added after these three (confirmed: it
// silently drops 20261007090000 out of the window, and 20261008090000 then fails on the re-run alone).
const THREE = ['20261007090000', '20261008090000', '20261009090000'];
for (const f of THREE) await db.exec(read(`migrations/${MIGRATION_FILES.find((n) => n.startsWith(f))}`));

const U = (await one(`insert into auth.users (email) values ('u@x.com') returning id`)).id;
const A = (await one(`insert into auth.users (email) values ('a@x.com') returning id`)).id;
await db.exec(`update profiles set role='admin' where id='${A}'`);

const FIELDS = [{ key: 'player_id', label: 'Player ID', type: 'text' }];
const pack = (ref, name, extra = {}) => ({ offer_ref: ref, offer_name: name, label: name, price: 100, cost_usd: '0.9456', group_label: 'Diamonds', region_locked: false, account_region_codes: [], ...extra });
const region = (extra = {}) => ({ code: 'mena', label: 'MENA', buyer_fields: FIELDS, id_validation: 'none', family: 'topups', category_id: '4', validation_category_id: null, validation_field_map: {}, packs: [pack('28', '100 + 10 Diamonds')], ...extra });
const payload = (r = {}, p = {}) => ({ name: 'Free Fire Diamonds', category: 'games', tagline: 'Diamonds', currency_label: 'Diamonds', image_url: null, regions: [region(r)], ...p });
const doImport = async (pl) => (await as('authenticated', A, `select public.admin_import_product($1::jsonb) id`, [JSON.stringify(pl)])).rows[0].id;
const rejectsImport = (n, pl, re) => rejects(n, 'authenticated', A, `select public.admin_import_product($1::jsonb)`, re, [JSON.stringify(pl)]);
const links = async (productId) => ({
  region: (await db.query(`select s.supplier, s.category_id from product_region_supplier s join product_regions r on r.id = s.region_id where r.product_id = $1`, [productId])).rows,
  packs: (await db.query(`select s.supplier, s.category_id, s.offer_ref from product_option_supplier s join product_options o on o.id = s.option_id where o.product_id = $1 order by s.offer_ref`, [productId])).rows,
});

console.log('\n# nothing existing changes: an import with no supplier is FazerCards, as ever');
const legacy = await doImport(payload({ category_id: 'free_fire_mena', packs: [pack('110_diamonds', '110 Diamonds')] }));
{
  const l = await links(legacy);
  ok('the region link says fazercards', l.region.length === 1 && l.region[0].supplier === 'fazercards');
  ok('every pack link says fazercards', l.packs.length === 1 && l.packs[0].supplier === 'fazercards');
}

console.log('\n# importing from Shop2Topup');
const s2 = await doImport(payload({ supplier: 'shop2topup' }));
{
  const l = await links(s2);
  ok('the region link is tagged shop2topup, with Shop2Topup\'s own category id', l.region[0].supplier === 'shop2topup' && l.region[0].category_id === '4');
  ok('every pack link is tagged shop2topup with its Shop2Topup pack id', l.packs.every((p) => p.supplier === 'shop2topup') && l.packs[0].offer_ref === '28');
  ok('the supplier offer name is recorded verbatim, as always', (await one(`select supplier_offer_name n from product_option_supplier where offer_ref = '28' and supplier = 'shop2topup'`)).n === '100 + 10 Diamonds');
  ok('it starts OFF like every import', (await one(`select is_active a from products where id = $1`, [s2])).a === false && (await one(`select bool_or(is_active) a from product_options where product_id = $1`, [s2])).a === false);
}
await rejectsImport('an unknown supplier is refused', payload({ supplier: 'mpesa' }), /import_invalid/);
await rejectsImport('...and one that only differs by case', payload({ supplier: 'Shop2Topup' }), /import_invalid/);
{
  const before = (await one(`select count(*)::int c from products`)).c;
  await rejectsImport('a bad supplier on the second region rolls the WHOLE import back', payload({}, { regions: [region({ supplier: 'shop2topup', code: 'a', category_id: '31', packs: [pack('3100', '10 Gems')] }), region({ supplier: 'nope', code: 'b', category_id: '9' })] }), /import_invalid/);
  ok('...nothing was created', (await one(`select count(*)::int c from products`)).c === before);
}

console.log('\n# the same numbers under different suppliers are different things');
{
  const both = await doImport(payload({ supplier: 'fazercards', category_id: '4', code: 'x', packs: [pack('28', 'Same ids, other supplier')] }, { name: 'Twin' }));
  ok('category "4" / pack "28" can exist under FazerCards and under Shop2Topup at once', (await links(both)).packs[0].supplier === 'fazercards');
}
await rejectsImport('importing a Shop2Topup pack that is already imported is refused as such', payload({ supplier: 'shop2topup' }, { name: 'Again' }), /already_imported/);
await rejectsImport('...and so is a FazerCards one', payload({ category_id: 'free_fire_mena', packs: [pack('110_diamonds', '110 Diamonds')] }, { name: 'Again' }), /already_imported/);

console.log('\n# the guards work for Shop2Topup too');
await rejectsImport('a first-purchase-only offer is refused (by its name)', payload({ supplier: 'shop2topup', category_id: '77', packs: [pack('900', 'First Purchase Bonus 50')] }, { name: 'FP' }), /first_purchase_only/);
await rejectsImport('a login-based category id is refused', payload({ supplier: 'shop2topup', category_id: 'game_login', packs: [pack('901', '60 Crystals')] }, { name: 'LG' }), /blocked_supplier_category/);
await rejectsImport('a buyer form that asks for a password is refused', payload({ supplier: 'shop2topup', category_id: '78', buyer_fields: [{ key: 'password', label: 'Password', type: 'text' }], packs: [pack('902', '60 Crystals')] }, { name: 'PW' }), /import_invalid/);
await db.exec(`insert into blocked_supplier_categories (supplier, family, category_id, reason) values ('shop2topup', 'topups', '555', 'test block')`);
await rejectsImport('a category blocked for Shop2Topup is refused', payload({ supplier: 'shop2topup', category_id: '555', packs: [pack('903', '60 Crystals')] }, { name: 'BL' }), /blocked_supplier_category/);
{
  const same = await doImport(payload({ supplier: 'fazercards', category_id: '555', code: 'fz', packs: [pack('904', '60 Crystals')] }, { name: 'NotBlockedHere' }));
  ok('...but the same id under FazerCards is NOT blocked (a block belongs to one supplier)', !!same);
}

console.log('\n# supplier names are checked on every table');
for (const [table, sql] of [
  ['product_option_supplier', `update product_option_supplier set supplier = 'mpesa' where offer_ref = '28' and supplier = 'shop2topup'`],
  ['product_region_supplier', `update product_region_supplier set supplier = 'mpesa' where category_id = '4' and supplier = 'shop2topup'`],
  ['supplier_catalog', `insert into supplier_catalog (supplier, family, category_id, name, game_name) values ('mpesa', 'topups', 'c1', 'x', 'x')`],
  ['blocked_supplier_categories', `insert into blocked_supplier_categories (supplier, family, category_id, reason) values ('mpesa', 'topups', 'c2', 'x')`],
]) {
  let err = null;
  try { await db.query(sql); } catch (e) { err = e; }
  // on the two link tables the consistency trigger looks first; either way the write is refused
  ok(`${table} refuses an unknown supplier`, err && /supplier_check|check constraint|supplier_mismatch/.test(err.message), err?.message);
}
ok('the saved catalog holds both suppliers side by side (its key includes the supplier)', await (async () => {
  await db.exec(`insert into supplier_catalog (supplier, family, category_id, name, game_name) values ('fazercards', 'topups', '4', 'FZ four', 'g'), ('shop2topup', 'topups', '4', 'S2 four', 'g')`);
  return (await one(`select count(*)::int c from supplier_catalog where category_id = '4'`)).c === 2;
})());

console.log('\n# a region and its packs are one supplier');
{
  const opt = (await one(`select o.id from product_options o where o.product_id = $1`, [s2])).id;
  let err = null;
  try { await db.query(`update product_option_supplier set supplier = 'fazercards' where option_id = $1`, [opt]); } catch (e) { err = e; }
  ok('a pack cannot be re-pointed at a different supplier than its region', err && /supplier_mismatch/.test(err.message), err?.message);
  err = null;
  try { await db.query(`update product_region_supplier set supplier = 'fazercards' where region_id = (select region_id from product_options where id = $1)`, [opt]); } catch (e) { err = e; }
  ok('a region cannot move to another supplier while its packs are linked to the first', err && /supplier_mismatch/.test(err.message), err?.message);
  ok('...and nothing changed', (await one(`select supplier from product_option_supplier where option_id = $1`, [opt])).supplier === 'shop2topup');
  // a new pack linked to the wrong supplier inside an existing region
  const region = (await one(`select region_id r from product_options where id = $1`, [opt])).r;
  const extra = (await one(`insert into product_options (product_id, label, price, region_id, is_active) values ($1, 'Extra', 10, $2, false) returning id`, [s2, region])).id;
  err = null;
  try { await db.query(`insert into product_option_supplier (option_id, supplier, family, category_id, offer_ref) values ($1, 'fazercards', 'topups', '4', '99')`, [extra]); } catch (e) { err = e; }
  ok('a new pack link with the wrong supplier is refused', err && /supplier_mismatch/.test(err.message), err?.message);
  await db.query(`insert into product_option_supplier (option_id, supplier, family, category_id, offer_ref) values ($1, 'shop2topup', 'topups', '4', '99')`, [extra]);
  ok('...with the right one it is accepted', true);
}

console.log('\n# validate-id is told which supplier to ask (id_validation_target itself is unchanged)');
{
  const regionOf = async (productId) => {
    await db.exec(`update products set is_active = true where id = '${productId}'; update product_regions set is_active = true where product_id = '${productId}'`);
    return (await one(`select id from product_regions where product_id = $1`, [productId])).id;
  };
  const supplierOf = async (r) => (await as('service_role', null, `select public.id_validation_supplier($1) s`, [r])).rows[0].s;
  const rLegacy = await regionOf(legacy);
  const rS2 = await regionOf(s2);
  ok('a FazerCards region says fazercards', (await supplierOf(rLegacy)) === 'fazercards');
  ok('a Shop2Topup region says shop2topup', (await supplierOf(rS2)) === 'shop2topup');
  ok('an unknown region has no supplier (validate-id then treats it as "no target" anyway)', (await supplierOf('00000000-0000-0000-0000-000000000000')) === null);
  await db.exec(`update product_regions set is_active = false where id = '${rS2}'`);
  ok('an inactive region has none, like id_validation_target', (await supplierOf(rS2)) === null);
  await db.exec(`update product_regions set is_active = true where id = '${rS2}'`);
  await rejects('a customer cannot call it', 'authenticated', U, `select public.id_validation_supplier('${rS2}')`, /permission denied/);
  await rejects('nor anonymous', 'anon', null, `select public.id_validation_supplier('${rS2}')`, /permission denied/);
  const cols = Object.keys((await as('service_role', null, `select * from id_validation_target($1)`, [rS2])).rows[0]);
  ok('id_validation_target still returns exactly its five old columns', cols.join() === 'id_validation,buyer_fields,family,validation_category_id,validation_field_map', cols.join());
}
{
  const withCheck = await doImport(payload({ supplier: 'shop2topup', id_validation: 'supplier', validation_category_id: '4', category_id: '4', code: 'chk', packs: [pack('600', '100 Diamonds')] }, { name: 'Checked' }));
  await db.exec(`update products set is_active = true where id = '${withCheck}'; update product_regions set is_active = true where product_id = '${withCheck}'`);
  const r = (await one(`select id from product_regions where product_id = $1`, [withCheck])).id;
  const t = (await as('service_role', null, `select * from id_validation_target($1)`, [r])).rows[0];
  ok('a Shop2Topup region that is ID-checked carries the category the check needs', t.id_validation === 'supplier' && t.validation_category_id === '4');
  ok('...and is routed to Shop2Topup', (await as('service_role', null, `select public.id_validation_supplier($1) s`, [r])).rows[0].s === 'shop2topup');
}

console.log('\n# validation_supplier: WHO checks a region\'s IDs, independent of who its packs come from');
{
  const cols = Object.keys(await one(`select * from product_region_supplier limit 1`));
  ok('the column exists on the table', cols.includes('validation_supplier'), cols.join());
}
{
  // unknown values are refused, same shape as the `supplier` column
  let err = null;
  try { await db.query(`update product_region_supplier set validation_supplier = 'mpesa' where category_id = '4' and supplier = 'shop2topup'`); } catch (e) { err = e; }
  ok('an unknown validation_supplier is refused', err && /validation_supplier_check|check constraint/.test(err.message), err?.message);
  await db.query(`update product_region_supplier set validation_supplier = null where category_id = '4' and supplier = 'shop2topup'`);
  ok('null is fine (it means "same as supplier")', true);
}
{
  // Blood Strike's real shape: packs from FazerCards, checked by Shop2Topup, in Shop2Topup's OWN category namespace (445),
  // which has nothing to do with FazerCards' 'blood_strike_mena' and no pack of Blood Strike is linked to Shop2Topup at all.
  const blood = await doImport(payload(
    { code: 'mena', category_id: 'blood_strike_mena', validation_supplier: 'shop2topup', id_validation: 'supplier', validation_category_id: '445', packs: [pack('51_gold', '51 GOLD', { cost_usd: '0.4280' })] },
    { name: 'Blood Strike' }
  ));
  const region = (await one(`select id from product_regions where product_id = $1`, [blood])).id;
  const link = await one(`select supplier, category_id, validation_supplier, validation_category_id from product_region_supplier where region_id = $1`, [region]);
  ok('the region\'s packs stay FazerCards; its check is tagged Shop2Topup, in Shop2Topup\'s own category', link.supplier === 'fazercards' && link.category_id === 'blood_strike_mena' && link.validation_supplier === 'shop2topup' && link.validation_category_id === '445', JSON.stringify(link));
  const packLink = await one(`select supplier from product_option_supplier s join product_options o on o.id = s.option_id where o.region_id = $1`, [region]);
  ok('...and its ONE pack is still linked to FazerCards: validation never touches fulfilment', packLink.supplier === 'fazercards');
  await db.exec(`update products set is_active = true where id = '${blood}'; update product_regions set is_active = true where product_id = '${blood}'`);
  ok('id_validation_supplier() routes the check to Shop2Topup although fulfilment is FazerCards', (await as('service_role', null, `select public.id_validation_supplier($1) s`, [region])).rows[0].s === 'shop2topup');
  const target = (await as('service_role', null, `select * from id_validation_target($1)`, [region])).rows[0];
  ok('id_validation_target carries Shop2Topup\'s OWN category id (445), not a FazerCards one', target.validation_category_id === '445' && target.id_validation === 'supplier');
  // proves the consistency trigger (fulfilment supplier <-> its packs) is genuinely untouched by this: no Shop2Topup pack
  // exists anywhere in this product, yet saving a region with validation_supplier='shop2topup' was accepted without complaint.
  ok('no pack of this product is linked to Shop2Topup at all (the guard trigger never objected)', (await one(`select count(*)::int c from product_option_supplier s join product_options o on o.id = s.option_id where o.product_id = $1 and s.supplier = 'shop2topup'`, [blood])).c === 0);
}
{
  // an unknown validation_supplier in the IMPORT payload is refused, same shape as an unknown `supplier`
  await rejectsImport('an unknown validation_supplier in the payload is refused', payload({ code: 'x', category_id: 'y', validation_supplier: 'mpesa' }, { name: 'Bad' }), /import_invalid/);
}
{
  // a region that does NOT check IDs: a validation_supplier in the payload is accepted but stored as null (nothing to route)
  const off = await doImport(payload({ code: 'x2', category_id: 'y2', id_validation: 'none', validation_supplier: 'shop2topup' }, { name: 'NoCheck' }));
  const link = await one(`select r.id_validation, s.validation_supplier from product_regions r join product_region_supplier s on s.region_id = r.id where r.product_id = $1`, [off]);
  ok('a validation_supplier on a region that does not check IDs is dropped, not stored', link.id_validation === 'none' && link.validation_supplier === null, JSON.stringify(link));
}
{
  // Free Fire / PUBG shaped: no validation_supplier in the payload at all -> still routes to the SAME supplier as fulfilment
  // (their real live shape today: fulfilment AND validation both Shop2Topup).
  const ff = await doImport(payload({ code: 'ffmena', category_id: '4', validation_category_id: '4', id_validation: 'supplier', supplier: 'shop2topup', packs: [pack('29', '210 + 21 Diamonds')] }, { name: 'Free Fire' }));
  const region = (await one(`select id from product_regions where product_id = $1`, [ff])).id;
  await db.exec(`update products set is_active = true where id = '${ff}'; update product_regions set is_active = true where product_id = '${ff}'`);
  ok('Free Fire (Shop2Topup fulfilment, no override): checks route to Shop2Topup, unchanged from before this migration', (await as('service_role', null, `select public.id_validation_supplier($1) s`, [region])).rows[0].s === 'shop2topup');
  const link = await one(`select validation_supplier from product_region_supplier where region_id = $1`, [region]);
  ok('...and the column is simply null: nothing new was invented for it', link.validation_supplier === null);
}
{
  // explicitly picking the SAME supplier back (as the import screen does when an admin re-selects the default) is
  // stored and still routes correctly -- it is not required to be null, just equivalent.
  const same = await doImport(payload({ code: 'x3', category_id: 'y3', id_validation: 'supplier', validation_category_id: 'y3', validation_supplier: 'fazercards' }, { name: 'SameChoice' }));
  const region = (await one(`select id from product_regions where product_id = $1`, [same])).id;
  await db.exec(`update products set is_active = true where id = '${same}'; update product_regions set is_active = true where product_id = '${same}'`);
  ok('explicitly picking the same supplier as fulfilment still routes there', (await as('service_role', null, `select public.id_validation_supplier($1) s`, [region])).rows[0].s === 'fazercards');
}

console.log('\n# the exchange rate');
ok('it starts at 175', Number((await as('authenticated', A, `select usd_to_birr r from pricing_settings`)).rows[0].r) === 175);
await as('authenticated', A, `update pricing_settings set usd_to_birr = 181.5 where id`);
{
  const row = (await as('authenticated', A, `select usd_to_birr r, updated_by from pricing_settings`)).rows[0];
  ok('an admin can change it, and who did it is recorded', Number(row.r) === 181.5 && row.updated_by === A);
}
ok('a customer sees no row (it is the shop\'s margin)', (await as('authenticated', U, `select usd_to_birr from pricing_settings`)).rows.length === 0);
ok('a customer cannot change it (no row is updated)', (await as('authenticated', U, `update pricing_settings set usd_to_birr = 1`)).affectedRows === 0 && Number((await one(`select usd_to_birr r from pricing_settings`)).r) === 181.5);
await rejects('anonymous cannot read it', 'anon', null, `select * from pricing_settings`, /permission denied/);
for (const bad of [0, -5, 100001]) await rejects(`a rate of ${bad} is refused`, 'authenticated', A, `update pricing_settings set usd_to_birr = ${bad}`, /check constraint|usd_to_birr/);
await rejects('there can be only one row', 'authenticated', A, `insert into pricing_settings (id, usd_to_birr) values (false, 10)`, /permission denied/);
await rejects('and it cannot be deleted', 'authenticated', A, `delete from pricing_settings`, /permission denied/);
{
  let err = null;
  try { await db.query(`insert into pricing_settings (id, usd_to_birr) values (false, 10)`); } catch (e) { err = e; }
  ok('(even for the table owner, a second row is impossible)', err && /check constraint|duplicate|violates/.test(err.message), err?.message);
}

console.log('\n# gamesdrop: a third known supplier, FazerCards kept only for its historical rows');
{
  const gd = await doImport(payload(
    { code: 'gd', category_id: '491', supplier: 'shop2topup', validation_supplier: 'gamesdrop', id_validation: 'supplier', validation_category_id: '2733', validation_field_map: { player_id: 'gameUserId' }, packs: [pack('gd_pack', 'GamesDrop-checked pack')] },
    { name: 'GamesDrop Checked' }
  ));
  const region = (await one(`select id from product_regions where product_id = $1`, [gd])).id;
  const link = await one(`select supplier, category_id, validation_supplier, validation_category_id, validation_field_map from product_region_supplier where region_id = $1`, [region]);
  ok('fulfilment stays Shop2Topup while validation is GamesDrop, decoupled exactly like the Blood Strike case', link.supplier === 'shop2topup' && link.validation_supplier === 'gamesdrop' && link.validation_category_id === '2733');
  ok('the field map GamesDrop needs is stored verbatim', JSON.stringify(link.validation_field_map) === JSON.stringify({ player_id: 'gameUserId' }));
  await db.exec(`update products set is_active = true where id = '${gd}'; update product_regions set is_active = true where product_id = '${gd}'`);
  ok('id_validation_supplier() routes there', (await as('service_role', null, `select public.id_validation_supplier($1) s`, [region])).rows[0].s === 'gamesdrop');
}
{
  const direct = await doImport(payload({ code: 'gd2', category_id: 'gdcat', supplier: 'gamesdrop', packs: [pack('gdo1', 'A GamesDrop pack')] }, { name: 'GamesDrop Direct' }));
  const l = await links(direct);
  ok('gamesdrop packs and fulfilment can be imported directly too, not only as a validation supplier', l.region[0].supplier === 'gamesdrop' && l.packs[0].supplier === 'gamesdrop');
}
await rejectsImport('an unknown supplier is still refused the same way (gamesdrop existing did not loosen this)', payload({ supplier: 'mpesa' }), /import_invalid/);
{
  let err = null;
  try { await db.query(`insert into supplier_catalog (supplier, family, category_id, name, game_name) values ('gamesdrop', 'topups', 'gdcheck', 'x', 'x')`); } catch (e) { err = e; }
  ok('supplier_catalog accepts gamesdrop rows', !err, err?.message);
}
{
  let err = null;
  try { await db.query(`insert into blocked_supplier_categories (supplier, family, category_id, reason) values ('gamesdrop', 'topups', 'gdblock', 'test')`); } catch (e) { err = e; }
  ok('blocked_supplier_categories accepts gamesdrop rows too', !err, err?.message);
}
ok('fazercards is still an accepted value (its historical supplier_catalog/blocklist rows are meant to be left alone, not orphaned)', await (async () => {
  await db.exec(`insert into supplier_catalog (supplier, family, category_id, name, game_name) values ('fazercards', 'topups', 'histcheck', 'x', 'x')`);
  return (await one(`select count(*)::int c from supplier_catalog where supplier = 'fazercards' and category_id = 'histcheck'`)).c === 1;
})());
{
  // a region and its packs still have to agree, gamesdrop included
  const opt = (await one(`select o.id from product_options o join product_regions r on r.id = o.region_id join products p on p.id=r.product_id where p.name = 'GamesDrop Direct'`)).id;
  let err = null;
  try { await db.query(`update product_option_supplier set supplier = 'shop2topup' where option_id = $1`, [opt]); } catch (e) { err = e; }
  ok('the fulfilment consistency trigger applies to gamesdrop exactly like the other two', err && /supplier_mismatch/.test(err.message), err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
