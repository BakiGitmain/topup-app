/** Turning an image's base64 into bytes, and refusing anything that isn't a real JPEG. Pure, no imports. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

/**
 * Decodes base64 (with or without a "data:...;base64," prefix, padding or line breaks) into exact-length bytes.
 * Written out by hand so it does not depend on `atob` being present on every JS engine. Throws on anything
 * that isn't base64, so a bad input can never be turned into a silently wrong file.
 */
export function base64ToBytes(input: string): Uint8Array {
  // Only line breaks are ignored. Spaces never appear in real base64, and dropping them would turn a text
  // such as "File not found" into a valid-looking string that decodes to garbage.
  const text = input.replace(/^data:[^,]*,/, '').replace(/[\r\n]+/g, '').replace(/=+$/, '');
  if (text.length === 0 || text.length % 4 === 1) throw new Error('not_base64');

  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of text) {
    const v = LOOKUP[ch];
    if (v === undefined) throw new Error('not_base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

/** Smallest thing that could be a real photo. The failure this guards against was a 14-byte "File not found". */
export const MIN_JPEG_BYTES = 200;

/** Starts with the JPEG marker (FF D8 FF), ends with its end marker (FF D9), and is big enough to be a picture. */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= MIN_JPEG_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}
