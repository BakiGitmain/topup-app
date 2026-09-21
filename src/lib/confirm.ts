// Asking "are you sure?" before something that can't be undone. ONE way to ask, used everywhere: the styled in-app dialog
// (components/ui/ConfirmHost.tsx), never the phone's own popup. This file holds no UI and no imports: the host component
// registers itself here, and any screen just calls confirmDestructive().

export type ConfirmTone = 'danger' | 'primary';

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  tone: ConfirmTone;
  /** Called exactly once: true = the person confirmed, false = they cancelled or dismissed it. */
  resolve: (confirmed: boolean) => void;
};

let host: ((request: ConfirmRequest) => void) | null = null;

/** Called by the dialog component while it is mounted. Returns the function that unregisters it. */
export function registerConfirmHost(show: (request: ConfirmRequest) => void): () => void {
  host = show;
  return () => {
    if (host === show) host = null;
  };
}

/**
 * Resolves true only when the person confirms. `tone` "danger" (default) is for things that delete or can't be undone;
 * "primary" is for a plain "are you sure" (sending money, marking something paid).
 * If no dialog is mounted (which should never happen) it resolves false: no confirmation means no action.
 */
export function confirmDestructive(title: string, message: string, confirmLabel: string, tone: ConfirmTone = 'danger'): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    host({ title, message, confirmLabel, tone, resolve });
  });
}
