/**
 * READ-ONLY scan of EVERY top-up and gift-card category (about 885 catalog
 * reads, paced under the 300/min limit). Writes scripts/out/fazer-scan.json
 * (git-ignored: it contains wholesale costs). Analyse it offline with
 * scripts/fazer-analyze.ts; no more API calls needed for that.
 *
 *   node --env-file=.env scripts/fazer-scan.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fz, sleep } from './fazer-client.ts';

const PACE_MS = 200; // ~5 requests/s, comfortably inside 300/min with latency on top

async function all<T>(iter: AsyncGenerator<T, void, void>) {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

const topupCats = await all(fz.topups.iterCategories({ limit: 100 }));
const giftCats = await all(fz.giftcards.iterCategories({ limit: 100 }));
console.log(`categories: topups=${topupCats.length} giftcards=${giftCats.length}`);

const topups: Record<string, unknown> = {};
const giftcards: Record<string, unknown> = {};
const errors: { family: string; id: string; message: string }[] = [];
const started = Date.now();
let done = 0;
const total = topupCats.length + giftCats.length;

async function pull(family: 'topups' | 'giftcards', id: string) {
  try {
    if (family === 'topups') topups[id] = await fz.topups.offers(id);
    else giftcards[id] = await fz.giftcards.cards(id);
  } catch (err) {
    // Status and code only: never the response body.
    const e = err as { status?: number; code?: string; message?: string };
    errors.push({ family, id, message: `${e.status ?? ''} ${e.code ?? ''} ${String(e.message ?? '').slice(0, 80)}` });
  }
  done++;
  if (done % 50 === 0) {
    console.log(`${done}/${total}  errors=${errors.length}  ${Math.round((Date.now() - started) / 1000)}s`);
  }
  await sleep(PACE_MS);
}

for (const c of topupCats) await pull('topups', c.category_id);
for (const c of giftCats) await pull('giftcards', c.category_id);

mkdirSync('scripts/out', { recursive: true });
writeFileSync(
  'scripts/out/fazer-scan.json',
  JSON.stringify({ scannedAt: new Date().toISOString(), topupCats, giftCats, topups, giftcards, errors }, null, 1)
);
console.log(`DONE ${done}/${total} in ${Math.round((Date.now() - started) / 1000)}s, errors=${errors.length}`);
console.log('Wrote scripts/out/fazer-scan.json');
