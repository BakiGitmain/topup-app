// Run with: npm run test:unit. The outbox and Telegram are faked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { createHandler } from './handler.ts';

const KEY = 'service-role-key-value';
const CONFIG = { token: '123456789:AAEhBOweik6ad9r_QXmLEXAMPLEEXAMPLE1', chatId: '-100123456' };

function setup({ rows = [{ id: 'n1', body: 'Deposit received\nAmount: Br 500' }], config = CONFIG, send } = {}) {
  const marks = [];
  const logs = [];
  const sent = [];
  const deps = {
    isServiceCaller: (t) => t === KEY,
    config: () => config,
    claim: async () => rows,
    mark: async (id, ok, error) => { marks.push({ id, ok, error }); },
    send: send ?? (async (c, text) => { sent.push({ c, text }); return { ok: true }; }),
    log: (e) => logs.push(e),
  };
  const handle = createHandler(deps);
  const post = async (token = KEY, method = 'POST') => {
    const r = await handle(new Request('https://x.test/telegram-notify', { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: method === 'POST' ? '{}' : undefined }));
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  return { post, marks, logs, sent };
}

describe('who may call it', () => {
  it('nobody without the service key: no header, a customer token, a guess', async () => {
    for (const token of [null, 'a-customer-jwt', 'guess', '']) {
      const { post, marks, sent } = setup();
      const r = await post(token);
      assert.equal(r.status, 401, String(token));
      assert.deepEqual(r.body, { error: 'unauthorized' });
      assert.equal(marks.length + sent.length, 0, 'nothing is claimed or sent for an unauthorised caller');
    }
  });
  it('only POST', async () => {
    assert.equal((await setup().post(KEY, 'GET')).status, 405);
  });
});

describe('sending', () => {
  it('sends each queued message once, exactly as the database wrote it, and marks it sent', async () => {
    const { post, marks, sent } = setup({ rows: [{ id: 'n1', body: 'one' }, { id: 'n2', body: 'two' }] });
    const r = await post();
    assert.deepEqual(r.body, { sent: 2, failed: 0 });
    assert.deepEqual(sent.map((s) => s.text), ['one', 'two']);
    assert.deepEqual(marks, [{ id: 'n1', ok: true, error: undefined }, { id: 'n2', ok: true, error: undefined }]);
  });
  it('nothing queued: nothing sent, no error', async () => {
    const { post, sent } = setup({ rows: [] });
    assert.deepEqual((await post()).body, { sent: 0, failed: 0 });
    assert.equal(sent.length, 0);
  });
  it('the message content never comes from the request', async () => {
    const { post, sent } = setup({ rows: [{ id: 'n1', body: 'from the database' }] });
    const r = await post();
    assert.equal(r.status, 200);
    assert.deepEqual(sent.map((s) => s.text), ['from the database']);
  });
  it('a failed send stays queued with a short reason', async () => {
    const { post, marks } = setup({ send: async () => ({ ok: false, error: 'network' }) });
    const r = await post();
    assert.deepEqual(r.body, { sent: 0, failed: 1 });
    assert.deepEqual(marks, [{ id: 'n1', ok: false, error: 'network' }]);
  });
  it('a bad token stops after the first attempt and leaves the rest queued (no hammering Telegram)', async () => {
    let calls = 0;
    const { post, marks } = setup({
      rows: [{ id: 'a', body: '1' }, { id: 'b', body: '2' }, { id: 'c', body: '3' }],
      send: async () => { calls++; return { ok: false, error: 'http_401' }; },
    });
    const r = await post();
    assert.equal(calls, 1);
    assert.deepEqual(r.body, { sent: 0, failed: 3 });
    assert.deepEqual(marks.map((m) => [m.id, m.ok, m.error]), [['a', false, 'http_401'], ['b', false, 'http_401'], ['c', false, 'http_401']]);
  });
  it('a temporary failure on one message does not stop the others', async () => {
    let n = 0;
    const { post, marks } = setup({
      rows: [{ id: 'a', body: '1' }, { id: 'b', body: '2' }],
      send: async () => (++n === 1 ? { ok: false, error: 'http_429' } : { ok: true }),
    });
    const r = await post();
    assert.deepEqual(r.body, { sent: 1, failed: 1 });
    assert.deepEqual(marks.map((m) => [m.id, m.ok]), [['a', false], ['b', true]]);
  });
});

describe('when the Telegram secrets are missing or malformed: loud, never silent', () => {
  it('answers 503, sends nothing, and records why on every queued row', async () => {
    const { post, marks, sent, logs } = setup({ config: null, rows: [{ id: 'a', body: '1' }, { id: 'b', body: '2' }] });
    const r = await post();
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'telegram_not_configured', queued: 2 });
    assert.equal(sent.length, 0);
    assert.deepEqual(marks.map((m) => [m.id, m.ok, m.error]), [['a', false, 'not_configured'], ['b', false, 'not_configured']]);
    assert.ok(logs.some((l) => l.outcome === 'not_configured'));
  });
});

describe('hygiene', () => {
  it('logs never contain the token, the chat id, or any message text', async () => {
    const { post, logs } = setup({ rows: [{ id: 'n1', body: 'Customer Abel <a@x.com> 0911223344' }] });
    await post();
    await setup({ config: null }).post();
    const all = JSON.stringify(logs);
    assert.ok(!all.includes(CONFIG.token) && !all.includes(CONFIG.chatId) && !all.includes('0911223344') && !all.includes('a@x.com'));
  });
  it('a database failure is a 500 with no internals', async () => {
    const handle = createHandler({
      isServiceCaller: () => true, config: () => CONFIG, claim: async () => { throw new Error('connection to db.internal:5432 refused'); },
      mark: async () => {}, send: async () => ({ ok: true }), log: () => {},
    });
    const r = await handle(new Request('https://x.test', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' }));
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'server_error' });
  });
});

describe('wiring guards (source checks)', () => {
  const root = new URL('../../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  it('the app never references the Telegram secrets or the notify function', () => {
    const walk = (dir) => fs.readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]);
    for (const file of walk('src/').filter((f) => /\.(ts|tsx)$/.test(f))) {
      const text = read(file);
      assert.ok(!/TELEGRAM_|telegram-notify|api\.telegram\.org/i.test(text), `${file} must not know about Telegram`);
    }
  });
  it('the function compares against the service key only, in constant time, and takes no message from the request', () => {
    const index = read('supabase/functions/telegram-notify/index.ts');
    assert.match(index, /isServiceCaller: \(token\) => sameSecret\(token, SERVICE_KEY\)/);
    const handler = read('supabase/functions/telegram-notify/handler.ts');
    assert.ok(!/req\.json\(\)/.test(handler), 'the request body is never read');
  });
  it('no function calls another over HTTP for notifications: they send in-process', () => {
    for (const f of ['verify-deposit/index.ts', 'wallet-request/index.ts']) {
      const text = read(`supabase/functions/${f}`);
      assert.ok(!text.includes('functions.invoke'), `${f} must not depend on another function's auth`);
      assert.ok(text.includes('flushNotifications(admin)'), f);
    }
  });
  it('the token is never logged or returned by the shared sender', () => {
    const t = read('supabase/functions/_shared/telegram.ts');
    assert.ok(!/console\./.test(t));
  });
});
