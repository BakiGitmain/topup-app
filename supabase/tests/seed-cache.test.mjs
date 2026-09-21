// Generates the cache seed from the real scan and applies it to the migrated schema.
// The scan holds wholesale costs and is git-ignored; this suite skips if it is absent.
import { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const scanUrl = new URL('../../scripts/out/fazer-scan.json', import.meta.url);
if (!fs.existsSync(scanUrl) || !fs.existsSync(new URL('../../scripts/out/fazer-dump.json', import.meta.url))) {
  console.log('  SKIP no scripts/out/fazer-scan.json + fazer-dump.json');
  process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const gen = spawnSync(process.execPath, ['scripts/fazer-seed-cache.ts'], { cwd: root, encoding: 'utf8' });
if (gen.status !== 0) { console.log('  FAIL generating the seed:', gen.stderr || gen.stdout); process.exit(1); }
const dir = new URL('../../scripts/out/seed-cache/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => /^\d+\.sql$/.test(f)).sort();

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
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
for (const m of [
  'migrations/20260920120000_roles_wallet_catalog.sql', 'migrations/20260921090000_orders_vault_admin.sql',
  'migrations/20260922100000_catalog_curation.sql', 'migrations/20260922140000_multifield_purchase_and_guards.sql',
  'migrations/20260923090000_region_matching.sql', 'migrations/20260924090000_id_validation.sql',
  'migrations/20260925090000_supplier_catalog_cache.sql', 'migrations/20260925100000_admin_import.sql',
]) await db.exec(read(m));

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };
const one = async (sql) => (await db.query(sql)).rows[0];
const applyAll = async () => { for (const f of files) await db.exec(fs.readFileSync(new URL(f, dir), 'utf8')); };

console.log(`\n# seeding from ${files.length} generated files`);
await applyAll();
const c = await one(`select count(*)::int total,
  count(*) filter (where blocked_reason is not null)::int blocked,
  count(*) filter (where validation_category_id is not null)::int validated,
  count(*) filter (where offers is not null)::int with_offers,
  count(*) filter (where family='topups')::int topups, count(*) filter (where family='giftcards')::int gifts,
  min(offers_fetched_at)::text first_at, max(offers_fetched_at)::text last_at from supplier_catalog`);
ok('all 885 categories are saved (306 top-ups, 579 gift cards)', c.total === 885 && c.topups === 306 && c.gifts === 579, JSON.stringify(c));
ok('7 are blocked, 28 have an ID check', c.blocked === 7 && c.validated === 28, JSON.stringify(c));
ok('every category has its packs saved, all with the scan date', c.with_offers === 885 && c.first_at === c.last_at, JSON.stringify(c));

const ff = await one(`select * from supplier_catalog where category_id='free_fire_mena'`);
ok('Free Fire (MENA): game, chip, region, ID check and 5 packs with cost', ff.game_name === 'Free Fire' && ff.region_label === 'MENA' && ff.note_region === 'MENA' && ff.validation_category_id === 'free_fire' && ff.offers.length === 5 && ff.offers[0].ref === '110_diamonds' && ff.offers[0].cost_usd === '0.9456', JSON.stringify(ff.offers?.[0]));
ok('...and its buyer form is Player ID', (() => { try { assert.deepEqual(ff.fields, [{ key: 'player_id', label: 'Player ID', type: 'text' }]); return true; } catch { return false; } })(), JSON.stringify(ff.fields));
ok('no first-purchase offer was saved anywhere', (await one(`select count(*)::int n from supplier_catalog, jsonb_array_elements(coalesce(offers,'[]')) o where public.is_first_purchase_only(o->>'name')`)).n === 0);
ok('no blocked category has packs to pick from', (await one(`select count(*)::int n from supplier_catalog where blocked_reason is not null and jsonb_array_length(offers) > 0`)).n === 0);
ok('...and each of the 7 is one the database refuses to import', (await one(`select count(*)::int n from supplier_catalog where blocked_reason is not null and public.supplier_category_block_reason('fazercards', family, category_id) is not null`)).n === 7);
ok('the shown packs + hidden ones add up to the scan', (await one(`select (sum(jsonb_array_length(offers)) + sum(hidden_offer_count))::int n from supplier_catalog`)).n === 9727);

console.log('\n# re-running and refreshing');
await applyAll();
ok('running the seed twice changes nothing', (await one(`select count(*)::int n from supplier_catalog`)).n === 885);
await db.exec(`update supplier_catalog set offers = '[{"ref":"live","name":"Live pack","cost_usd":"9.0000"}]'::jsonb, offers_fetched_at = '2026-09-22T00:00:00Z' where category_id='free_fire_mena'`);
await applyAll();
const after = await one(`select offers, offers_fetched_at::text at from supplier_catalog where category_id='free_fire_mena'`);
ok('packs fetched LATER than the scan are never overwritten by a re-seed', after.offers[0].ref === 'live' && after.at.startsWith('2026-09-22'), JSON.stringify(after));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
