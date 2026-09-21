// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readPaste } from './pasteText.ts';

describe('readPaste', () => {
  it('returns exactly what is on the clipboard: no trimming, no checking', async () => {
    assert.equal(await readPaste(async () => '3327205705'), '3327205705');
    assert.equal(await readPaste(async () => '  12 34  \n'), '  12 34  \n');
    assert.equal(await readPaste(async () => 'not an id at all!'), 'not an id at all!');
    assert.equal(await readPaste(async () => 'a'.repeat(5000)), 'a'.repeat(5000));
  });
  it('an empty clipboard does nothing (null), so it never wipes the field', async () => {
    assert.equal(await readPaste(async () => ''), null);
  });
  it('an unreadable clipboard (no permission, unsupported) fails silently', async () => {
    assert.equal(await readPaste(async () => { throw new Error('permission denied'); }), null);
    assert.equal(await readPaste(() => { throw new Error('sync failure'); }), null);
    assert.equal(await readPaste(() => Promise.reject(new Error('nope'))), null);
  });
  it('anything that is not text is not pasted', async () => {
    for (const v of [null, undefined, 5, {}, [], true]) assert.equal(await readPaste(async () => v), null);
  });
});
