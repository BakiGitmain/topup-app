import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { ART_JPEG_QUALITY, ART_MAX_SIDE, artworkPath, fitWithin } from './artworkSize';
import { base64ToBytes, looksLikeJpeg } from './imageBytes';
import { supabase } from './supabase';

const BUCKET = 'product-art';

export type PickedArtwork = { uri: string; width: number; height: number };

/** A finished JPEG, held as bytes in memory so nothing has to be read back from a file. */
export type PreparedArtwork = { bytes: Uint8Array; width: number; height: number };

/**
 * Opens the photo library and lets the admin crop to a square (Android crops and rotates; iOS crops).
 * Returns null when they back out. The system photo picker needs no permission prompt.
 */
export async function pickArtwork(): Promise<PickedArtwork | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const { uri, width, height } = result.assets[0];
  return { uri, width, height };
}

/**
 * Shrinks to at most `maxSide` px (1024 for a banner, 512 for a card image) on the longer side (never enlarges) and encodes JPEG at 0.85. The bytes come straight
 * from the manipulator (base64), never from reading a file back: a fetch() of the saved file's uri returned the
 * text "File not found" on a device, and that text was uploaded as if it were the image. Throws unless the result
 * is a real JPEG.
 */
export async function prepareArtwork(picked: PickedArtwork, maxSide = ART_MAX_SIDE): Promise<PreparedArtwork> {
  const context = ImageManipulator.manipulate(picked.uri);
  const target = fitWithin(picked.width, picked.height, maxSide);
  if (target) context.resize(target);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: ART_JPEG_QUALITY, base64: true });
  if (!saved.base64) throw new Error('artwork_no_data');
  const bytes = base64ToBytes(saved.base64);
  if (!looksLikeJpeg(bytes)) throw new Error('artwork_not_jpeg');
  return { bytes, width: saved.width, height: saved.height };
}

/**
 * Uploads a prepared image to the product-art bucket, then checks the stored file is exactly as big as what was
 * sent. If it isn't, the file is removed and this throws, so a broken upload can never be saved as artwork.
 * Admins only: the storage rules refuse anyone else.
 */
export async function uploadArtwork(art: PreparedArtwork, bucket = BUCKET, folder = 'products'): Promise<{ url: string; path: string }> {
  const path = artworkPath(Date.now(), Math.random(), folder);
  const body = art.bytes.buffer.slice(art.bytes.byteOffset, art.bytes.byteOffset + art.bytes.byteLength) as ArrayBuffer;
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;

  const url = supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  const stored = await storedSize(url);
  if (stored !== art.bytes.byteLength) {
    await removeArtworkPaths([path], bucket);
    throw new Error('artwork_upload_corrupt');
  }
  return { url, path };
}

/**
 * Opens the photo library for a picture that must NOT be cropped (a "how to pay" screenshot keeps its own shape).
 * Returns null when they back out.
 */
export async function pickImageUncropped(): Promise<PickedArtwork | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
  if (result.canceled || !result.assets?.[0]) return null;
  const { uri, width, height } = result.assets[0];
  return { uri, width, height };
}

/** The size the storage server reports for a public file, or null if it can't be read. */
async function storedSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

/** Best effort: used to tidy up when an import fails after the artwork was already uploaded. */
export async function removeArtwork(path: string): Promise<void> {
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch {
    // An orphaned file in a public bucket is harmless.
  }
}

/** Best effort: removes several files (a deleted product's images). A file that can't be removed is only wasted space. */
export async function removeArtworkPaths(paths: readonly string[], bucket = BUCKET): Promise<void> {
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(bucket).remove([...paths]);
  } catch {
    // Harmless: the database rows are already gone.
  }
}
