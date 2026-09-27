/** Avatar storage rules. Pure, no imports (Node tests it directly). */

export const AVATAR_BUCKET = 'avatars';
/** Avatars show at most ~64pt (x3 on a dense screen); 512px is plenty and keeps each file small. */
export const AVATAR_MAX_SIDE = 512;

/**
 * Which files in a user's avatar folder to delete once `keepPath` is saved as their picture: every other file in
 * their OWN folder. Clearing the whole folder (not just "the previous file") also sweeps up anything left behind by
 * an earlier upload that failed half way, so the folder can never grow. Names outside `<userId>/` are never
 * returned, even if a listing somehow contained them.
 */
export function staleAvatarPaths(userId: string, folderFileNames: readonly string[], keepPath: string): string[] {
  if (!userId) return [];
  return folderFileNames
    .filter((name) => name && !name.includes('/') && name !== '.emptyFolderPlaceholder')
    .map((name) => `${userId}/${name}`)
    .filter((path) => path !== keepPath);
}
