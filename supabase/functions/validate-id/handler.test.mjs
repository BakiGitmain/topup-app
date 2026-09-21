// Run with: npm run test:unit. Every outside dependency is faked, so no network and no supplier.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHandler } from './handler.ts';

const FAR = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const REGION = '11111111-2222-3333-4444-555555555555';
const FF_TARGET = {
  id_validation: 'supplier',
  buyer_fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }],
  validation_category_id: 'free_fire',
  validation_field_map: {},
};

function setup(overrides = {}) {
  const calls = { supplier: [], record: [], logs: [], slots: 0 };
  const deps = {
    timeoutMs: 200,
    getUserId: async (t) => (t === 'good-token' ? 'user-1' : null),
    claimSlot: async () => { calls.slots++; return true; },
    getTarget: async () => FF_TARGET,
    supplierValidate: async (cat, fields) => {
      calls.supplier.push({ cat, fields });
      return { category_id: cat, valid: true, player_name: '  ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄  ', player_id: '1', region: 'ME' };
    },
    record: async (user, region, fields, acct, name) => {
      calls.record.push({ user, region, fields, acct, name });
      return { validation_id: 'val-1', valid_until: FAR };
    },
    log: (e) => calls.logs.push(e),
    ...overrides,
  };
  const handle = createHandler(deps);
  const call = (body, { token = 'good-token', method = 'POST', raw } = {}) =>
    handle(new Request('https://x.test/validate-id', {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
    }));
  return { call, calls };
}
const ok = { region_id: REGION, fields: { player_id: '3327205705' } };
const read = async (res) => ({ status: res.status, body: await res.json() });

describe('happy path', () => {
  it('a valid ID is recorded and the customer gets name, region and record id', async () => {
    const { call, calls } = setup();
    const { status, body } = await read(await call(ok));
    assert.equal(status, 200);
    const { expires_in, ...rest } = body;
    assert.deepEqual(rest, { status: 'valid', validation_id: 'val-1', expires_at: FAR, player_name: '  ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄  ', account_region: 'ME' });
    assert.ok(expires_in > 890 && expires_in <= 900, String(expires_in));
    assert.deepEqual(calls.record[0], { user: 'user-1', region: REGION, fields: { player_id: '3327205705' }, acct: 'ME', name: '  ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄  ' });
  });
  it('the supplier is called with the VALIDATION category, not a purchase one', async () => {
    const { call, calls } = setup();
    await call(ok);
    assert.deepEqual(calls.supplier, [{ cat: 'free_fire', fields: { player_id: '3327205705' } }]);
  });
  it('the response never contains supplier costs, keys or the raw supplier body', async () => {
    const { call } = setup({ supplierValidate: async () => ({ valid: true, player_name: 'N', region: 'ME', price_usd: 0.9, api_key: 'sekret', balance: 42 }) });
    const text = JSON.stringify((await read(await call(ok))).body);
    assert.doesNotMatch(text, /price|usd|sekret|api_key|balance/i);
  });
  it('a missing player name or region comes back as null', async () => {
    const { call } = setup({ supplierValidate: async () => ({ valid: true }) });
    const { body } = await read(await call(ok));
    assert.equal(body.status, 'valid');
    assert.equal(body.player_name, null);
    assert.equal(body.account_region, null);
  });
  it('field maps: buys with server_id, validates with zone_id', async () => {
    const { call, calls } = setup({
      getTarget: async () => ({ ...FF_TARGET, validation_category_id: 'mobile_legends', validation_field_map: { server_id: 'zone_id' },
        buyer_fields: [{ key: 'player_id' }, { key: 'server_id' }] }),
    });
    await call({ region_id: REGION, fields: { player_id: '1', server_id: '2' } });
    assert.deepEqual(calls.supplier[0].fields, { player_id: '1', zone_id: '2' });
    assert.deepEqual(calls.record[0].fields, { player_id: '1', server_id: '2' }, 'the record keeps the PURCHASE keys');
  });
});

describe('the supplier says no, or cannot answer', () => {
  const fail = (status, message = 'x') => async () => { throw Object.assign(new Error(message), { status }); };
  it('422 (the shape we saw for a made-up ID) is "invalid", and nothing is recorded', async () => {
    const { call, calls } = setup({ supplierValidate: fail(422, 'We could not validate this Player ID. Please contact support.') });
    const { status, body } = await read(await call(ok));
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'invalid' });
    assert.equal(calls.record.length, 0);
  });
  it('the supplier\'s own message text is never passed on', async () => {
    const { call } = setup({ supplierValidate: fail(422, 'Please contact support.') });
    assert.doesNotMatch(JSON.stringify((await read(await call(ok))).body), /support|contact/i);
  });
  it('valid:false is invalid', async () => {
    const { call, calls } = setup({ supplierValidate: async () => ({ valid: false }) });
    assert.deepEqual((await read(await call(ok))).body, { status: 'invalid' });
    assert.equal(calls.record.length, 0);
  });
  for (const shape of [null, {}, { valid: 'true' }, { valid: 1 }, 'ok', []]) {
    it(`an unrecognised result (${JSON.stringify(shape)}) is NOT treated as valid`, async () => {
      const { call, calls } = setup({ supplierValidate: async () => shape });
      assert.deepEqual((await read(await call(ok))).body, { status: 'invalid' });
      assert.equal(calls.record.length, 0);
    });
  }
  for (const status of [null, 401, 403, 429, 500, 502, 503, 504]) {
    it(`supplier status ${status} is "unavailable", never "invalid"`, async () => {
      const { call, calls } = setup({ supplierValidate: fail(status) });
      assert.deepEqual((await read(await call(ok))).body, { status: 'unavailable' });
      assert.equal(calls.record.length, 0);
    });
  }
  it('a supplier that never answers is cut off and reported as unavailable', async () => {
    const { call, calls } = setup({ timeoutMs: 40, supplierValidate: () => new Promise(() => {}) });
    const started = Date.now();
    assert.deepEqual((await read(await call(ok))).body, { status: 'unavailable' });
    assert.ok(Date.now() - started < 1000);
    assert.equal(calls.record.length, 0);
  });
  it('a network failure with no status is unavailable', async () => {
    const { call } = setup({ supplierValidate: async () => { throw new TypeError('fetch failed'); } });
    assert.deepEqual((await read(await call(ok))).body, { status: 'unavailable' });
  });
});

