// Deno-only wiring for the notification outbox (thin: the logic and its tests are in notifyOutbox.ts and telegram.ts).
// Shared by telegram-notify, verify-deposit and wallet-request so all three read the same secrets and talk to the same tables.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { drainOutbox, type OutboxDeps } from './notifyOutbox.ts';
import { readTelegramConfig, sendTelegram } from './telegram.ts';

/** `admin` must be a service-role client (only the service role may claim and mark notifications). */
export function outboxDeps(admin: SupabaseClient): OutboxDeps {
  return {
    config: () => readTelegramConfig(Deno.env.get('TELEGRAM_BOT_TOKEN'), Deno.env.get('TELEGRAM_ADMIN_CHAT_ID')),

    async claim(limit) {
      const { data, error } = await admin.rpc('claim_admin_notifications', { p_limit: limit });
      if (error) throw error;
      return ((data ?? []) as { notification_id: string; body: string }[]).map((r) => ({ id: r.notification_id, body: r.body }));
    },

    async mark(id, ok, errorCategory) {
      const { error } = await admin.rpc('mark_admin_notification', { p_id: id, p_ok: ok, p_error: errorCategory ?? null });
      if (error) throw error;
    },

    send: (config, text) => sendTelegram(fetch, config, text),

    log: (event) => console.log(JSON.stringify(event)),
  };
}

/** Sends whatever is queued. Never throws and never waits more than 6 s: a Telegram problem must not change any answer. */
export async function flushNotifications(admin: SupabaseClient): Promise<void> {
  await Promise.race([drainOutbox(outboxDeps(admin)), new Promise((resolve) => setTimeout(resolve, 6000))]).catch(() => {});
}
