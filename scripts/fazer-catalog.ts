/**
 * READ-ONLY dump of the FazerCards catalog, to learn the real JSON shapes.
 *
 *   node --env-file=.env scripts/fazer-catalog.ts
 *
 * - Only catalog reads run. A guard throws if anything that could order, buy,
 *   create or change state is called.
 * - The API key is read from the environment and never printed.
 * - The full dump (it contains wholesale costs) is written to scripts/out/,
 *   which is git-ignored. Do not commit it or paste it anywhere public.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fz, sleep } from './fazer-client.ts';

/** Union of keys across items, with how many items have a real (non-null/empty) value. */
function keyCoverage(items: Record<string, unknown>[]) {
  const seen: Record<string, number> = {};
  for (const item of items) {
    for (const [k, v] of Object.entries(item)) {
      seen[k] ??= 0;
      if (v !== null && v !== undefined && v !== '') seen[k]++;
    }
  }
  return { total: items.length, fields: seen };
}

async function all<T>(iter: AsyncGenerator<T, void, void>, cap = 2000) {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

const dump: Record<string, unknown> = {};
const report: Record<string, unknown> = {};

// ---- top-ups
const topupCats = await all(fz.topups.iterCategories({ limit: 100 }));
dump.topupCategories = topupCats;
report.topupCategoryCoverage = keyCoverage(topupCats as unknown as Record<string, unknown>[]);
report.topupCategorySample = topupCats[0];

// offers for a few categories, chosen to expose naming patterns (regions, memberships, units)
const wanted = ['free_fire', 'pubg_mobile', 'mobile_legends', 'roblox', 'call_of_duty', 'genshin'];
const picks = topupCats.filter((c) => wanted.some((w) => c.category_id.includes(w))).slice(0, 5);
if (picks.length < 3) picks.push(...topupCats.slice(0, 3 - picks.length));
const topupOffers: Record<string, unknown> = {};
for (const cat of picks) {
  topupOffers[cat.category_id] = await fz.topups.offers(cat.category_id);
  await sleep(250);
}
dump.topupOffers = topupOffers;
const firstOffers = Object.values(topupOffers)[0] as { offers: unknown[]; fields: unknown[] };
report.topupOfferSample = { category: picks[0]?.category_id, offer: firstOffers?.offer?.[0] ?? firstOffers?.offers?.[0], fields: firstOffers?.fields };
report.topupOfferKeyCoverage = keyCoverage(
  Object.values(topupOffers).flatMap((o) => (o as { offers: Record<string, unknown>[] }).offers)
);
report.topupOfferNamesByCategory = Object.fromEntries(
  Object.entries(topupOffers).map(([id, o]) => [id, (o as { offers: { name: string }[] }).offers.slice(0, 14).map((x) => x.name)])
);
report.topupFieldsByCategory = Object.fromEntries(
  Object.entries(topupOffers).map(([id, o]) => [id, (o as { fields: unknown[] }).fields])
);
report.topupCategoryNote = Object.fromEntries(picks.map((c) => [c.category_id, c.note ?? null]));

// ---- validation namespace (which games can validate an id, and with which fields)
dump.validateIdGames = await fz.topups.validateIdGames();
report.validateIdGamesSample = (dump.validateIdGames as { items: unknown[] }).items.slice(0, 3);
report.validateIdGameCount = (dump.validateIdGames as { items: unknown[] }).items.length;

// ---- gift cards
const giftCats = await all(fz.giftcards.iterCategories({ limit: 100 }));
dump.giftcardCategories = giftCats;
report.giftcardCategoryCoverage = keyCoverage(giftCats as unknown as Record<string, unknown>[]);
report.giftcardCategorySample = giftCats[0];
const giftOffers: Record<string, unknown> = {};
for (const cat of giftCats.slice(0, 3)) {
  giftOffers[cat.category_id] = await fz.giftcards.cards(cat.category_id);
  await sleep(250);
}
dump.giftcardOffers = giftOffers;
const firstGift = Object.values(giftOffers)[0] as { offers: unknown[] };
report.giftcardOfferSample = firstGift?.offers?.[0];
report.giftcardOfferKeyCoverage = keyCoverage(
  Object.values(giftOffers).flatMap((o) => (o as { offers: Record<string, unknown>[] }).offers)
);

// ---- telegram premium
dump.telegramPremium = await fz.telegram.premium();
report.telegramPremium = dump.telegramPremium;

// ---- game keys (one small page, for the shape only)
const keyGames = await fz.gamekeys.games({ limit: 3 });
dump.gamekeysGames = keyGames;
report.gamekeysGamesSample = keyGames.items?.[0];

mkdirSync('scripts/out', { recursive: true });
writeFileSync('scripts/out/fazer-dump.json', JSON.stringify(dump, null, 2));
writeFileSync('scripts/out/fazer-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ topupCategories: topupCats.length, giftcardCategories: giftCats.length, offerCategoriesSampled: picks.map((c) => c.category_id) }));
console.log('Wrote scripts/out/fazer-dump.json and scripts/out/fazer-report.json (git-ignored).');
