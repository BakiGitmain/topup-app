import { isProviderId, type ProviderId } from './paymentView';
import { supabase } from './supabase';
import type { SaveItem } from './tutorialEdit';

// "How to pay" images per payment method. Anyone signed in can read them (the pay screen shows them); only admins can change
// them, and only through admin_save_payment_tutorials, which replaces a provider's whole list in one all-or-nothing step.

export type TutorialImage = { id: string; provider: ProviderId; url: string; path: string | null };

type Row = { id: string; provider: string; image_url: string; storage_path: string | null };

/** Every tutorial image, in the order the admin set (per provider). Empty until an admin uploads some. */
export async function fetchTutorials(): Promise<TutorialImage[]> {
  const { data, error } = await supabase
    .from('payment_tutorial_images')
    .select('id, provider, image_url, storage_path')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Row[])
    .filter((r): r is Row & { provider: ProviderId } => isProviderId(r.provider))
    .map((r) => ({ id: r.id, provider: r.provider, url: r.image_url, path: r.storage_path }));
}

/** Saves one provider's list exactly as given. Returns the file paths of images that were removed (delete them from the bucket). */
export async function saveTutorials(provider: ProviderId, items: readonly SaveItem[]): Promise<string[]> {
  const { data, error } = await supabase.rpc('admin_save_payment_tutorials', { p_provider: provider, p_items: items });
  if (error) throw error;
  const removed = (data as { removed_paths?: unknown } | null)?.removed_paths;
  return Array.isArray(removed) ? removed.filter((p): p is string => typeof p === 'string') : [];
}

/** Words for a refusal from the save. */
export function tutorialErrorText(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (message.includes('forbidden')) return 'Only an admin can change these.';
  if (message.includes('image_not_found')) return 'One of the images was changed by someone else. Reload and try again.';
  if (message.includes('invalid_items')) return 'That list is not allowed (at most 10 images per payment method).';
  return "Couldn't save. Check your connection and try again. Nothing was changed.";
}
