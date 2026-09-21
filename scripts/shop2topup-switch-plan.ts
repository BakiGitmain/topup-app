/**
 * DRY RUN of the FazerCards -> Shop2Topup switch for the live Free Fire and PUBG Mobile products. It CHANGES NOTHING: it reads
 * three git-ignored files and (only for the ID replay) makes read-only validate calls.
 *
 *   scripts/out/live-ff-pubg.json          the live packs (supabase db query --linked -o json, see the SQL in CLAUDE.md)
 *   scripts/out/live-id-validations.json   real ID checks FazerCards already answered
 *   scripts/out/shop2topup-scan.json       Shop2Topup's catalog (node --env-file=.env scripts/shop2topup-scan.ts)
 *
 * Run: node --env-file=.env scripts/shop2topup-switch-plan.ts     Writes scripts/out/switch-plan.json (has wholesale costs).
 * IDs and player names are never printed: only "same / different" and account-region codes.
 *
 * How a pack is matched: by the TOTAL amount and unit ("100 + 10 Diamonds" is 110 Diamonds; "300 + 25 UC" is 325 UC), else by its exact
 * name ("Weekly Membership", "Prime (1 Month)"). A key that matches no pack or more than one is FLAGGED, never guessed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createShop2TopupClient, validateWithAnyPack } from '../supabase/functions/_shared/shop2topup.ts';

const RATE = 175; // only to show markups; the real rate is the admin setting

const parseJson = (file: string) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('{')));
};
type Live = { product: string; region: string; region_id: string; option_id: string; label: string; price: string; is_active: boolean; has_image: boolean; has_category: boolean; region_locked: boolean; codes: string[]; supplier: string; supplier_category: string; offer_ref: string; supplier_offer_name: string; cost: string };
const live: Live[] = parseJson('scripts/out/live-ff-pubg.json').rows;
const scan = JSON.parse(readFileSync('scripts/out/shop2topup-scan.json', 'utf8')) as { games: { name: string; categories: { id: number; name: string; subcategories: { id: number; name: string; price: number }[] }[] }[] };
const s2Cats = new Map(scan.games.flatMap((g) => g.categories.map((c) => [c.id, { game: g.name, ...c }] as const)));

/** Which Shop2Topup category each live region becomes. */
const TARGET: Record<string, number> = { 'Free Fire|MENA': 4, 'Free Fire|LATAM': 484, 'PUBG Mobile|Auto': 2 };

