// Runs the database guards over the REAL supplier catalog (scripts/out/fazer-scan.json),
// so we know they block exactly what they should and nothing legitimate.
// That file is git-ignored (it holds wholesale costs); the suite skips if it is absent.
// Regenerate it with: node --env-file=.env scripts/fazer-scan.ts
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const scanUrl = new URL('../../scripts/out/fazer-scan.json', import.meta.url);
if (!fs.existsSync(scanUrl)) {
  console.log('  SKIP no scripts/out/fazer-scan.json (run the scan to enable this suite)');
  process.exit(0);
}
const scan = JSON.parse(fs.readFileSync(scanUrl, 'utf8'));
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

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
for (const m of [
  'migrations/20260920120000_roles_wallet_catalog.sql',
  'migrations/20260921090000_orders_vault_admin.sql',
  'migrations/20260922100000_catalog_curation.sql',
  'migrations/20260922140000_multifield_purchase_and_guards.sql',
  'migrations/20260923090000_region_matching.sql',
  'migrations/20260924090000_id_validation.sql',
]) await db.exec(read(m));

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };

const EXPECTED_BLOCKED = [
  'arknight_endfield_login', 'genshin_impact_login', 'love_and_deepspace_login', 'mongil_star_dive',
  'neverness_to_everness_login', 'solo_leveling_arise_login', 'tower_of_fantasy_login',
];
const cats = Object.values(scan.topups);
console.log(`\n# buyer-form guard over ${cats.length} real top-up categories (scanned ${scan.scannedAt.slice(0, 10)})`);
const unsafe = (await db.query(
  `select category_id from jsonb_to_recordset($1::jsonb) as x(category_id text, fields jsonb)
    where not public.catalog_fields_are_safe(coalesce(fields, '[]'::jsonb)) order by 1`,
  [JSON.stringify(cats.map((c) => ({ category_id: c.category_id, fields: c.fields ?? [] })))]
)).rows.map((r) => r.category_id);
ok('every password category is caught by its FIELDS alone (including the mislabelled Mongil one)', EXPECTED_BLOCKED.every((id) => unsafe.includes(id)), `caught: ${unsafe.join(', ')}`);
ok('...and nothing else is wrongly rejected (no legitimate game blocked)', unsafe.length === EXPECTED_BLOCKED.length, `unsafe (${unsafe.length}): ${unsafe.join(', ')}`);
ok(`${cats.length - unsafe.length} categories have a form the region table accepts`, cats.length - unsafe.length === 299);

console.log('\n# supplier-category blocklist over every real category id');
const ids = [...scan.topupCats.map((c) => c.category_id), ...scan.giftCats.map((c) => c.category_id)];
const byPattern = (await db.query(`select id from unnest($1::text[]) id where id ~* '(^|_)login($|_)' order by 1`, [ids])).rows.map((r) => r.id);
const blocklist = (await db.query(`select category_id from blocked_supplier_categories order by 1`)).rows.map((r) => r.category_id);
const blocked = [...new Set([...byPattern, ...blocklist])].filter((id) => ids.includes(id)).sort();
ok('blocklist + pattern together block exactly the 7 password categories', JSON.stringify(blocked) === JSON.stringify([...EXPECTED_BLOCKED].sort()), blocked.join(', '));
ok('no gift-card category id looks like a login category', !byPattern.some((id) => scan.giftCats.some((c) => c.category_id === id)));

console.log('\n# first-purchase-only guard over every real offer name');
const names = [
  ...Object.values(scan.topups).flatMap((c) => c.offers.map((o) => o.name)),
  ...Object.values(scan.giftcards).flatMap((c) => c.offers.map((o) => o.name)),
];
const flagged = (await db.query(`select n from unnest($1::text[]) n where public.is_first_purchase_only(n) order by 1`, [names])).rows.map((r) => r.n);
// an independent check with a different regex engine and wording
const JS = /first[ _-]?(time)?[ _-]?(purchase|recharge|top[ -]?up|buy|order|deposit)|1st[ _-]?(purchase|recharge|top[ -]?up)/i;
const jsFlagged = names.filter((n) => JS.test(n)).sort();
ok(`${names.length} real offer names checked`, names.length > 9000);
ok(`the database flags ${flagged.length} names, the independent JS check flags the same set`, JSON.stringify(flagged) === JSON.stringify(jsFlagged), `db=${flagged.length} js=${jsFlagged.length}`);
ok('all 28 "(FIRST PURCHASE ONLY)" offers are flagged', flagged.filter((n) => /first purchase only/i.test(n)).length === 28);
ok('every flagged name really is a one-time offer (none of the ordinary shapes are hit)', !flagged.some((n) => /^\d[\d,.]*\s+(diamonds|coins|gems|uc|cp|vp)$/i.test(n) || /^(weekly|monthly)\s+(membership|card|pass)$/i.test(n)));
ok('no gift card offer is flagged', flagged.every((n) => !Object.values(scan.giftcards).some((c) => c.offers.some((o) => o.name === n))));

// ---------------------------------------------------------------------------------------------
// The Edge Function hides what the database would refuse. The TypeScript filters in
// functions/_shared/catalog.ts must agree with the database guards over the real catalog.
const cat = await import('../functions/_shared/catalog.ts');
const listRows = (await db.query(`select family, category_id, reason from blocked_supplier_categories`)).rows;
const supplierBlocklist = Object.fromEntries(listRows.map((r) => [`${r.family}/${r.category_id}`, r.reason]));

