import { useEffect, useRef, useState } from 'react';

import {
  CHECK_TIMEOUT_MS,
  DEBOUNCE_MS,
  EXPIRY_MARGIN_MS,
  currentCheck,
  fieldsKey,
  isFieldsComplete,
  normalizeFields,
  type BuyerField,
  type IdCheck,
} from './idValidation';
import { validateId } from './validateId';

type Input = {
  regionId: string | null;
  buyerFields: readonly BuyerField[];
  values: Record<string, string>;
  /** False for regions the server can't validate (or when the customer hasn't got that far). */
  enabled: boolean;
  /** Called once when a check comes back valid, e.g. to pick the region chip that matches the account. */
  onValid?: (info: { accountRegion: string | null }) => void;
};

/**
 * Checks the player ID with the server once the form is complete and the customer has stopped
 * typing (600ms). Shows "Checking…" for at most 15 seconds, then offers Retry. A result only
 * counts for the exact inputs it was made for, and only until the server's window runs out.
 * A timeout never lets the customer through: the database won't sell without a record.
 */
export function useIdValidation({ regionId, buyerFields, values, enabled, onValid }: Input) {
  const key = fieldsKey(regionId, buyerFields, values);
  const complete = isFieldsComplete(buyerFields, values);
  const canCheck = enabled && regionId !== null && complete;

  const [state, setState] = useState<IdCheck>({ kind: 'idle' });
  const [run, setRun] = useState({ n: 0, immediate: false });
  const [now, setNow] = useState(() => Date.now());
  const onValidRef = useRef(onValid);
  useEffect(() => {
    onValidRef.current = onValid;
  });

  useEffect(() => {
    if (!canCheck || regionId === null) return;
    let live = true;
    const fields = normalizeFields(buyerFields, values);
    let giveUp: ReturnType<typeof setTimeout> | undefined;

    const start = setTimeout(
      async () => {
        setState({ kind: 'checking', key });
        giveUp = setTimeout(() => {
          if (live) setState({ kind: 'unavailable', key, reason: 'timeout' });
        }, CHECK_TIMEOUT_MS);

        const result = await validateId(regionId, fields);
        clearTimeout(giveUp);
        // Ignored if the inputs changed meanwhile. A late answer after the 15s limit still counts.
        if (!live) return;
        setNow(Date.now());
        if (result.status === 'valid') {
          setState({
            kind: 'valid',
            key,
            validationId: result.validationId,
            playerName: result.playerName,
            accountRegion: result.accountRegion,
            expiresAt: result.expiresAt,
          });
          onValidRef.current?.({ accountRegion: result.accountRegion });
        } else if (result.status === 'invalid') {
          setState({ kind: 'invalid', key });
        } else {
          setState({ kind: 'unavailable', key, reason: result.reason });
        }
      },
      run.immediate ? 0 : DEBOUNCE_MS
    );

    return () => {
      live = false;
      clearTimeout(start);
      clearTimeout(giveUp);
    };
    // `values` is read through `key`, which changes whenever the fields do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCheck, regionId, key, run]);

  // Move to "expired" when the server's window is about to close.
  useEffect(() => {
    if (state.kind !== 'valid') return;
    const wait = Math.max(0, state.expiresAt - EXPIRY_MARGIN_MS - Date.now()) + 50;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [state]);

  return {
    key,
    complete,
    check: canCheck ? currentCheck(state, key, now) : ({ kind: 'idle' } as IdCheck),
    /** Check again now, without the typing delay. */
    retry: () => setRun((r) => ({ n: r.n + 1, immediate: true })),
  };
}
