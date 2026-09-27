// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { SUPPLIERS, createRouter } from './router.ts';

function setup() {
  const seen = [];
  const make = (name) => async (req) => { seen.push([name, req.method, await req.clone().text().catch(() => '')]); return new Response(JSON.stringify({ handled_by: name }), { status: 200 }); };
  const route = createRouter({ shop2topup: make('shop2topup'), gamesdrop: make('gamesdrop') });
  const post = (body, raw = false) => route(new Request('https://x.test/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) }));
  return { seen, route, post };
}
const who = async (res) => (await res.json()).handled_by;

describe('which supplier a request is for', () => {
  it('names exactly the two live suppliers, in this order: Shop2Topup, GamesDrop (FazerCards\' trial has ended)', () => {
    assert.deepEqual([...SUPPLIERS], ['shop2topup', 'gamesdrop']);
  });
  it('a request with no supplier is Shop2Topup', async () => {
    const { post } = setup();
    assert.equal(await who(await post({ action: 'refresh_catalog' })), 'shop2topup');
    assert.equal(await who(await post({ action: 'load_offers', family: 'topups', category_id: 'x' })), 'shop2topup');
  });
  it('naming either supplier explicitly reaches its own handler', async () => {
    const { post } = setup();
    assert.equal(await who(await post({ action: 'refresh_catalog', supplier: 'shop2topup' })), 'shop2topup');
    assert.equal(await who(await post({ action: 'refresh_catalog', supplier: 'gamesdrop' })), 'gamesdrop');
  });
  it('the chosen handler still receives the whole, unread body', async () => {
    const { post, seen } = setup();
    await post({ action: 'load_offers', supplier: 'gamesdrop', family: 'topups', category_id: '77' });
    assert.deepEqual(JSON.parse(seen[0][2]), { action: 'load_offers', supplier: 'gamesdrop', family: 'topups', category_id: '77' });
  });
  it('an unknown supplier -- including "fazercards", now that its trial has ended -- is refused (400) and reaches no handler', async () => {
    const { post, seen } = setup();
    for (const supplier of ['mpesa', 'fazercards', '', 'SHOP2TOPUP', 'GAMESDROP', 5, null, {}, ['shop2topup']]) {
      const res = await post({ action: 'refresh_catalog', supplier });
      assert.equal(res.status, 400, JSON.stringify(supplier));
    }
    assert.equal(seen.length, 0);
  });
  it('a body that is not JSON is left to the handler to refuse', async () => {
    const { post } = setup();
    assert.equal(await who(await post('{nope', true)), 'shop2topup');
  });
  it('OPTIONS and other methods are answered by the default handler, as ever', async () => {
    const { route } = setup();
    assert.equal(await who(await route(new Request('https://x.test/f', { method: 'OPTIONS' }))), 'shop2topup');
  });
  it('dispatch is still generic (a Record keyed by name), not a hard-coded branch: a third supplier is a handler and a name, not a rewrite', async () => {
    const seen2 = [];
    const route2 = createRouter({
      shop2topup: async () => new Response(JSON.stringify({ handled_by: 'shop2topup' }), { status: 200 }),
      gamesdrop: async () => new Response(JSON.stringify({ handled_by: 'gamesdrop' }), { status: 200 }),
      newcards: async () => {
        seen2.push('newcards');
        return new Response(JSON.stringify({ handled_by: 'newcards' }), { status: 200 });
      },
    });
    const res = await route2(
      new Request('https://x.test/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ supplier: 'newcards' }) })
    );
    // Still refused: SUPPLIERS (the list) decides who exists, not which keys happen to be on the handlers object.
    assert.equal(res.status, 400);
    assert.equal(seen2.length, 0);
  });
});

describe('the deployed wiring (source checks)', () => {
  const index = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  it('FazerCards is no longer called: no client, no key read, from this function (mentioning why in a comment is fine)', () => {
    assert.ok(!/new FazerCardsClient|npm:fazercards|Deno\.env\.get\('FAZER_API_KEY'\)/.test(index), 'FazerCards must not be called from supplier-catalog any more');
  });
  it('both live suppliers\' keys are read', () => {
    assert.match(index, /SHOP2TOPUP_API_KEY/);
    assert.match(index, /GAMESDROP_API_KEY/);
  });
  it('each supplier\'s saved rows are read and written by ITS OWN name only, not a hard-coded literal', () => {
    assert.ok(!/\.eq\('supplier', 'fazercards'\)/.test(index));
    assert.ok(!/\.eq\('supplier', 'shop2topup'\)/.test(index), 'still generic: the supplier comes from shared(supplier), not a literal in every query');
    assert.ok(!/\.eq\('supplier', 'gamesdrop'\)/.test(index));
  });
  it('a refresh of one supplier can only delete that supplier\'s rows', () => {
    assert.match(index, /delete\(\{ count: 'exact' \}\)\.eq\('supplier', supplier\)\.lt\('listed_at'/);
  });
  it('both handlers are registered with the router', () => {
    assert.match(index, /Deno\.serve\(createRouter\(\{ shop2topup: shop2topupHandler, gamesdrop: gamesdropHandler \}\)\)/);
  });
});
