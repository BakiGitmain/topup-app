// Run with: npm run test:unit
// Guards the bug where a 14-byte "File not found" was uploaded to the product-art bucket as if it were the image.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { MIN_JPEG_BYTES, base64ToBytes, looksLikeJpeg } from './imageBytes.ts';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
/** Not a picture, but it has a JPEG's start and end markers and a realistic size. */
const fakeJpeg = (n = 5000) => {
  const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], n - 2);
  return bytes;
};

describe('base64ToBytes', () => {
  it('matches Node for every length (all three padding cases), including binary', () => {
    for (let n = 1; n <= 300; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 0xff);
      assert.deepEqual(base64ToBytes(b64(bytes)), bytes, `length ${n}`);
    }
  });
  it('round-trips a photo-sized buffer exactly', () => {
    const bytes = Uint8Array.from({ length: 250_000 }, (_, i) => (i * 131) & 0xff);
    const back = base64ToBytes(b64(bytes));
    assert.equal(back.length, bytes.length);
    assert.ok(Buffer.from(back).equals(Buffer.from(bytes)));
  });
  it('returns an array that is exactly the right length (its buffer is uploaded as-is)', () => {
    const out = base64ToBytes(b64(new Uint8Array(1001)));
    assert.equal(out.byteLength, 1001);
    assert.equal(out.buffer.byteLength, 1001);
    assert.equal(out.byteOffset, 0);
  });
  it('accepts a data-URI prefix, missing padding and line breaks', () => {
    const bytes = fakeJpeg(64);
    const text = b64(bytes);
    assert.deepEqual(base64ToBytes(`data:image/jpeg;base64,${text}`), bytes);
    assert.deepEqual(base64ToBytes(text.replace(/=+$/, '')), bytes);
    assert.deepEqual(base64ToBytes(text.replace(/(.{20})/g, '$1\r\n')), bytes);
  });
  it('refuses anything that is not base64, instead of producing a wrong file', () => {
    for (const bad of ['', '   ', 'A', 'File not found', '@@@@', 'abc$', 'data:image/jpeg;base64,']) {
      assert.throws(() => base64ToBytes(bad), /not_base64/, JSON.stringify(bad));
    }
  });
});

describe('looksLikeJpeg', () => {
  it('accepts a JPEG-shaped file of a sensible size', () => {
    assert.equal(looksLikeJpeg(fakeJpeg()), true);
    assert.equal(looksLikeJpeg(fakeJpeg(MIN_JPEG_BYTES)), true);
  });
  it('rejects the 14-byte "File not found" that was actually uploaded', () => {
    const bytes = new TextEncoder().encode('File not found');
    assert.equal(bytes.length, 14);
    assert.equal(looksLikeJpeg(bytes), false);
  });
  it('rejects other error bodies, empty data and things that are not JPEGs', () => {
    const enc = (t) => new TextEncoder().encode(t);
    for (const bad of [enc('{"error":"Not Found","message":"Object not found","statusCode":"404"}'), enc('<html>404</html>'.repeat(40)), new Uint8Array(0), new Uint8Array(5000), new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(500).fill(1)])]) {
      assert.equal(looksLikeJpeg(bad), false);
    }
  });
  it('rejects a truncated JPEG (no end marker) and one that is too small', () => {
    const truncated = fakeJpeg();
    truncated[truncated.length - 1] = 0;
    assert.equal(looksLikeJpeg(truncated), false);
    assert.equal(looksLikeJpeg(fakeJpeg(MIN_JPEG_BYTES - 1)), false);
  });
});
