import { useCallback, useEffect, useRef, useState } from 'react';

import { copyToClipboard } from './clipboard';

/** How long the "Copied" state shows before reverting. */
export const COPY_REVERT_MS = 1500;

/**
 * One shared way to copy text and show "it worked" -- every copy button in the app should use this instead of
 * rolling its own timeout. `copied` flips true only on a REAL success (never lies about a failed clipboard write,
 * unlike a couple of screens that used to toast "copied" unconditionally) and reverts to false on its own after
 * REVERT_MS. Safe to call again mid-revert (resets the timer) and cleans up on unmount.
 */
export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    if (!ok) return false;
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPY_REVERT_MS);
    return true;
  }, []);

  return { copied, copy };
}
