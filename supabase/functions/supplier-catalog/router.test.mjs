// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { SUPPLIERS, createRouter } from './router.ts';

function setup() {
  const seen = [];
  const make = (name) => async (req) => { seen.push([name, req.method, await req.clone().text().catch(() => '')]); return new Response(JSON.stringify({ handled_by: name }), { status: 200 }); };
  const route = createRouter({ fazercards: make('fazercards'), shop2topup: make('shop2topup') });
  const post = (body, raw = false) => route(new Request('https://x.test/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) }));
  return { seen, route, post };
}
const who = async (res) => (await res.json()).handled_by;

describe('which supplier a request is for', () => {
  it('names two suppliers', () => assert.deepEqual([...SUPPLIERS], ['fazercards', 'shop2topup']));
  it('a request with no supplier is FazerCards: everything that existed keeps working exactly as before', async () => {
    const { post } = setup();
    assert.equal(await who(await post({ action: 'refresh_catalog' })), 'fazercards');
    assert.equal(await who(await post({ action: 'load_offers', family: 'topups', category_id: 'x' })), 'fazercards');
  });
  it('"shop2topup" goes to the Shop2Topup handler, and "fazercards" to FazerCards', async () => {
    const { post } = setup();
    assert.equal(await who(await post({ action: 'refresh_catalog', supplier: 'shop2topup' })), 'shop2topup');
    assert.equal(await who(await post({ action: 'refresh_catalog', supplier: 'fazercards' })), 'fazercards');
  });
  it('the chosen handler still receives the whole, unread body', async () => {
    const { post, seen } = setup();
    await post({ action: 'load_offers', supplier: 'shop2topup', family: 'topups', category_id: '4' });
    assert.deepEqual(JSON.parse(seen[0][2]), { action: 'load_offers', supplier: 'shop2topup', family: 'topups', category_id: '4' });
  });
  it('an unknown supplier, or one that is not text, is refused (400) and reaches no handler', async () => {
    const { post, seen } = setup();
    for (const supplier of ['mpesa', '', 'FAZERCARDS', 5, null, {}, ['shop2topup']]) {
      const res = await post({ action: 'refresh_catalog', supplier });
      assert.equal(res.status, 400, JSON.stringify(supplier));
    }
    assert.equal(seen.length, 0);
  });
  it('a body that is not JSON is left to the handler to refuse', async () => {
    const { post } = setup();
    assert.equal(await who(await post('{nope', true)), 'fazercards');
  });
  it('OPTIONS and other methods are answered by the default handler, as ever', async () => {
    const { route } = setup();
    assert.equal(await who(await route(new Request('https://x.test/f', { method: 'OPTIONS' }))), 'fazercards');
  });
});

describe('the deployed wiring (source checks)', () => {
  const index = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  it('each supplier has its own key, and each one\'s saved rows are read and written by ITS name only', () => {
    assert.match(index, /FAZER_API_KEY/);
    assert.match(index, /SHOP2TOPUP_API_KEY/);
    assert.ok(!/\.eq\('supplier', 'fazercards'\)/.test(index), 'no hard-coded supplier in a query: it must come from the handler\'s own supplier');
  });
  it('a refresh of one supplier can only delete that supplier\'s rows', () => {
    assert.match(index, /delete\(\{ count: 'exact' \}\)\.eq\('supplier', supplier\)\.lt\('listed_at'/);
  });
});
