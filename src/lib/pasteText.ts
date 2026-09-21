/**
 * The text to paste into a field: exactly what is on the clipboard, or null when there is nothing to paste or the
 * clipboard can't be read (empty, no permission, an unsupported platform). Never throws: a paste that can't happen
 * simply does nothing. No trimming and no checking, on purpose (the ID check does that later). Pure, no imports.
 */
export async function readPaste(read: () => Promise<unknown>): Promise<string | null> {
  try {
    const text = await read();
    return typeof text === 'string' && text !== '' ? text : null;
  } catch {
    return null;
  }
}
