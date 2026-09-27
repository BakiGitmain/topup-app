import { pickArtwork, prepareArtwork, removeArtworkPaths, uploadArtwork, type PickedArtwork } from './artwork';
import { AVATAR_BUCKET, AVATAR_MAX_SIDE, staleAvatarPaths } from './avatarPaths';
import { supabase } from './supabase';

/** The system photo picker with a square crop -- the same one the admin artwork upload uses. Null if they back out. */
export const pickAvatar = pickArtwork;

/**
 * Saves a picked photo as the user's profile picture, through the SAME path as product artwork: prepareArtwork
 * (resize + re-encode, bytes taken straight from the manipulator, never read back from a file -- the fix for the
 * "File not found" text uploaded as an image) then uploadArtwork (checks the stored size, deletes a corrupt file).
 * Stored at avatars/<userId>/<name>.jpg; the bucket's policies allow only that folder.
 *
 * Order matters: the new file is uploaded and the profile points at it BEFORE anything old is deleted, so a failure
 * part-way never leaves the profile pointing at a missing picture. Old files are removed last, best effort.
 */
export async function saveAvatar(userId: string, picked: PickedArtwork): Promise<string> {
  const art = await prepareArtwork(picked, AVATAR_MAX_SIDE);
  const { url, path } = await uploadArtwork(art, AVATAR_BUCKET, userId);

  const { error } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', userId);
  if (error) {
    await removeArtworkPaths([path], AVATAR_BUCKET);
    throw error;
  }

  const { data: files } = await supabase.storage.from(AVATAR_BUCKET).list(userId, { limit: 100 });
  await removeArtworkPaths(staleAvatarPaths(userId, (files ?? []).map((f) => f.name), path), AVATAR_BUCKET);
  return url;
}
