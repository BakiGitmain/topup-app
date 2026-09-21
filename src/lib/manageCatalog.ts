/**
 * The admin's unsaved on/off switches, and how they are saved: one request, all or nothing. Pure functions with
 * no imports. Tapping a switch only changes local state; nothing is sent until Save.
 */

export type ActiveKind = 'products' | 'regions' | 'options';
export type ActiveState = Record<ActiveKind, Record<string, boolean>>;
export type ActiveChange = { id: string; is_active: boolean };
export type ActiveChanges = Record<ActiveKind, ActiveChange[]>;

export const KINDS: readonly ActiveKind[] = ['products', 'regions', 'options'];

export const emptyState = (): ActiveState => ({ products: {}, regions: {}, options: {} });

/** What is on screen: the local (unsaved) value if there is one, else the saved one. */
export function valueOf(saved: ActiveState, local: ActiveState, kind: ActiveKind, id: string): boolean {
  return local[kind][id] ?? saved[kind][id] ?? false;
}

/** Flip one switch locally. Flipping it back to what is saved removes the pending change, so it can't linger. */
export function setLocal(saved: ActiveState, local: ActiveState, kind: ActiveKind, id: string, next: boolean): ActiveState {
  const map = { ...local[kind] };
  if (saved[kind][id] === next) delete map[id];
  else map[id] = next;
  return { ...local, [kind]: map };
}

/** Only the switches that differ from what is saved (and that still exist). This is the whole request body. */
export function pendingChanges(saved: ActiveState, local: ActiveState): ActiveChanges {
  const out: ActiveChanges = { products: [], regions: [], options: [] };
  for (const kind of KINDS) {
    for (const [id, value] of Object.entries(local[kind])) {
      if (id in saved[kind] && saved[kind][id] !== value) out[kind].push({ id, is_active: value });
    }
    out[kind].sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}

export function countChanges(changes: ActiveChanges): number {
  return KINDS.reduce((n, k) => n + changes[k].length, 0);
}

/** Drops pending entries that now match the saved values (after a save or a reload). */
export function prune(saved: ActiveState, local: ActiveState): ActiveState {
  const out = emptyState();
  for (const kind of KINDS) {
    for (const [id, value] of Object.entries(local[kind])) {
      if (id in saved[kind] && saved[kind][id] !== value) out[kind][id] = value;
    }
  }
  return out;
}

export type BatchFailure = { kind: ActiveKind; id: string; reason: string };

/**
 * The refused items of a failed batch, read from the database error (`active_changes_failed`, with the list in the
 * error's details). Null when the error is not that one.
 */
export function parseBatchFailures(error: unknown): BatchFailure[] | null {
  const e = error as { message?: unknown; details?: unknown } | null;
  if (typeof e?.message !== 'string' || !e.message.includes('active_changes_failed')) return null;
  try {
    const list: unknown = JSON.parse(typeof e.details === 'string' ? e.details : '[]');
    if (!Array.isArray(list)) return [];
    return list.flatMap((f): BatchFailure[] => {
      const item = f as { kind?: unknown; id?: unknown; reason?: unknown };
      return (item.kind === 'products' || item.kind === 'regions' || item.kind === 'options') && typeof item.id === 'string'
        ? [{ kind: item.kind, id: item.id, reason: typeof item.reason === 'string' ? item.reason : '' }]
        : [];
    });
  } catch {
    return [];
  }
}

const KIND_WORD: Record<ActiveKind, string> = { products: 'Product', regions: 'Region', options: 'Pack' };

function reasonText(reason: string): string {
  if (reason.includes('locked_needs_codes_to_be_live')) return "it is region-locked but has no account regions. Add them (for example ME) first.";
  if (reason === 'not_found') return 'it no longer exists. Reload the screen.';
  return 'the database refused it.';
}

/** One line per refused item, naming it: `Pack "110 Diamonds" can't be switched on: ...`. */
export function describeFailures(failures: readonly BatchFailure[], names: Readonly<Record<string, string>>): string[] {
  return failures.map((f) => `${KIND_WORD[f.kind]} "${names[f.id] ?? f.id}" wasn't saved: ${reasonText(f.reason)}`);
}