describe('who may call it', () => {
  it('no token -> 401, and nothing else runs', async () => {
    const { call, calls } = setup();
    const { status } = await read(await call(ok, { token: null }));
    assert.equal(status, 401);
    assert.equal(calls.slots, 0);
    assert.equal(calls.supplier.length, 0);
  });
  it('a bad token -> 401', async () => {
    const { call, calls } = setup();
    assert.equal((await read(await call(ok, { token: 'nope' }))).status, 401);
    assert.equal(calls.supplier.length, 0);
  });
  it('a token check that throws is a 401, not a crash', async () => {
    const { call } = setup({ getUserId: async () => { throw new Error('auth down'); } });
    assert.equal((await read(await call(ok))).status, 401);
  });
  it('the user comes from the token, never from the body', async () => {
    const { call, calls } = setup();
    await call({ ...ok, user_id: 'someone-else', userId: 'someone-else' });
    assert.equal(calls.record[0].user, 'user-1');
  });
  it('OPTIONS is answered for browsers, with no auth', async () => {
    const { call } = setup();
    const res = await call(null, { method: 'OPTIONS', token: null });
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
  });
  it('GET is refused', async () => {
    const { call } = setup();
    assert.equal((await call(null, { method: 'GET' })).status, 405);
  });
});

describe('bad requests', () => {
  it('unparseable JSON -> 400', async () => {
    const { call } = setup();
    assert.equal((await read(await call(null, { raw: '{nope' }))).status, 400);
  });
  for (const region_id of [undefined, null, 5, '', 'not-a-uuid', '../../etc']) {
    it(`region_id ${JSON.stringify(region_id)} -> 400`, async () => {
      const { call, calls } = setup();
      assert.equal((await read(await call({ region_id, fields: { player_id: '1' } }))).status, 400);
      assert.equal(calls.slots, 0);
    });
  }
  it('an unknown field is refused before the supplier is called', async () => {
    const { call, calls } = setup();
    const { status, body } = await read(await call({ region_id: REGION, fields: { player_id: '1', evil: 'x' } }));
    assert.equal(status, 400);
    assert.equal(body.reason, 'unknown');
    assert.equal(calls.supplier.length, 0);
  });
  for (const fields of [undefined, null, [], 'x', {}, { player_id: '' }, { player_id: '   ' }, { player_id: null }, { player_id: {} }, { player_id: 'x'.repeat(129) }]) {
    it(`fields ${JSON.stringify(fields)} is refused before the supplier`, async () => {
      const { call, calls } = setup();
      assert.equal((await read(await call({ region_id: REGION, fields }))).status, 400);
      assert.equal(calls.supplier.length, 0);
    });
  }
  it('a numeric id is accepted and sent as text', async () => {
    const { call, calls } = setup();
    await call({ region_id: REGION, fields: { player_id: 3327205705 } });
    assert.deepEqual(calls.supplier[0].fields, { player_id: '3327205705' });
  });
});

describe('regions that cannot be validated', () => {
  for (const [name, target] of [
    ['does not exist / is off', null],
    ['has no validation (tick region)', { ...FF_TARGET, id_validation: 'none' }],
    ['has no validation category', { ...FF_TARGET, validation_category_id: null }],
  ]) {
    it(`a region that ${name} -> 404 and the supplier is never called`, async () => {
      const { call, calls } = setup({ getTarget: async () => target });
      assert.equal((await read(await call(ok))).status, 404);
      assert.equal(calls.supplier.length, 0);
    });
  }
});

describe('throttling', () => {
  it('a throttled user gets 429 and the supplier is not called', async () => {
    const { call, calls } = setup({ claimSlot: async () => false });
    assert.equal((await read(await call(ok))).status, 429);
    assert.equal(calls.supplier.length, 0);
  });
  it('a bad request does not use up a throttle slot', async () => {
    const { call, calls } = setup();
    await call({ region_id: 'bad' });
    assert.equal(calls.slots, 0);
  });
});

describe('failures on our side', () => {
  it('if the record cannot be saved the customer is NOT told the ID is valid', async () => {
    const { call } = setup({ record: async () => { throw new Error('db down'); } });
    const { status, body } = await read(await call(ok));
    assert.equal(status, 500);
    assert.notEqual(body.status, 'valid');
  });
});

describe('logging', () => {
  it('never logs an ID, a player name, a token, or the supplier body', async () => {
    const { call, calls } = setup();
    await call(ok);
    await call({ region_id: REGION, fields: { player_id: '9999999999' } });
    const text = JSON.stringify(calls.logs);
    assert.doesNotMatch(text, /3327205705|9999999999|good-token|ᴹᴿ|player_id|price/);
    assert.ok(calls.logs.length >= 2);
  });
  it('logs the outcome only', async () => {
    const { call, calls } = setup({ supplierValidate: async () => { throw Object.assign(new Error('Player 3327205705 not found'), { status: 422 }); } });
    await call(ok);
    assert.deepEqual(calls.logs, [{ event: 'validate', outcome: 'invalid', supplier_status: 422 }]);
  });
});
