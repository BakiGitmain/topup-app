// Run with: npm run test:unit. Telegram is faked: nothing here touches the network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanMessage, errorCategory, readTelegramConfig, sendTelegram } from './telegram.ts';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXmLEXAMPLEEXAMPLE1';
const CHAT = '-1001234567890';

describe('readTelegramConfig: a missing or malformed secret is reported, never silently used', () => {
  it('accepts a well-formed token and chat id', () => {
    assert.deepEqual(readTelegramConfig(TOKEN, CHAT), { token: TOKEN, chatId: CHAT });
    assert.deepEqual(readTelegramConfig(` ${TOKEN}\n`, ' 987654321 '), { token: TOKEN, chatId: '987654321' });
  });
  it('anything missing or wrong is null', () => {
    for (const [t, c] of [[undefined, CHAT], [TOKEN, undefined], ['', CHAT], [TOKEN, ''], ['not-a-token', CHAT], [TOKEN, '@channel'], [TOKEN, 'abc'], [TOKEN, '12'], ['YOUR_BOT_TOKEN', 'YOUR_CHAT_ID'], [null, null]]) {
      assert.equal(readTelegramConfig(t, c), null, `${t} / ${c}`);
    }
  });
});

describe('cleanMessage', () => {
  it('keeps newlines, drops other control characters, trims', () => {
    assert.equal(cleanMessage('  a\nb\u0000c\u0007d  '), 'a\nbcd');
  });
  it('caps the length under Telegram\'s limit', () => {
    const out = cleanMessage('x'.repeat(9000));
    assert.ok(out.length <= 4000 && out.endsWith('…'));
  });
  it('is safe on non-strings', () => {
    assert.equal(cleanMessage(null), '');
    assert.equal(cleanMessage(undefined), '');
  });
});

describe('sendTelegram', () => {
  const fetchOk = (calls) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };

  it('posts plain text to the bot API with the chat id, and no parse_mode', async () => {
    const calls = [];
    const r = await sendTelegram(fetchOk(calls), { token: TOKEN, chatId: CHAT }, 'Withdrawal request\nAmount: Br 300');
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.chat_id, CHAT);
    assert.equal(body.text, 'Withdrawal request\nAmount: Br 300');
    assert.equal('parse_mode' in body, false, 'plain text only, so a customer name can never inject formatting or links');
  });
  it('an empty message is not sent', async () => {
    const calls = [];
    assert.deepEqual(await sendTelegram(fetchOk(calls), { token: TOKEN, chatId: CHAT }, '   '), { ok: false, error: 'empty' });
    assert.equal(calls.length, 0);
  });
  it('HTTP failures come back as a short category, never Telegram\'s text', async () => {
    for (const [status, cat] of [[401, 'http_401'], [403, 'http_403'], [400, 'http_400'], [404, 'http_404'], [429, 'http_429'], [502, 'http_5xx']]) {
      const r = await sendTelegram(async () => ({ ok: false, status, text: async () => 'Unauthorized: secret detail' }), { token: TOKEN, chatId: CHAT }, 'hi');
      assert.deepEqual(r, { ok: false, error: cat });
      assert.equal(errorCategory(status), cat);
    }
  });
  it('a network failure never leaks the URL (which contains the token) in its result', async () => {
    const r = await sendTelegram(async () => { throw new Error(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`); }, { token: TOKEN, chatId: CHAT }, 'hi');
    assert.deepEqual(r, { ok: false, error: 'network' });
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });
  it('a hung request is aborted', async () => {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const r = await sendTelegram(hang, { token: TOKEN, chatId: CHAT }, 'hi', 20);
    assert.deepEqual(r, { ok: false, error: 'network' });
  });
});
