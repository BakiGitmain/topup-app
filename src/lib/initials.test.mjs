// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initialsOf } from './initials.ts';

describe('initialsOf', () => {
  it('first and last word', () => {
    assert.equal(initialsOf('Ada Lovelace'), 'AL');
    assert.equal(initialsOf('  ada   byron   lovelace '), 'AL');
  });
  it('one word gives one letter', () => {
    assert.equal(initialsOf('Ada'), 'A');
    assert.equal(initialsOf('ada'), 'A');
  });
  it('falls back to the email when there is no name', () => {
    assert.equal(initialsOf('', 'ada.lovelace@x.com'), 'AL');
    assert.equal(initialsOf(null, 'ada@x.com'), 'A');
    assert.equal(initialsOf('   ', 'ada_l@x.com'), 'AL');
  });
  it('the name wins over the email', () => {
    assert.equal(initialsOf('Bob', 'ada@x.com'), 'B');
  });
  it('works for Amharic', () => {
    assert.equal(initialsOf('ሰላም ገብረ'), 'ሰገ');
  });
  it('never splits an emoji or a styled letter in half', () => {
    assert.equal(initialsOf('🎮 Gamer'), '🎮G');
    assert.equal(initialsOf('𝓐da'), '𝓐');
  });
  it('null when there is nothing to use', () => {
    for (const [n, e] of [[null, null], [undefined, undefined], ['', ''], ['   ', '  '], [5, 5], [{}, []], ['', '@x.com']]) {
      assert.equal(initialsOf(n, e), null, JSON.stringify([n, e]));
    }
  });
  it('never longer than two characters', () => {
    assert.ok(Array.from(initialsOf('a b c d e f')).length <= 2);
  });
});
