/**
 * Read-only audit: which Shop2Topup top-up categories have a validate endpoint that can actually be trusted.
 * Run: node --env-file=.env scripts/shop2topup-validate-audit.ts
 * Needs scripts/out/shop2topup-scan.json (node --env-file=.env scripts/shop2topup-scan.ts). Writes scripts/out/shop2topup-validate-audit.json
 * (git-ignored) and keeps the previous run as ...audit.prev.json, so a second run shows what changed.
 *
 * It never orders anything (scripts/shop2topup-client.ts refuses /orders) and prints only names and result codes, never an ID's owner.
 * Every ID used is made up, so "not found" is the EXPECTED answer of a working check. One call per category (next pack, at most 3,
 * when a pack is "temporarily unavailable"), then a second stage for categories that answered: a check only counts as real if it
 * REJECTS nonsense, because a stub that approves anything would put a green tick on a wrong ID.
 *
 *   real         found or rejected IDs correctly: PLAYER_NOT_FOUND for a nonsense ID, and never "valid" for text as an ID
 *   loose        answered "valid" for something that can't be a player ID: it does not check anything; DO NOT rely on it
 *   inconsistent answered "valid" for some IDs but "unavailable" (not "not found") for others: not a usable check
 *   unavailable  PLAYER_CHECK_UNAVAILABLE ("can't be verified right now, retry in a few minutes"); no verdict on the game
 *   no-pack      every pack tried was PRODUCT_UNAVAILABLE (the category is out of stock: no verdict)
 *   other        anything else, printed with its code
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { s2, sleep } from './shop2topup-client.ts';

type Field = { field_name: string; data_type?: string; select_options?: string[] };
type Sub = { id: number; name: string };
type Cat = { id: number; name: string; requirements: unknown; requirementFields?: Field[]; subcategories?: Sub[] };
type Game = { id: number; name: string; categories: Cat[] };
const scan = JSON.parse(readFileSync('scripts/out/shop2topup-scan.json', 'utf8')) as { games: Game[] };
const outFile = 'scripts/out/shop2topup-validate-audit.json';
const prevFile = 'scripts/out/shop2topup-validate-audit.prev.json';

type Row = { game: string; category_id: number; category: string; requirements: string; packs_tried: number[]; http: number; code: string; verdict: string; detail: string };

/** The made-up form values for a category: a select gets its first real option, a name gets "x", other text a number. */
function bodyFor(cat: Cat, playerId: string): Record<string, string> {
  const body: Record<string, string> = { player_id: playerId };
  for (const f of cat.requirementFields ?? []) {
    if (f.field_name === 'player_id') continue;
    body[f.field_name] = f.data_type === 'single_select' && f.select_options?.[0] ? f.select_options[0] : f.field_name === 'charname' ? 'x' : '1234';
  }
  return body;
}

async function ask(sub: number, cat: Cat, playerId: string) {
  const { player_id, ...rest } = bodyFor(cat, playerId);
  let r = await s2.validate({ sub_category_id: sub, player_id, ...rest } as never);
  for (let attempt = 0; r.http === 429 && attempt < 3; attempt++) {
    await sleep((r.retryAfter ?? 5) * 1000);
    r = await s2.validate({ sub_category_id: sub, player_id, ...rest } as never);
  }
  await sleep(350);
  const code = String(r.body?.error?.code ?? (r.body?.success === true ? 'OK' : r.body?.error_code ?? 'none'));
  return { http: r.http, code };
}
const found = (a: { http: number; code: string }) => a.http === 200 || a.code === 'REGION_MISMATCH' || a.code === 'PLAYER_NOT_FOUND';

const previous: Row[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : [];
if (previous.length > 0) copyFileSync(outFile, prevFile);

const rows: Row[] = [];
for (const game of scan.games) {
  for (const cat of game.categories) {
    if (typeof cat.requirements !== 'string' || cat.requirements.trim() === '') continue; // vouchers: nothing to check
    const tried: number[] = [];
    let last = { http: 0, code: '' };
    let usable: number | null = null;
    for (const sub of (cat.subcategories ?? []).slice(0, 3)) {
      tried.push(sub.id);
      last = await ask(sub.id, cat, '123456789');
      if (last.code !== 'PRODUCT_UNAVAILABLE') {
        usable = sub.id;
        break;
      }
    }
    let verdict = 'other';
    let detail = '';
    if (tried.length === 0 || last.code === 'PRODUCT_UNAVAILABLE') verdict = 'no-pack';
    else if (last.code === 'PLAYER_CHECK_UNAVAILABLE') verdict = 'unavailable';
    else if (usable !== null && found(last)) {
      // Second stage: does it reject nonsense? "1" and letters cannot be player IDs.
      const one = await ask(usable, cat, '1');
      const letters = await ask(usable, cat, 'abcdefghi');
      if (letters.http === 200) {
        verdict = 'loose';
        detail = 'approved letters as an ID';
      } else if (last.code === 'PLAYER_NOT_FOUND' || one.code === 'PLAYER_NOT_FOUND') {
        verdict = 'real';
        detail = `"1" -> ${one.code}`;
      } else {
        verdict = 'inconsistent';
        detail = `"1" -> ${one.http} ${one.code}`;
      }
    }
    rows.push({ game: game.name, category_id: cat.id, category: cat.name, requirements: cat.requirements, packs_tried: tried, http: last.http, code: last.code, verdict, detail });
  }
}
writeFileSync(outFile, JSON.stringify(rows, null, 1));

const byVerdict = new Map<string, Row[]>();
for (const r of rows) byVerdict.set(r.verdict, [...(byVerdict.get(r.verdict) ?? []), r]);
console.log(`${rows.length} top-up categories in ${new Set(rows.map((r) => r.game)).size} games`);
for (const [verdict, list] of [...byVerdict.entries()].sort()) {
  const games = [...new Set(list.map((r) => r.game))];
  console.log(`\n## ${verdict}: ${list.length} categories in ${games.length} games`);
  if (verdict === 'unavailable') console.log('  ' + games.join(', '));
  else for (const r of list) console.log(`  ${r.game} | ${r.category} (${r.category_id}) | ${r.requirements} | ${r.http} ${r.code}${r.detail ? ' | ' + r.detail : ''}`);
}
if (previous.length > 0) {
  const flips = rows.filter((r) => previous.find((p) => p.category_id === r.category_id && p.verdict !== r.verdict));
  console.log(`\nchanged since the previous run: ${flips.length}`);
  for (const r of flips) console.log(`  ${r.game} | ${r.category} (${r.category_id}): ${previous.find((p) => p.category_id === r.category_id)?.verdict} -> ${r.verdict}`);
}