function keyOf(name: string): string {
  const n = name.toLowerCase().replace(/,/g, '').trim();
  const m = /^(\d+)\s*(?:\+\s*(\d+)\s*)?([a-z][a-z .'&/-]*)$/.exec(n);
  if (m) return `qty:${Number(m[1]) + Number(m[2] ?? 0)}:${m[3].trim()}`;
  return `name:${n.replace(/[^a-z0-9]/g, '')}`;
}

type Row = {
  label: string; price: number; image: boolean; active: boolean;
  from: { offer_ref: string; name: string; cost: number };
  to: { sub_id: number; name: string; cost: number } | null;
  costChangePct: number | null; markupBefore: number; markupAfter: number | null; flags: string[];
};
type RegionPlan = { product: string; region: string; fromCategory: string; toCategory: number; toCategoryName: string; rows: Row[]; extras: { id: number; name: string; cost: number }[]; lock: { locked: number; codes: string } };
const plans: RegionPlan[] = [];

for (const [key, toId] of Object.entries(TARGET)) {
  const [product, region] = key.split('|');
  const packs = live.filter((r) => r.product === product && r.region === region);
  const cat = s2Cats.get(toId)!;
  const byKey = new Map<string, { id: number; name: string; price: number }[]>();
  for (const s of cat.subcategories) byKey.set(keyOf(s.name), [...(byKey.get(keyOf(s.name)) ?? []), s]);
  const used = new Set<number>();
  const rows: Row[] = [];
  for (const p of packs) {
    const candidates = byKey.get(keyOf(p.supplier_offer_name ?? p.label)) ?? [];
    const flags: string[] = [];
    let to: Row['to'] = null;
    if (candidates.length === 0) flags.push('NO MATCH at Shop2Topup');
    else if (candidates.length > 1) flags.push(`AMBIGUOUS: ${candidates.length} Shop2Topup packs have this amount (${candidates.map((c) => c.id).join(', ')})`);
    else if (used.has(candidates[0].id)) flags.push('Shop2Topup pack already taken by another live pack');
    else {
      to = { sub_id: candidates[0].id, name: candidates[0].name, cost: candidates[0].price };
      used.add(candidates[0].id);
    }
    const oldCost = Number(p.cost);
    const price = Number(p.price);
    const costChangePct = to ? Math.round((to.cost / oldCost - 1) * 1000) / 10 : null;
    const markupBefore = Math.round((price / (oldCost * RATE) - 1) * 1000) / 10;
    const markupAfter = to ? Math.round((price / (to.cost * RATE) - 1) * 1000) / 10 : null;
    if (to && price < to.cost * RATE) flags.push(`price ${price} is BELOW new cost x ${RATE} (${Math.round(to.cost * RATE)})`);
    if (costChangePct !== null && costChangePct > 5) flags.push(`cost up ${costChangePct}%`);
    rows.push({ label: p.label, price, image: p.has_image, active: p.is_active, from: { offer_ref: p.offer_ref, name: p.supplier_offer_name, cost: oldCost }, to, costChangePct, markupBefore, markupAfter, flags });
  }
  const extras = cat.subcategories.filter((s) => !used.has(s.id)).map((s) => ({ id: s.id, name: s.name, cost: s.price }));
  plans.push({ product, region, fromCategory: packs[0].supplier_category, toCategory: toId, toCategoryName: `${cat.game} | ${cat.name}`, rows, extras, lock: { locked: packs.filter((p) => p.region_locked).length, codes: [...new Set(packs.map((p) => JSON.stringify(p.codes)))].join(' ') } });
}

// ---- the ID replay: real checks FazerCards answered, asked of Shop2Topup
const client = createShop2TopupClient({ key: process.env.SHOP2TOPUP_API_KEY ?? '', timeoutMs: 15_000 });
type Rec = { product: string; region: string; fields: Record<string, string>; account_region: string | null; player_name: string | null };
const recs: Rec[] = parseJson('scripts/out/live-id-validations.json').rows;
const seen = new Set<string>();
const replay: string[] = [];
for (const r of recs) {
  const id = r.fields?.player_id;
  const dedupe = `${r.product}|${r.region}|${id}`;
  if (!id || seen.has(dedupe)) continue;
  seen.add(dedupe);
  const toId = TARGET[`${r.product}|${r.region}`];
  if (!toId) continue;
  const packIds = s2Cats.get(toId)!.subcategories.map((s) => s.id);
  let line: string;
  try {
    const out = await validateWithAnyPack(client, packIds, { playerId: id });
    line = `${r.product} ${r.region}: Shop2Topup FOUND the account | name ${out.player_name === r.player_name ? 'SAME' : 'DIFFERENT'} | region FazerCards=${r.account_region ?? 'none'} Shop2Topup=${out.region ?? 'none'} ${(out.region ?? null) === (r.account_region ?? null) ? '(same)' : '(DIFFERENT)'}`;
  } catch (e) {
    line = `${r.product} ${r.region}: Shop2Topup ${(e as { code?: string }).code ?? 'error'} (${(e as { status?: number }).status})`;
  }
  replay.push(line);
  await new Promise((res) => setTimeout(res, 400));
}

writeFileSync('scripts/out/switch-plan.json', JSON.stringify({ plans, replay }, null, 1));

const m = (n: number | null) => (n === null ? '-' : `${n}%`);
for (const p of plans) {
  console.log(`\n### ${p.product} / ${p.region}:  ${p.fromCategory} (FazerCards)  ->  ${p.toCategoryName} (id ${p.toCategory})`);
  console.log(`region lock kept as is: ${p.lock.locked}/${p.rows.length} packs locked, codes ${p.lock.codes}`);
  console.log('| pack (label kept) | price kept | image | FazerCards offer -> Shop2Topup pack | cost USD old -> new | markup at 175: before -> after | flags |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of p.rows) {
    console.log(`| ${r.label} | ${r.price} | ${r.image ? 'kept' : 'none'} | ${r.from.offer_ref} -> ${r.to ? `${r.to.sub_id} "${r.to.name}"` : 'NONE'} | ${r.from.cost} -> ${r.to?.cost.toFixed(4) ?? '-'} (${m(r.costChangePct)}) | ${r.markupBefore}% -> ${m(r.markupAfter)} | ${r.flags.join('; ') || '-'} |`);
  }
  console.log(`unmatched live packs: ${p.rows.filter((r) => !r.to).length}; Shop2Topup packs NOT in the live product (nothing is added): ${p.extras.length}`);
  console.log('  ' + p.extras.map((e) => `${e.id} ${e.name} ($${e.cost.toFixed(2)})`).join('; '));
}
console.log('\n### ID replay (real IDs FazerCards answered, asked of Shop2Topup)');
for (const l of replay) console.log('  ' + l);
