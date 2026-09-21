import * as Sharing from 'expo-sharing';
import { Platform, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import type { RefObject } from 'react';

/**
 * Turns the receipt card on screen into a PNG and opens the phone's share sheet (save to photos / files, WhatsApp, Telegram...).
 * The picture is exactly what the customer sees: the card is captured, not re-drawn. Device only: the web build has no file
 * sharing, so it answers "unavailable". Throws if the picture could not be made.
 */
export async function shareReceiptImage(target: RefObject<View | null>, dialogTitle: string): Promise<'shared' | 'unavailable'> {
  if (Platform.OS === 'web') return 'unavailable';
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  const uri = await captureRef(target, { format: 'png', quality: 1, result: 'tmpfile' });
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle, UTI: 'public.png' });
  return 'shared';
}
