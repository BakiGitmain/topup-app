/**
 * OFFLINE analysis of scripts/out/fazer-scan.json. No API calls, no key needed.
 *   node scripts/fazer-analyze.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

type Offer = { offer_id?: string; card_id?: string | null; name: string; price_usd: string; stock?: number };
type Field = { key: string; label: string; type: string; options?: unknown[] };
type CatOffers = { category_id: string; name: string; note?: string; offers: Offer[]; fields?: Field[] };
type Cat = { category_id: string; name: string; note?: string };

const scan = JSON.parse(readFileSync('scripts/out/fazer-scan.json', 'utf8')) as {
  scannedAt: string;
  topupCats: Cat[];
  giftCats: Cat[];
  topups: Record<string, CatOffers>;
  giftcards: Record<string, CatOffers>;
  errors: { family: string; id: string; message: string }[];
};

const count = <K extends string>(m: Record<K, number>, k: K) => ((m[k] = (m[k] ?? 0) + 1), m);
const top = (m: Record<string, number>, n = 25) =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
const shape = (name: string) => name.toLowerCase().replace(/[\d][\d,.]*/g, '#').replace(/\s+/g, ' ').trim();

const out: Record<string, unknown> = {};
out.scannedAt = scan.scannedAt;
out.errors = scan.errors.length;
out.errorSample = scan.errors.slice(0, 5);

// ---------------------------------------------------------------- top-ups
const offers = Object.values(scan.topups).flatMap((c) => c.offers.map((o) => ({ ...o, cat: c.category_id })));
out.topupTotals = { categories: scan.topupCats.length, categoriesScanned: Object.keys(scan.topups).length, offers: offers.length,
  emptyCategories: Object.values(scan.topups).filter((c) => c.offers.length === 0).length };

