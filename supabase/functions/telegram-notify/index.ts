// Edge Function: telegram-notify. Sends queued admin notifications to Telegram. See handler.ts for the rules.
//
// Secrets it needs (set with `npx supabase secrets set NAME=value`; never put them in code or in the app):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID
// Until both are set and well-formed, notifications stay queued and every call answers 503 telegram_not_configured.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { outboxDeps } from '../_shared/notifyDeno.ts';
import { createHandler } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Compares in constant time, so the key can't be guessed from response timing. */
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length || y.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(
  createHandler({
    ...outboxDeps(admin),
    isServiceCaller: (token) => sameSecret(token, SERVICE_KEY),
  }),
);
