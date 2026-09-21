import * as Clipboard from 'expo-clipboard';

import { readPaste } from './pasteText';

/** What the clipboard holds as text, or null. Never throws. */
export function pasteFromClipboard(): Promise<string | null> {
  return readPaste(() => Clipboard.getStringAsync());
}

/** Puts text on the clipboard (an account number to paste into a banking app). False if it couldn't. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