console.log('\n# the app-side filters agree with the database guards (Edge Function shared rules)');
{
  const all = [...scan.topupCats.map((c) => ['topups', c.category_id]), ...scan.giftCats.map((c) => ['giftcards', c.category_id])];
  const dbBlocked = (await db.query(
    `select f, c from unnest($1::text[], $2::text[]) as t(f, c) where public.supplier_category_block_reason('fazercards', f, c) is not null order by 1, 2`,
    [all.map((x) => x[0]), all.map((x) => x[1])]
  )).rows.map((r) => `${r.f}/${r.c}`);
  const tsBlocked = all.filter(([f, c]) => cat.categoryBlockReason(f, c, supplierBlocklist) !== null).map(([f, c]) => `${f}/${c}`).sort();
  ok(`blocked categories: TypeScript and database agree (${tsBlocked.length})`, JSON.stringify(dbBlocked) === JSON.stringify(tsBlocked), `db=${dbBlocked} ts=${tsBlocked}`);
  ok('...and it is exactly the 7 password categories', tsBlocked.length === 7);

  const tsFlagged = names.filter((n) => cat.isFirstPurchaseOnly(n)).sort();
  ok(`first-purchase offers: TypeScript and database flag the same ${flagged.length}`, JSON.stringify(flagged) === JSON.stringify(tsFlagged));

  const tsUnsafe = Object.values(scan.topups).filter((c) => !cat.fieldsAreSafe(c.fields ?? [])).map((c) => c.category_id).sort();
  ok('unsafe buyer forms: TypeScript and database reject the same categories', JSON.stringify(unsafe.slice().sort()) === JSON.stringify(tsUnsafe), `db=${unsafe} ts=${tsUnsafe}`);
}

console.log('\n# what the cache would hold, over every real category');
{
  const validationGames = cat.cleanValidationGames(JSON.parse(fs.readFileSync(new URL('../../scripts/out/fazer-dump.json', import.meta.url), 'utf8')).validateIdGames.items);
  const listedAt = '2026-09-20T00:00:00Z';
  const rowsOf = (family, list) => list.map((c) => cat.normalizeCategory(family, c, { blocklist: supplierBlocklist, validationGames, listedAt }));
  const top = rowsOf('topups', scan.topupCats);
  const gifts = rowsOf('giftcards', scan.giftCats);
  ok('every one of the 885 categories becomes a row', [...top, ...gifts].every((r) => r !== null) && top.length + gifts.length === 885);
  const validated = top.filter((r) => r.validation_category_id).map((r) => r.category_id).sort();
  console.log(`  ${validated.length} categories get a supplier ID check`);
  ok('all 13 Free Fire categories are checked with "free_fire"', top.filter((r) => /^free_fire_/.test(r.category_id)).every((r) => r.validation_category_id === 'free_fire') && top.filter((r) => /^free_fire_/.test(r.category_id)).length === 13);
  ok('"Mobile Legends: Adventure" (a different game) is NOT matched to Mobile Legends', top.find((r) => r.category_id === 'mobile_legends_adventure').validation_category_id === null);
  ok('a variant that states no region (Exclusive, Special) is NOT matched, never guessed', ['mobile_legends_exclusive', 'mobile_legends_special'].every((id) => top.find((r) => r.category_id === id).validation_category_id === null));
  ok('the regional Mobile Legends categories are checked', ['brazil', 'indonesia', 'malaysia', 'philippines', 'singapore', 'turkey', 'united_states', 'ru', 'global'].every((s) => top.find((r) => r.category_id === `mobile_legends_${s}`).validation_category_id === 'mobile_legends'));
  ok('PUBG Mobile and Magic Chess are checked', top.filter((r) => /^pubg_mobile_/.test(r.category_id)).every((r) => r.validation_category_id === 'pubg_mobile') && top.find((r) => r.category_id === 'magic_chess_gogo_ru').validation_category_id === 'magic_chess_gogo_ru');
  ok('nothing outside those five games is checked', validated.every((id) => /^(free_fire|mobile_legends|pubg_mobile|magic_chess_gogo)_/.test(id)) || validated.length === 0, validated.join());
  ok('no gift card is ever given an ID check', gifts.every((r) => r.validation_category_id === null));
  ok('Free Fire (MENA) reads as game "Free Fire", chip "MENA", supplier region "MENA"', (() => { const r = top.find((r) => r.category_id === 'free_fire_mena'); return r.game_name === 'Free Fire' && r.region_label === 'MENA' && r.note_region === 'MENA'; })());
  ok('the 7 blocked categories carry a reason', top.filter((r) => r.blocked_reason).length === 7);

  let hidden = 0, kept = 0, unsafeOffers = 0;
  for (const c of Object.values(scan.topups)) { const r = cat.normalizeOffers('topups', c); hidden += r.hidden_offer_count; kept += r.offers.length; if (r.blocked_reason) unsafeOffers++; }
  for (const c of Object.values(scan.giftcards)) { const r = cat.normalizeOffers('giftcards', c); hidden += r.hidden_offer_count; kept += r.offers.length; }
  ok(`${flagged.length} first-purchase offers are hidden, none shown`, hidden >= flagged.length, `hidden=${hidden}`);
  ok('offers total = shown + hidden', kept + hidden === names.length, `${kept}+${hidden} vs ${names.length}`);
  ok('the password categories are caught by their form as well', unsafeOffers === 7);
  ok('no shown offer is first-purchase-only', Object.values(scan.topups).every((c) => cat.normalizeOffers('topups', c).offers.every((o) => !cat.isFirstPurchaseOnly(o.name))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
