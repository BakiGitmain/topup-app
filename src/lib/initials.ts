/** Initials for the default avatar. Pure functions with no imports. */

const firstChar = (word: string) => Array.from(word)[0] ?? '';

/**
 * "Ada Lovelace" -> "AL", "ada" -> "A", "ada.lovelace@x.com" -> "AL".
 * Falls back to the email when there is no name. Characters are whole code points,
 * so an emoji or a styled letter is never cut in half. Null when there is nothing to use.
 */
export function initialsOf(name: unknown, email?: unknown): string | null {
  const fromName = typeof name === 'string' ? name.trim() : '';
  const fromEmail = typeof email === 'string' ? email.split('@')[0].trim() : '';
  const words = (fromName || fromEmail).split(fromName ? /\s+/ : /[._+\-\s]+/).filter(Boolean);
  if (words.length === 0) return null;

  const first = firstChar(words[0]);
  const last = words.length > 1 ? firstChar(words[words.length - 1]) : '';
  return (first + last).toUpperCase() || null;
}
