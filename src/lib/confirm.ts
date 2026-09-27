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

// Every mounted dialog host, newest last; the newest one asks. The root layout mounts one; a screen presented as a
// native modal (the product page) mounts its own too, because on iOS a dialog opened from the root can't appear over
// a modal sheet that is already showing -- it would silently never open and the question would never be answered.
const hosts: ((request: ConfirmRequest) => void)[] = [];

/** Called by the dialog component while it is mounted. Returns the function that unregisters it. */
export function registerConfirmHost(show: (request: ConfirmRequest) => void): () => void {
  hosts.push(show);
  return () => {
    const i = hosts.lastIndexOf(show);
    if (i >= 0) hosts.splice(i, 1);
  };
}

/**
 * Resolves true only when the person confirms. `tone` "danger" (default) is for things that delete or can't be undone;
 * "primary" is for a plain "are you sure" (sending money, marking something paid).
 * If no dialog is mounted (which should never happen) it resolves false: no confirmation means no action.
 */
export function confirmDestructive(title: string, message: string, confirmLabel: string, tone: ConfirmTone = 'danger'): Promise<boolean> {
  return new Promise((resolve) => {
    const host = hosts[hosts.length - 1];
    if (!host) return resolve(false);
    host({ title, message, confirmLabel, tone, resolve });
  });
}
