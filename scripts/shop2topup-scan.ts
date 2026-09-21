/**
 * Read-only scan of the whole Shop2Topup catalog into scripts/out/shop2topup-scan.json (git-ignored: it holds wholesale prices).
 * Run: node --env-file=.env scripts/shop2topup-scan.ts
 * Tree: big category (a game or a brand) > category (a region / server variant) > subcategory (a pack, with its price).
 * Never calls anything under /orders (the client refuses it).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { s2, sleep } from './shop2topup-client.ts';

type Any = Record<string, any>;

async function getData(path: string): Promise<{ data: any; error: string | null }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await s2.get(path);
    if (r.http === 200 && r.body?.success) return { data: r.body.data, error: null };
    if (r.http === 429) {
      await sleep((r.retryAfter ?? 2) * 1000);
      continue;
    }
    if (r.http >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    return { data: null, error: `HTTP ${r.http} ${r.body?.error?.code ?? ''}` };
  }
  return { data: null, error: 'gave up' };
}

const big = (await getData('/catalog/big-categories')).data as Any[];
console.log('big categories:', big.length);

const errors: string[] = [];
const games: Any[] = [];
let done = 0;

async function scanGame(b: Any) {
  const cats = await getData(`/catalog/categories?bigCategoryId=${b.id}`);
  if (cats.error) errors.push(`categories ${b.id}: ${cats.error}`);
  const categories: Any[] = [];
  for (const c of (cats.data ?? []) as Any[]) {
    const [subs, req] = await Promise.all([getData(`/catalog/subcategories?categoryId=${c.id}`), getData(`/catalog/category/${c.id}/requirements`)]);
    if (subs.error) errors.push(`subcategories ${c.id}: ${subs.error}`);
    if (req.error) errors.push(`requirements ${c.id}: ${req.error}`);
    categories.push({ ...c, requirementFields: req.data ?? null, subcategories: subs.data ?? [] });
  }
  games.push({ ...b, categories });
  if (++done % 10 === 0) console.log(`  ${done}/${big.length}`);
}

// A few games at a time: the catalog limit is 5000 requests a minute, far above this.
const queue = [...big];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) await scanGame(b);
  })
);

games.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync('scripts/out', { recursive: true });
writeFileSync('scripts/out/shop2topup-scan.json', JSON.stringify({ scannedAt: new Date().toISOString(), errors, games }, null, 0));
const cats = games.reduce((n, g) => n + g.categories.length, 0);
const packs = games.reduce((n, g) => n + g.categories.reduce((m: number, c: Any) => m + c.subcategories.length, 0), 0);
console.log(`done: ${games.length} games, ${cats} categories, ${packs} packs, ${errors.length} errors`);
if (errors.length) console.log(errors.slice(0, 8).join('\n'));
