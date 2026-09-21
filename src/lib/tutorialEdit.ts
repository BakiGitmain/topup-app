/**
 * Staging the admin's edits to a payment method's "how to pay" images before they are saved in one go. Pure, no imports.
 * Nothing here talks to the server: the screen holds a list, these functions change a copy of it, and "Save" sends the result.
 */

export const MAX_TUTORIALS = 10;

/** The new list with the item at `from` moved to `to` (both clamped). Never changes the input. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = [...list];
  if (from < 0 || from >= copy.length) return copy;
  const target = Math.max(0, Math.min(copy.length - 1, to));
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item);
  return copy;
}

export function removeItem<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** Room for `adding` more images without going over the limit. */
export const canAddMore = (count: number, adding = 1) => count + adding <= MAX_TUTORIALS;

/** Whether the staged list differs from what is saved: a different set of images or a different order. */
export function isDirty(savedIds: readonly string[], staged: readonly { id: string | null }[]): boolean {
  if (staged.length !== savedIds.length) return true;
  return staged.some((item, i) => item.id !== savedIds[i]);
}

/** What the save function receives: existing images by id (kept, in their new position), new ones by url. */
export type SaveItem = { id: string } | { id: null; image_url: string; storage_path: string | null };

export function toSaveItems(staged: readonly { id: string | null; url: string | null; path: string | null }[]): SaveItem[] {
  return staged.map((item) => {
    if (item.id) return { id: item.id };
    if (!item.url) throw new Error('tutorial_not_uploaded');
    return { id: null, image_url: item.url, storage_path: item.path };
  });
}

/** The saved images of one provider, oldest position first; other providers' images are ignored. */
export function forProvider<T extends { provider: string }>(rows: readonly T[], provider: string): T[] {
  return rows.filter((r) => r.provider === provider);
}
