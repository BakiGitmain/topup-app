// Sends the queued admin notifications (the `admin_notifications` outbox) to Telegram. ONE implementation, used by:
//   * telegram-notify (the service-only endpoint, for retries and manual flushes), and
//   * verify-deposit and wallet-request, IN-PROCESS right after they record something worth telling the admin.
//
// In-process (not an HTTP call from one Edge Function to another) on purpose: a function-to-function call needs the caller's
// key to be accepted by the platform gateway AND to match the receiver's own environment, and that is not something these
// functions can check for themselves. A notification that depends on it can fail silently. Calling this directly cannot.
import type { SendResult, TelegramConfig } from './telegram.ts';

export type OutboxDeps = {
  /** Null when TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID are missing or malformed. */
  config: () => TelegramConfig | null;
  claim: (limit: number) => Promise<{ id: string; body: string }[]>;
  mark: (id: string, ok: boolean, error?: string) => Promise<void>;
  send: (config: TelegramConfig, text: string) => Promise<SendResult>;
  /** Counts and categories only. Never the token, a chat id or a message. */
  log: (event: Record<string, unknown>) => void;
};

export type DrainResult = { ok: true; sent: number; failed: number } | { ok: false; error: 'telegram_not_configured'; queued: number };

/** Errors that mean every message will fail the same way: stop after the first instead of hammering Telegram. */
const BATCH_FATAL = new Set(['http_401', 'http_404', 'http_400']);

export async function drainOutbox(deps: OutboxDeps): Promise<DrainResult> {
  const rows = await deps.claim(10);
  if (rows.length === 0) return { ok: true, sent: 0, failed: 0 };

  const config = deps.config();
  if (!config) {
    // Loud, not silent: the rows stay queued (their last_error says why) and the caller is told.
    for (const row of rows) await deps.mark(row.id, false, 'not_configured');
    deps.log({ event: 'telegram', outcome: 'not_configured', queued: rows.length });
    return { ok: false, error: 'telegram_not_configured', queued: rows.length };
  }

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = await deps.send(config, row.body);
    if (result.ok) {
      sent++;
      await deps.mark(row.id, true);
      continue;
    }
    failed++;
    await deps.mark(row.id, false, result.error);
    if (BATCH_FATAL.has(result.error)) {
      for (const rest of rows.slice(i + 1)) await deps.mark(rest.id, false, result.error);
      failed += rows.length - i - 1;
      break;
    }
  }
  deps.log({ event: 'telegram', outcome: failed ? 'partial' : 'sent', sent, failed });
  return { ok: true, sent, failed };
}
