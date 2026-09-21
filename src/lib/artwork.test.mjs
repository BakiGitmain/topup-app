// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { ART_JPEG_QUALITY, ART_MAX_SIDE, CARD_IMAGE_MAX_SIDE, artworkPath, fitWithin, pathFromPublicUrl } from './artworkSize.ts';

describe('fitWithin', () => {
  it('caps the longer side at 1024 and keeps the shape', () => {
    assert.deepEqual(fitWithin(4000, 3000), { width: 1024, height: 768 });
    assert.deepEqual(fitWithin(3000, 4000), { width: 768, height: 1024 });
    assert.deepEqual(fitWithin(2048, 2048), { width: 1024, height: 1024 });
    assert.deepEqual(fitWithin(1025, 1025), { width: 1024, height: 1024 });
  });
  it('never enlarges, and leaves a small image alone', () => {
    assert.equal(fitWithin(1024, 1024), null);
    assert.equal(fitWithin(800, 600), null);
    assert.equal(fitWithin(1, 1), null);
  });
  it('a very thin image keeps at least one pixel', () => assert.deepEqual(fitWithin(20000, 1), { width: 1024, height: 1 }));
  it('copes with nonsense sizes', () => {
    for (const [w, h] of [[0, 100], [100, 0], [-5, 10], [NaN, 10], [10, Infinity], [undefined, 4]]) assert.equal(fitWithin(w, h), null);
  });
  it('the numbers are the ones asked for', () => {
    assert.equal(ART_MAX_SIDE, 1024);
    assert.equal(ART_JPEG_QUALITY, 0.85);
  });
});

describe('artworkPath', () => {
  it('is a jpg under products/ with only safe characters', () => {
    for (const r of [0, 0.5, 0.999999999]) assert.match(artworkPath(1_700_000_000_000, r), /^products\/[a-z0-9]+-[a-z0-9]{8}\.jpg$/);
  });
  it('differs between calls', () => assert.notEqual(artworkPath(1, 0.1), artworkPath(1, 0.2)));
});

describe('card images are 512px, banners 1024px', () => {
  it('the sizes', () => {
    assert.equal(CARD_IMAGE_MAX_SIDE, 512);
    assert.equal(ART_MAX_SIDE, 1024);
  });
  it('a card image is capped at 512 on its longer side, keeping its shape', () => {
    assert.deepEqual(fitWithin(2000, 1000, CARD_IMAGE_MAX_SIDE), { width: 512, height: 256 });
    assert.deepEqual(fitWithin(1024, 1024, CARD_IMAGE_MAX_SIDE), { width: 512, height: 512 });
    assert.equal(fitWithin(512, 512, CARD_IMAGE_MAX_SIDE), null, 'never enlarged');
  });
});

describe('pathFromPublicUrl', () => {
  it("finds the object path in one of our public URLs", () => {
    assert.equal(pathFromPublicUrl('https://x.supabase.co/storage/v1/object/public/product-art/products/abc-12345678.jpg'), 'products/abc-12345678.jpg');
    assert.equal(pathFromPublicUrl('https://x.supabase.co/storage/v1/object/public/product-art/products/abc-12345678.jpg?t=1'), 'products/abc-12345678.jpg');
  });
  it("refuses anything else, so a bad URL can never point a delete at a stranger's file", () => {
    for (const u of [null, '', 'https://example.com/a.jpg', 'https://x.supabase.co/storage/v1/object/public/other/products/a.jpg', 'https://x.supabase.co/storage/v1/object/public/product-art/../secret.jpg', 'https://x.supabase.co/storage/v1/object/public/product-art/other/a.jpg', 'https://x.supabase.co/storage/v1/object/public/product-art/products/%E0%A4%A.jpg']) {
      assert.equal(pathFromPublicUrl(u), null, String(u));
    }
  });
});

describe('artwork.ts wiring (source checks; the picker itself needs a device)', () => {
  const src = fs.readFileSync(new URL('./artwork.ts', import.meta.url), 'utf8');
  it('uses the SDK 57 manipulator API, JPEG, and the shared quality', () => {
    assert.match(src, /ImageManipulator\.manipulate\(/);
    assert.match(src, /renderAsync\(\)/);
    assert.match(src, /SaveFormat\.JPEG/);
    assert.match(src, /compress: ART_JPEG_QUALITY/);
    assert.doesNotMatch(src, /manipulateAsync/);
  });
  it('asks for a square crop from the photo library, images only', () => {
    assert.match(src, /mediaTypes: \['images'\]/);
    assert.match(src, /allowsEditing: true/);
    assert.match(src, /aspect: \[1, 1\]/);
  });
  it('lets the caller choose the size, defaulting to the banner size', () => {
    assert.match(src, /prepareArtwork\(picked: PickedArtwork, maxSide = ART_MAX_SIDE\)/);
    assert.match(src, /fitWithin\(picked\.width, picked\.height, maxSide\)/);
  });
  it('takes the JPEG bytes straight from the manipulator and never reads a file back with fetch (that returned "File not found")', () => {
    assert.match(src, /base64: true/);
    assert.match(src, /base64ToBytes\(/);
    assert.match(src, /looksLikeJpeg\(bytes\)/);
    assert.doesNotMatch(src, /fetch\(uri\)/);
    assert.doesNotMatch(src, /\.arrayBuffer\(\)/);
  });
  it('checks the stored file is the size that was sent, and removes it if not', () => {
    assert.match(src, /method: 'HEAD'/);
    assert.match(src, /stored !== art.bytes.byteLength/);
    assert.match(src, /artwork_upload_corrupt/);
  });
  it('uploads to the product-art bucket as a JPEG and never overwrites', () => {
    assert.match(src, /const BUCKET = 'product-art'/);
    assert.match(src, /contentType: 'image\/jpeg'/);
    assert.match(src, /upsert: false/);
  });
});
