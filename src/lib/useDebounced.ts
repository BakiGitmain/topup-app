import { useEffect, useState } from 'react';

/**
 * Turns what is typed into the query to actually search with. The query follows the text only after `ms` of no typing, so a
 * search that asks the server is sent once per pause, not once per key.
 *
 *  - clearing the box takes effect at once (nobody waits to see the full list come back),
 *  - `flush()` searches right now (call it when they press Search / Enter),
 *  - `pending` is true while the text has changed but the search has not run yet, for a "searching when you stop typing" hint.
 */
export function useDebouncedSearch(text: string, ms: number) {
  const [settled, setSettled] = useState(text);

  useEffect(() => {
    if (text === settled) return;
    const timer = setTimeout(() => setSettled(text), text === '' ? 0 : ms);
    return () => clearTimeout(timer);
  }, [text, settled, ms]);

  const value = text === '' ? '' : settled;
  return { value, pending: value !== text, flush: () => setSettled(text) };
}