// A consumable pack looks like "<number> <unit>", optionally "+ <bonus>".
const PACK = /^([\d][\d,.]*)\s*(?:\+\s*[\d,.]+\s*)?(?:bonus\s+)?([A-Za-z][A-Za-z .'&\-/]*?)\s*(?:\(.*\))?$/;
const units: Record<string, { offers: number; cats: Set<string> }> = {};
const nonPack: Record<string, { offers: number; cats: Set<string>; example: string }> = {};
for (const o of offers) {
  const m = o.name.trim().match(PACK);
  if (m) {
    const unit = m[2].trim().toLowerCase();
    (units[unit] ??= { offers: 0, cats: new Set() }).offers++;
    units[unit].cats.add(o.cat);
  } else {
    const s = shape(o.name);
    (nonPack[s] ??= { offers: 0, cats: new Set(), example: o.name }).offers++;
    nonPack[s].cats.add(o.cat);
  }
}
const unitRows = Object.entries(units).sort((a, b) => b[1].offers - a[1].offers);
out.currencyWords = {
  distinct: unitRows.length,
  top40: unitRows.slice(0, 40).map(([u, v]) => ({ unit: u, offers: v.offers, categories: v.cats.size })),
  packOffers: unitRows.reduce((n, [, v]) => n + v.offers, 0),
};
const npRows = Object.entries(nonPack).sort((a, b) => b[1].cats.size - a[1].cats.size);
out.nonPackNamePatterns = {
  distinct: npRows.length,
  nonPackOffers: npRows.reduce((n, [, v]) => n + v.offers, 0),
  top60: npRows.slice(0, 60).map(([p, v]) => ({ pattern: p, example: v.example, offers: v.offers, categories: v.cats.size })),
};

// keyword families that mean "not a consumable pack"
const KEYWORDS: Record<string, RegExp> = {
  weekly: /week/i, monthly: /month/i, membership: /member/i, lite: /\blite\b/i, pass: /\bpass\b/i,
  levelUp: /level ?up/i, evo: /evo ?access/i, season: /season|battle|royale/i, subscription: /subscri|prime|vip/i, bundle: /bundle|pack(age)?\b(?!\s*$)/i,
};
const kw: Record<string, { offers: number; cats: Set<string> }> = {};
for (const o of offers) for (const [k, re] of Object.entries(KEYWORDS)) if (re.test(o.name)) { (kw[k] ??= { offers: 0, cats: new Set() }).offers++; kw[k].cats.add(o.cat); }
out.membershipKeywords = Object.fromEntries(Object.entries(kw).map(([k, v]) => [k, { offers: v.offers, categories: v.cats.size }]));

// ---------------------------------------------------------------- buyer fields (drives the form)
const sigs: Record<string, { cats: string[] }> = {};
for (const c of Object.values(scan.topups)) {
  const sig = (c.fields ?? []).map((f) => `${f.key}:${f.type}`).join(' + ') || '(no fields)';
  (sigs[sig] ??= { cats: [] }).cats.push(c.category_id);
}
out.buyerFieldSets = Object.entries(sigs).sort((a, b) => b[1].cats.length - a[1].cats.length)
  .map(([sig, v]) => ({ fields: sig, categories: v.cats.length, examples: v.cats.slice(0, 4) }));
const labels: Record<string, number> = {};
for (const c of Object.values(scan.topups)) for (const f of c.fields ?? []) count(labels, `${f.key} = "${f.label}"`);
out.buyerFieldLabels = top(labels, 30);
out.fieldsWithSelectOptions = Object.values(scan.topups)
  .flatMap((c) => (c.fields ?? []).filter((f) => f.type === 'select').map((f) => ({ category: c.category_id, key: f.key, options: (f.options ?? []).slice(0, 4) })))
  .slice(0, 12);

// ---------------------------------------------------------------- regions
const paren = /\(([^)]+)\)\s*$/;
const games: Record<string, string[]> = {};
const regionTokens: Record<string, number> = {};
let noRegion = 0, withParen = 0, withNoteRegion = 0;
for (const c of scan.topupCats) {
  const p = c.name.match(paren);
  const base = c.name.replace(paren, '').trim();
  (games[base] ??= []).push(c.category_id);
  if (p) { withParen++; count(regionTokens, p[1]); } else noRegion++;
  if (/^Region:/m.test(c.note ?? '')) withNoteRegion++;
}
const gameRows = Object.entries(games).sort((a, b) => b[1].length - a[1].length);
out.regions = {
  topupCategoriesWithParenRegionInName: withParen,
  topupCategoriesWithoutRegionInName: noRegion,
  categoriesWithRegionLineInNote: withNoteRegion,
  distinctGameNamesAfterStrippingRegion: gameRows.length,
  gamesWithMoreThanOneRegion: gameRows.filter(([, v]) => v.length > 1).length,
  gamesWithExactlyOneCategory: gameRows.filter(([, v]) => v.length === 1).length,
  topMultiRegionGames: gameRows.slice(0, 15).map(([g, v]) => ({ game: g, regions: v.length })),
  topRegionTokens: top(regionTokens, 30),
};

// ---------------------------------------------------------------- gift cards
const cards = Object.values(scan.giftcards).flatMap((c) => c.offers.map((o) => ({ ...o, cat: c.category_id })));
const gcShapes: Record<string, number> = {};
const currencies: Record<string, number> = {};
for (const o of cards) {
  count(gcShapes, shape(o.name));
  const m = o.name.match(/\b([A-Z]{3})\b/);
  if (m) count(currencies, m[1]);
}
out.giftcards = {
  categories: scan.giftCats.length,
  categoriesScanned: Object.keys(scan.giftcards).length,
  offers: cards.length,
  emptyCategories: Object.values(scan.giftcards).filter((c) => c.offers.length === 0).length,
  offersWithNullCardId: cards.filter((o) => o.card_id === null).length,
  offersOutOfStock: cards.filter((o) => (o.stock ?? 0) === 0).length,
  categoriesWithRegionLineInNote: scan.giftCats.filter((c) => /^Region:/m.test(c.note ?? '')).length,
  denominationShapes: top(gcShapes, 25),
  currencyCodesInNames: top(currencies, 25),
};

writeFileSync('scripts/out/fazer-analysis.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
