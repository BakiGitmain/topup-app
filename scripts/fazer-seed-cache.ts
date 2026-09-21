/**
 * OFFLINE. Turns the saved supplier scan into SQL that fills public.supplier_catalog: every category,
 * and every category's packs, costs and buyer form, dated with the scan's own date. No API calls and
 * no key needed, so it still works after the supplier trial ends.
 *
 *   node scripts/fazer-seed-cache.ts                # writes scripts/out/seed-cache/NN.sql and prints a summary
 *   npx supabase db query --linked -f scripts/out/seed-cache/01.sql   # (run each file; see the summary)
 *
 * It uses the same rules as the supplier-catalog Edge Function (supabase/functions/_shared/catalog.ts), so
 * seeded rows and refreshed rows look identical. Re-running never replaces packs that were fetched later
 * than the scan.
 *
 * The output holds WHOLESALE COSTS: scripts/out/ is git-ignored. Do not commit or share it.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { categoryBlockReason, cleanValidationGames, normalizeCategory, normalizeOffers } from '../supabase/functions/_shared/catalog.ts';

type ScanCat = { category_id: string; name: string; note?: string };
type Scan = {
  scannedAt: string;
  topupCats: ScanCat[];
  giftCats: ScanCat[];
  topups: Record<string, { offers: unknown[]; fields?: unknown[] }>;
  giftcards: Record<string, { offers: unknown[] }>;
  errors: unknown[];
};

const scan = JSON.parse(readFileSync('scripts/out/fazer-scan.json', 'utf8')) as Scan;
const dump = JSON.parse(readFileSync('scripts/out/fazer-dump.json', 'utf8')) as { validateIdGames: { items: unknown[] } };
if (scan.errors.length > 0) {
  console.error(`The scan had ${scan.errors.length} errors; refusing to seed from an incomplete scan.`);
  process.exit(1);
}

// The blocklist is defined once, in the migration. Read it from there instead of copying it.
const migration = readFileSync('supabase/migrations/20260922140000_multifield_purchase_and_guards.sql', 'utf8');
const blocklist: Record<string, string> = {};
for (const m of migration.matchAll(/\('fazercards',\s*'(\w+)',\s*'([^']+)',\s*'((?:[^']|'')*)'\)/g)) {
  blocklist[`${m[1]}/${m[2]}`] = m[3].replace(/''/g, "'");
}
if (Object.keys(blocklist).length !== 7) {
  console.error(`Expected 7 blocked categories in the migration, found ${Object.keys(blocklist).length}.`);
  process.exit(1);
}

const validationGames = cleanValidationGames(dump.validateIdGames.items);
const listedAt = new Date(scan.scannedAt).toISOString();

const out: Record<string, unknown>[] = [];
const summary = { categories: 0, withPacks: 0, packsShown: 0, packsHidden: 0, blocked: 0, validated: 0 };
for (const [family, list] of [['topups', scan.topupCats], ['giftcards', scan.giftCats]] as const) {
  for (const cat of list) {
    const row = normalizeCategory(family, cat, { blocklist, validationGames, listedAt });
    if (!row) throw new Error(`Unusable category in the scan: ${cat.category_id}`);
    const raw = (family === 'topups' ? scan.topups : scan.giftcards)[cat.category_id];
    if (!raw) throw new Error(`No packs in the scan for ${family}/${cat.category_id}`);
    const offers = normalizeOffers(family, raw as { offers: unknown[]; fields?: unknown[] });
    if (offers.blocked_reason && !row.blocked_reason) row.blocked_reason = offers.blocked_reason;

    out.push({ ...row, offers: offers.offers, fields: offers.fields, hidden_offer_count: offers.hidden_offer_count, offers_fetched_at: listedAt });
    summary.categories++;
    summary.withPacks += offers.offers.length > 0 ? 1 : 0;
    summary.packsShown += offers.offers.length;
    summary.packsHidden += offers.hidden_offer_count;
    summary.blocked += row.blocked_reason ? 1 : 0;
    summary.validated += row.validation_category_id ? 1 : 0;
  }
}

// Sanity: the rule the database enforces, applied to what we are about to write.
for (const r of out as { family: 'topups' | 'giftcards'; category_id: string; blocked_reason: string | null }[]) {
  if (categoryBlockReason(r.family, r.category_id, blocklist) && !r.blocked_reason) throw new Error(`Blocked category not marked: ${r.category_id}`);
}

const COLUMNS = [
  'supplier text', 'family text', 'category_id text', 'name text', 'game_name text', 'region_label text', 'note_region text', 'note text',
  'validation_category_id text', 'validation_fields jsonb', 'blocked_reason text', 'listed_at timestamptz',
  'offers jsonb', 'fields jsonb', 'hidden_offer_count integer', 'offers_fetched_at timestamptz',
];
const NAMES = COLUMNS.map((c) => c.split(' ')[0]);
const LISTING = ['name', 'game_name', 'region_label', 'note_region', 'note', 'validation_category_id', 'validation_fields', 'blocked_reason', 'listed_at'];
const PACKS = ['offers', 'fields', 'hidden_offer_count', 'offers_fetched_at'];

function statement(rows: Record<string, unknown>[]): string {
  const tag = 'seedjson';
  const body = JSON.stringify(rows);
  if (body.includes(`$${tag}$`)) throw new Error('JSON contains the dollar-quote tag');
  const assign = (cols: string[], guard: string) => cols.map((c) => `${c} = case when ${guard} then excluded.${c} else supplier_catalog.${c} end`).join(',\n    ');
  return `insert into public.supplier_catalog (${NAMES.join(', ')})
select ${NAMES.join(', ')}
  from jsonb_to_recordset($${tag}$${body}$${tag}$::jsonb) as x(${COLUMNS.join(', ')})
on conflict (supplier, family, category_id) do update set
    ${assign(LISTING, 'excluded.listed_at >= supplier_catalog.listed_at')},
    ${assign(PACKS, 'supplier_catalog.offers_fetched_at is null or excluded.offers_fetched_at > supplier_catalog.offers_fetched_at')};
`;
}

const dir = 'scripts/out/seed-cache';
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (/^\d+\.sql$/.test(f)) rmSync(`${dir}/${f}`);
const PER_FILE = 60;
let files = 0;
for (let i = 0; i < out.length; i += PER_FILE) {
  files++;
  writeFileSync(`${dir}/${String(files).padStart(2, '0')}.sql`, statement(out.slice(i, i + PER_FILE)));
}

console.log(JSON.stringify({ scannedAt: listedAt, ...summary, files, dir }, null, 1));
