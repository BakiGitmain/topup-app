// Payment tutorial images: who can read/write, and the all-or-nothing batched save (add, reorder, remove).
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
async function rejects(n, role, uid, sql, re, params) {
  try { await as(role, uid, sql, params); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message + ' ' + (e.detail ?? '')); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const mk = async (email) => (await one(`insert into auth.users (email) values ($1) returning id`, [email])).id;
const A = await mk('a@x.com'), ADM = await mk('admin@x.com');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);

const save = (provider, items, user = ADM) => as('authenticated', user, `select admin_save_payment_tutorials($1, $2::jsonb) r`, [provider, JSON.stringify(items)]).then((r) => r.rows[0].r);
const list = async (provider) => (await db.query(`select id, image_url u, storage_path p, sort_order o from payment_tutorial_images where provider = $1 order by sort_order`, [provider])).rows;
const url = (n) => `https://x.supabase.co/storage/v1/object/public/payment-tutorials/${n}.jpg`;

console.log('\n# nothing uploaded yet');
ok('the table starts empty (so the customer screen shows no carousel)', (await list('telebirr')).length === 0 && (await list('cbe')).length === 0);

console.log('\n# adding images');
let r = await save('telebirr', [{ id: null, image_url: url('a'), storage_path: 'a.jpg' }, { id: null, image_url: url('b'), storage_path: 'b.jpg' }, { id: null, image_url: url('c'), storage_path: 'c.jpg' }]);
let t = await list('telebirr');
ok('three images saved in the order given', t.map((x) => x.u).join() === [url('a'), url('b'), url('c')].join() && t.map((x) => x.o).join() === '0,1,2');
ok('nothing was removed', r.removed_paths.length === 0);
await save('cbe', [{ id: null, image_url: url('cbe1'), storage_path: 'cbe1.jpg' }]);
ok('each provider has its own list', (await list('cbe')).length === 1 && (await list('telebirr')).length === 3);

console.log('\n# reorder, remove and add in ONE save');
const [ia, , ic] = t.map((x) => x.id);
r = await save('telebirr', [{ id: ic }, { id: null, image_url: url('d'), storage_path: 'd.jpg' }, { id: ia }]); // c, d(new), a ; b removed
t = await list('telebirr');
ok('the list is exactly what was sent, in that order', t.map((x) => x.p).join() === 'c.jpg,d.jpg,a.jpg' && t.map((x) => x.o).join() === '0,1,2', t.map((x) => x.p).join());
ok('the removed image\'s file path comes back so the app can delete the file', JSON.stringify(r.removed_paths) === '["b.jpg"]');
ok('kept images keep their ids', t[0].id === ic && t[2].id === ia);
ok('the other provider was not touched', (await list('cbe')).length === 1);

console.log('\n# all or nothing');
const before = JSON.stringify(await list('telebirr'));
await rejects('an unknown image id refuses the whole save', 'authenticated', ADM, `select admin_save_payment_tutorials('telebirr', $1::jsonb)`, /image_not_found/, [JSON.stringify([{ id: ic }, { id: '00000000-0000-0000-0000-000000000000' }])]);
ok('...and nothing changed', JSON.stringify(await list('telebirr')) === before);
await rejects("an image id from the OTHER provider is refused", 'authenticated', ADM, `select admin_save_payment_tutorials('telebirr', $1::jsonb)`, /image_not_found/, [JSON.stringify([{ id: (await list('cbe'))[0].id }])]);
await rejects('a new image needs an https url', 'authenticated', ADM, `select admin_save_payment_tutorials('telebirr', $1::jsonb)`, /invalid_items/, [JSON.stringify([{ id: ic }, { id: null, image_url: 'http://x/a.jpg' }])]);
await rejects('...not javascript: or data:', 'authenticated', ADM, `select admin_save_payment_tutorials('telebirr', $1::jsonb)`, /invalid_items/, [JSON.stringify([{ id: null, image_url: 'javascript:alert(1)' }])]);
await rejects('at most 10 images', 'authenticated', ADM, `select admin_save_payment_tutorials('telebirr', $1::jsonb)`, /invalid_items/, [JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: null, image_url: url(`n${i}`) })))]);
await rejects('only telebirr and cbe', 'authenticated', ADM, `select admin_save_payment_tutorials('mpesa', '[]'::jsonb)`, /invalid_provider/);
await rejects('the items must be a list', 'authenticated', ADM, `select admin_save_payment_tutorials('cbe', '{"a":1}'::jsonb)`, /invalid_items/);
ok('every refusal left the data alone', JSON.stringify(await list('telebirr')) === before && (await list('cbe')).length === 1);

console.log('\n# emptying a provider hides its carousel');
r = await save('cbe', []);
ok('saving an empty list removes them all and returns their files', (await list('cbe')).length === 0 && JSON.stringify(r.removed_paths) === '["cbe1.jpg"]');

console.log('\n# who can do what');
ok('any signed-in customer can READ the tutorials', (await as('authenticated', A, `select id from payment_tutorial_images`)).rows.length === 3);
await rejects('anonymous cannot read them', 'anon', null, `select * from payment_tutorial_images`, /permission denied/);
await rejects('a customer cannot save (admin-only)', 'authenticated', A, `select admin_save_payment_tutorials('telebirr', '[]'::jsonb)`, /forbidden/);
{
  const n = (await as('authenticated', A, `delete from payment_tutorial_images`)).affectedRows;
  ok('a customer cannot delete rows directly (row security hides them all)', n === 0 && (await list('telebirr')).length === 3);
  await rejects('...nor insert', 'authenticated', A, `insert into payment_tutorial_images (provider, image_url) values ('cbe','https://x/y.jpg')`, /row-level security/);
  const u = (await as('authenticated', A, `update payment_tutorial_images set image_url = 'https://evil.example/x.jpg'`)).affectedRows;
  ok('...nor edit', u === 0);
}
await rejects('anonymous cannot save', 'anon', null, `select admin_save_payment_tutorials('cbe', '[]'::jsonb)`, /permission denied/);
await rejects('a provider outside telebirr/cbe cannot be inserted even by an admin', 'authenticated', ADM, `insert into payment_tutorial_images (provider, image_url) values ('mpesa','https://x/y.jpg')`, /check constraint/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
