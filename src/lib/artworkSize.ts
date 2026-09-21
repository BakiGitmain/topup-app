/** Artwork sizing rules. Pure functions with no imports, so Node can test them. */

export const ART_MAX_SIDE = 1024;
export const ART_JPEG_QUALITY = 0.85;

/** Card images (the picture on a pack card) are smaller than the product banner. */
export const CARD_IMAGE_MAX_SIDE = 512;

/**
 * The size to shrink an image to so its longer side is at most `max`, keeping its shape. Null when it is
 * already small enough (it is never enlarged) or the size is unusable.
 */
export function fitWithin(width: number, height: number, max = ART_MAX_SIDE): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const longest = Math.max(width, height);
  if (longest <= max) return null;
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A path in the product-art bucket that can't collide and holds nothing but a random name. */
export function artworkPath(now = Date.now(), random = Math.random(), folder = 'products'): string {
  const rand = Math.floor(random * 36 ** 8).toString(36).padStart(8, '0');
  return `${folder}/${now.toString(36)}-${rand}.jpg`;
}

/**
 * The storage path inside the bucket, from the public URL we stored. Null unless it is one of our own files
 * (products/<name>.jpg), so a URL can never point a delete at anything else.
 */
export function pathFromPublicUrl(url: string | null, bucket = 'product-art'): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.slice(at + marker.length).split('?')[0]);
  } catch {
    return null;
  }
  return /^products\/[a-z0-9-]+\.jpg$/.test(path) ? path : null;
}
