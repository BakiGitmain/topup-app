// Migrations 20260926*: pack images, the image gallery, removing a product, the all-or-nothing on/off batch,
// and categories. Includes the row-level-security checks: a non-admin session cannot write any of it.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATIONS = fs
  .readdirSync(new URL('../migrations/', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => read(`migrations/${f}`));

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
const rows = async (role, uid, sql, params) => (await as(role, uid, sql, params)).rows;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const U = (await one(`insert into auth.users (email) values ('u@x.com') returning id`)).id; // customer
const A = (await one(`insert into auth.users (email) values ('a@x.com') returning id`)).id; // admin
await db.exec(`update profiles set role='admin' where id='${A}'`);

const importAs = (uid, payload) => as('authenticated', uid, `select public.admin_import_product($1::jsonb) as id`, [JSON.stringify(payload)]);
const doImport = async (payload) => (await importAs(A, payload)).rows[0].id;
const rejectsImport = (n, payload, re) => rejects(n, 'authenticated', A, `select public.admin_import_product($1::jsonb)`, re, [JSON.stringify(payload)]);
const counts = async () => (await one(`select (select count(*)::int from products) p, (select count(*)::int from product_options) o, (select count(*)::int from product_regions) r,
  (select count(*)::int from product_images) i, (select count(*)::int from product_categories) c, (select count(*)::int from product_option_supplier) os`));

let n = 0;
const pack = (name, extra = {}) => ({ offer_ref: `ref_${++n}`, offer_name: name, label: name, price: 100, cost_usd: '1.0', group_label: null, region_locked: false, account_region_codes: [], ...extra });
const region = (packs, extra = {}) => ({ code: `r${++n}`, label: 'Global', buyer_fields: [], id_validation: 'none', family: 'topups', category_id: `cat_${n}`, validation_category_id: null, validation_field_map: {}, packs, ...extra });
const payload = (extra = {}) => ({ name: `Game ${++n}`, category: 'games', tagline: '', currency_label: null, image_url: null, regions: [region([pack('60 UC'), pack('325 UC')])], ...extra });
const img = (s) => `products/${s}.jpg`;
const url = (path) => `https://x.supabase.co/storage/v1/object/public/product-art/${path}`;

console.log('\n# pack image_url (migration 1)');
const P1 = await doImport(payload({ images: [{ path: img('aaa-111') }, { path: img('bbb-222') }] }));
const packs1 = (await rows('authenticated', A, `select id from product_options where product_id=$1 order by sort_order`, [P1])).map((r) => r.id);
ok('every pack starts with no image', (await one(`select count(*)::int c from product_options where image_url is not null`)).c === 0);
await rejects('a non-https address is refused (by the address check or the gallery guard, whichever sees it first)', 'authenticated', A, `update product_options set image_url='http://x/a.jpg' where id=$1`, /product_options_image_url_check|pack_image_not_in_gallery/, [packs1[0]]);

console.log('\n# product_images (migration 2)');
ok('the import saved both gallery images with the product', (await one(`select count(*)::int c from product_images where product_id=$1`, [P1])).c === 2);
const imgRows = await rows('authenticated', A, `select id, path from product_images where product_id=$1 order by path`, [P1]);
await as('authenticated', A, `insert into product_images (product_id, path) values ($1, $2)`, [P1, img('ccc-333')]);
ok('an admin can add an image', (await one(`select count(*)::int c from product_images where product_id=$1`, [P1])).c === 3);
await rejects('a path outside products/<name>.jpg is refused', 'authenticated', A, `insert into product_images (product_id, path) values ($1, 'other/x.png')`, /product_images_path_check/, [P1]);
await rejects('the same file cannot be registered twice', 'authenticated', A, `insert into product_images (product_id, path) values ($1, $2)`, /unique|duplicate/, [P1, img('ccc-333')]);

console.log('\n# RLS: who can touch product_images');
await rejects('a customer cannot add an image', 'authenticated', U, `insert into product_images (product_id, path) values ($1, $2)`, /row-level security|permission denied/, [P1, img('zzz-999')]);
ok('a customer cannot change an image (no rows affected)', (await as('authenticated', U, `update product_images set path = 'products/hack-1.jpg' returning id`)).rows.length === 0);
ok('a customer cannot delete an image (no rows affected)', (await as('authenticated', U, `delete from product_images returning id`)).rows.length === 0);
ok('...and all three images are still there', (await one(`select count(*)::int c from product_images where product_id=$1`, [P1])).c === 3);
ok('a customer cannot read the gallery of a product that is off', (await rows('authenticated', U, `select id from product_images`)).length === 0);
await rejects('anonymous cannot read it', 'anon', null, `select * from product_images`, /permission denied/);
await rejects('anonymous cannot write it', 'anon', null, `insert into product_images (product_id, path) values ($1, $2)`, /permission denied/, [P1, img('zzz-998')]);
await db.exec(`update product_options set is_active = true where product_id='${P1}'; update products set is_active = true where id='${P1}'`);
ok('once the product is on sale a customer can read its gallery', (await rows('authenticated', U, `select id from product_images where product_id=$1`, [P1])).length === 3);
await rejects('...but still cannot write to it', 'authenticated', U, `insert into product_images (product_id, path) values ($1, $2)`, /row-level security/, [P1, img('zzz-997')]);
await db.exec(`update products set is_active = false where id='${P1}'; update product_options set is_active = false where product_id='${P1}'`);

console.log('\n# assigning an image to a pack (only from its own gallery)');
const P2 = await doImport(payload({ images: [{ path: img('ddd-444') }] }));
const packs2 = (await rows('authenticated', A, `select id from product_options where product_id=$1 order by sort_order`, [P2])).map((r) => r.id);
await as('authenticated', A, `update product_options set image_url=$2 where id=$1`, [packs1[0], url(img('aaa-111'))]);
await as('authenticated', A, `update product_options set image_url=$2 where id=$1`, [packs1[1], url(img('aaa-111'))]);
ok('an admin can give a pack one of its product\'s images (two packs may share one)', (await one(`select count(*)::int c from product_options where image_url = $1`, [url(img('aaa-111'))])).c === 2);
await rejects('a URL that is not in any gallery is refused', 'authenticated', A, `update product_options set image_url='https://evil.example/pixel.jpg' where id=$1`, /pack_image_not_in_gallery/, [packs1[0]]);
await rejects('another product\'s image is refused', 'authenticated', A, `update product_options set image_url=$2 where id=$1`, /pack_image_not_in_gallery/, [packs1[0], url(img('ddd-444'))]);
ok('a customer cannot change a pack image (no rows affected)', (await as('authenticated', U, `update product_options set image_url=$2 where id=$1 returning id`, [packs1[0], url(img('bbb-222'))])).rows.length === 0);
ok('...and the pack is unchanged', (await one(`select image_url from product_options where id=$1`, [packs1[0]])).image_url === url(img('aaa-111')));

console.log('\n# DECISION: deleting an image frees the packs that used it');
await as('authenticated', A, `update product_options set image_url=$2 where id=$1`, [packs1[1], url(img('bbb-222'))]);
const aaa = imgRows.find((r) => r.path === img('aaa-111'));
await as('authenticated', A, `delete from product_images where id=$1`, [aaa.id]);
const after = (await rows('authenticated', A, `select id, image_url from product_options where product_id=$1 order by sort_order`, [P1]));
ok('the pack that used the deleted image now has NO image', after[0].image_url === null);
ok('the pack that used a different image keeps it', after[1].image_url === url(img('bbb-222')));
ok('a pack of ANOTHER product is never touched', (await one(`select image_url from product_options where id=$1`, [packs2[0]])).image_url === null);
ok('the image row is gone', (await one(`select count(*)::int c from product_images where id=$1`, [aaa.id])).c === 0);

console.log('\n# import with a gallery is all-or-nothing');
{
  const c0 = await counts();
  await rejectsImport('a bad image path refuses the whole import', payload({ images: [{ path: img('ok-1') }, { path: 'nope.png' }] }), /import_invalid/);
  await rejectsImport('more than 12 images is refused', payload({ images: Array.from({ length: 13 }, (_, i) => ({ path: img(`many-${i}`) })) }), /import_invalid/);
  await rejectsImport('a path already used elsewhere is refused', payload({ images: [{ path: img('bbb-222') }] }), /unique|duplicate/);
  ok('...and nothing was left behind', JSON.stringify(await counts()) === JSON.stringify(c0));
}

console.log('\n# admin_delete_product (migration 3)');
{
  const c0 = await counts();
  const PD = await doImport(payload({ image_url: url(img('hero-1')), images: [{ path: img('del-1') }, { path: img('del-2') }], categories: [{ key: 'uc', label: 'UC' }] }));
  ok('the product exists with packs, links, images and a category', (await counts()).p === c0.p + 1);
  await rejects('a customer cannot remove a product', 'authenticated', U, `select public.admin_delete_product($1)`, /forbidden/, [PD]);
  await rejects('an unknown product is reported', 'authenticated', A, `select public.admin_delete_product('00000000-0000-0000-0000-000000000000')`, /product_not_found/);
  const res = (await as('authenticated', A, `select public.admin_delete_product($1) as r`, [PD])).rows[0].r;
  ok('with 0 orders it is hard-deleted, and everything under it goes (packs, regions, links, images, categories)', JSON.stringify(await counts()) === JSON.stringify(c0), JSON.stringify(await counts()));
  ok('it returns the hero image and the gallery paths so the app can delete the files', res.image_url === url(img('hero-1')) && res.image_paths.sort().join() === [img('del-1'), img('del-2')].join(), JSON.stringify(res));

  // with an order: refuse, delete nothing
  const PO = await doImport(payload());
  await db.exec(`update products set is_active=true where id='${PO}'; update product_regions set is_active=true where product_id='${PO}'; update product_options set is_active=true where product_id='${PO}'`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${U}', false)`);
  await as('authenticated', A, `select admin_adjust_balance($1, 100000, 'seed')`, [U]);
  const opt = (await one(`select id from product_options where product_id=$1 limit 1`, [PO])).id;
  await as('authenticated', U, `select * from purchase_product_option($1, '{}'::jsonb, true)`, [opt]);
  const before = await counts();
  await rejects('a product with an order cannot be removed (hide it instead)', 'authenticated', A, `select public.admin_delete_product($1)`, /product_has_orders/, [PO]);
  ok('...and NOTHING was deleted', JSON.stringify(await counts()) === JSON.stringify(before));
  ok('...and the order is intact', (await one(`select count(*)::int c from orders where product_name = (select name from products where id=$1)`, [PO])).c === 1);
}

console.log('\n# admin_apply_active_changes (migration 3): all or nothing');
{
  const PB = await doImport(payload({ regions: [region([pack('a'), pack('b')], { code: 'one' }), region([pack('c')], { code: 'two' })] }));
  const opts = (await rows('authenticated', A, `select o.id from product_options o where o.product_id=$1 order by o.label`, [PB])).map((r) => r.id);
  const regs = (await rows('authenticated', A, `select id from product_regions where product_id=$1 order by code`, [PB])).map((r) => r.id);
  const apply = (changes, uid = A) => as('authenticated', uid, `select public.admin_apply_active_changes($1::jsonb) as n`, [JSON.stringify(changes)]);

  const r1 = (await apply({ products: [{ id: PB, is_active: true }], regions: [{ id: regs[0], is_active: true }, { id: regs[1], is_active: true }], options: opts.map((id) => ({ id, is_active: true })) })).rows[0].n;
  ok('one request switches a product, its regions and its packs on (returns how many)', r1 === 6, String(r1));
  ok('...they are all on', (await one(`select (select is_active from products where id=$1) p, (select bool_and(is_active) from product_regions where product_id=$1) r, (select bool_and(is_active) from product_options where product_id=$1) o`, [PB])).o === true);

  // a pack that can never go live: locked, with no codes
  await db.exec(`update product_options set region_locked = true, is_active = false where id='${opts[1]}'`);
  await db.exec(`update products set is_active = true where id='${PB}'`);
  const before = JSON.stringify(await rows('authenticated', A, `select id, is_active from product_options where product_id=$1 order by id`, [PB]));
  let detail = '';
  try { await apply({ options: [{ id: opts[0], is_active: false }, { id: opts[1], is_active: true }, { id: opts[2], is_active: false }], products: [{ id: PB, is_active: false }] }); }
  catch (e) { detail = e.detail ?? ''; ok('a refused change fails the whole request', /active_changes_failed/.test(e.message), e.message); }
  const failures = detail ? JSON.parse(detail) : [];
  ok('the error names exactly the pack that was refused, and why', failures.length === 1 && failures[0].kind === 'options' && failures[0].id === opts[1] && /locked_needs_codes_to_be_live/.test(failures[0].reason), detail);
  ok('NOTHING from that request was applied (no partial state)', JSON.stringify(await rows('authenticated', A, `select id, is_active from product_options where product_id=$1 order by id`, [PB])) === before && (await one(`select is_active from products where id=$1`, [PB])).is_active === true);

  // two problems are both reported
  let detail2 = '';
  try { await apply({ options: [{ id: opts[1], is_active: true }, { id: '11111111-1111-1111-1111-111111111111', is_active: true }] }); } catch (e) { detail2 = e.detail ?? ''; }
  const f2 = detail2 ? JSON.parse(detail2) : [];
  ok('every problem is reported, not just the first (a locked pack and a missing one)', f2.length === 2 && f2.some((f) => /locked_needs/.test(f.reason)) && f2.some((f) => f.reason === 'not_found'), detail2);

  await rejects('a customer cannot use it', 'authenticated', U, `select public.admin_apply_active_changes('{}'::jsonb)`, /forbidden/);
  for (const [name, bad] of [['an unknown key', { users: [] }], ['a non-list', { products: {} }], ['a bad id', { products: [{ id: 'nope', is_active: true }] }], ['a non-boolean', { products: [{ id: PB, is_active: 'yes' }] }], ['a non-object', []]]) {
    await rejects(`${name} is refused`, 'authenticated', A, `select public.admin_apply_active_changes($1::jsonb)`, /changes_invalid/, [JSON.stringify(bad)]);
  }
  ok('an empty request is fine and changes nothing', (await apply({})).rows[0].n === 0);
}

console.log('\n# product_categories (migration 4)');
const PC = await doImport(payload({
  categories: [{ key: 'uc', label: 'UC' }, { key: 'coins', label: 'Coins' }],
  regions: [region([pack('60 UC', { category_key: 'uc' }), pack('100 Coins', { category_key: 'coins' })])],
}));
const cats = await rows('authenticated', A, `select id, label, sort_order from product_categories where product_id=$1 order by sort_order`, [PC]);
ok('the import created the categories in order', cats.map((c) => c.label).join() === 'UC,Coins' && cats[0].sort_order === 1 && cats[1].sort_order === 2);
const packsC = await rows('authenticated', A, `select o.label, c.label as cat from product_options o join product_categories c on c.id = o.category_id where o.product_id=$1 order by o.sort_order`, [PC]);
ok('...and put each pack in the one it named', packsC.map((p) => `${p.label}:${p.cat}`).join() === '60 UC:UC,100 Coins:Coins');
ok('existing packs elsewhere have no category', (await one(`select count(*)::int c from product_options where category_id is null`)).c > 0);

console.log('\n# RLS: who can touch product_categories');
await rejects('a customer cannot add a category', 'authenticated', U, `insert into product_categories (product_id, label) values ($1, 'Hack')`, /row-level security|permission denied/, [PC]);
ok('a customer cannot rename one (no rows affected)', (await as('authenticated', U, `update product_categories set label='X' returning id`)).rows.length === 0);
ok('a customer cannot delete one (no rows affected)', (await as('authenticated', U, `delete from product_categories returning id`)).rows.length === 0);
ok('...and the categories are unchanged', (await one(`select count(*)::int c from product_categories where product_id=$1`, [PC])).c === 2);
ok('a customer cannot read the categories of a product that is off', (await rows('authenticated', U, `select id from product_categories`)).length === 0);
await rejects('anonymous cannot read', 'anon', null, `select * from product_categories`, /permission denied/);
await rejects('anonymous cannot write', 'anon', null, `insert into product_categories (product_id, label) values ($1, 'x')`, /permission denied/, [PC]);
await db.exec(`update product_options set is_active=true where product_id='${PC}'; update products set is_active=true where id='${PC}'`);
ok('once on sale, a customer can read them', (await rows('authenticated', U, `select id from product_categories where product_id=$1`, [PC])).length === 2);
await rejects('...but still cannot write', 'authenticated', U, `insert into product_categories (product_id, label) values ($1, 'Hack')`, /row-level security/, [PC]);
await db.exec(`update products set is_active=false where id='${PC}'; update product_options set is_active=false where product_id='${PC}'`);

console.log('\n# category rules');
await as('authenticated', A, `insert into product_categories (product_id, label, sort_order) values ($1, 'Membership', 3)`, [PC]);
await rejects('a label is unique within a product, ignoring case and spaces', 'authenticated', A, `insert into product_categories (product_id, label) values ($1, ' membership ')`, /product_categories_label_unique|duplicate/, [PC]);
await rejects('an empty label is refused', 'authenticated', A, `insert into product_categories (product_id, label) values ($1, '   ')`, /product_categories_label_check/, [PC]);
ok('the same label is fine on another product', (await as('authenticated', A, `insert into product_categories (product_id, label) values ($1, 'UC') returning id`, [P2])).rows.length === 1);
const otherCat = (await one(`select id from product_categories where product_id=$1`, [P2])).id;
await rejects('a pack cannot be put in another product\'s category', 'authenticated', A, `update product_options set category_id=$2 where id=$1`, /pack_category_wrong_product/, [(await one(`select id from product_options where product_id=$1 limit 1`, [PC])).id, otherCat]);
const someCat = cats[0].id;
await as('authenticated', A, `update product_options set category_id=$2 where id=$1`, [packs2[0], otherCat]);
ok('a pack can be moved to a category of its own product', (await one(`select category_id from product_options where id=$1`, [packs2[0]])).category_id === otherCat);

console.log('\n# DECISION: a category with packs cannot be deleted');
await rejects('deleting a category that still has packs is refused', 'authenticated', A, `delete from product_categories where id=$1`, /foreign key|violates|product_options_category_id_fkey/, [someCat]);
ok('...and the packs keep their category', (await one(`select count(*)::int c from product_options where category_id=$1`, [someCat])).c === 1);
const unused = (await one(`select id from product_categories where product_id=$1 and label='Membership'`, [PC])).id;
await as('authenticated', A, `delete from product_categories where id=$1`, [unused]);
ok('an empty category can be deleted', (await one(`select count(*)::int c from product_categories where id=$1`, [unused])).c === 0);
await as('authenticated', A, `update product_options set category_id=null where category_id=$1`, [someCat]);
await as('authenticated', A, `delete from product_categories where id=$1`, [someCat]);
ok('...and so can one whose packs were moved off it first', (await one(`select count(*)::int c from product_categories where id=$1`, [someCat])).c === 0);

console.log('\n# import with categories');
{
  const c0 = await counts();
  const cat2 = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
  await rejectsImport('with two categories every pack must name one', payload({ categories: cat2, regions: [region([pack('x', { category_key: 'a' }), pack('y')])] }), /import_invalid/);
  await rejectsImport('a pack naming an unknown category is refused', payload({ categories: cat2, regions: [region([pack('x', { category_key: 'zzz' })])] }), /import_invalid/);
  await rejectsImport('a category key used twice is refused', payload({ categories: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] }), /import_invalid/);
  await rejectsImport('two categories with the same label are refused', payload({ categories: [{ key: 'a', label: 'UC' }, { key: 'b', label: ' uc ' }], regions: [region([pack('x', { category_key: 'a' })])] }), /product_categories_label_unique|duplicate|import_invalid/);
  await rejectsImport('an empty label is refused', payload({ categories: [{ key: 'a', label: ' ' }] }), /import_invalid/);
  await rejectsImport('more than 12 categories are refused', payload({ categories: Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })) }), /import_invalid/);
  ok('...and nothing was left behind', JSON.stringify(await counts()) === JSON.stringify(c0));
  const one1 = await doImport(payload({ categories: [{ key: 'a', label: 'Only' }], regions: [region([pack('x'), pack('y', { category_key: 'a' })])] }));
  ok('with ONE category a pack need not name it (no pills would show anyway)', (await one(`select count(*)::int c from product_options where product_id=$1 and category_id is null`, [one1])).c === 1);
  const none = await doImport(payload());
  ok('an import with no categories and no images still works exactly as before', (await one(`select (select count(*)::int from product_categories where product_id=$1) c, (select count(*)::int from product_images where product_id=$1) i`, [none])).c === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
