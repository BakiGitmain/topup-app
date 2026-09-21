// Edge Function: verify a wallet deposit with ShegerPay and, only if the transfer is for EXACTLY the requested amount,
// credit the customer's balance (in one database transaction that also writes the ledger row and queues the Telegram
// message). It shares every line of ShegerPay logic with verify-payment (_shared/verifyHandler.ts, _shared/shegerpay.ts,
// _shared/shegerpayCall.ts); only the two database functions differ. Same secret: SHEGER_PAY_KEY.
//
// After the outcome is recorded it sends whatever is waiting in the notification outbox, IN-PROCESS (_shared/notifyOutbox.ts,
// the same code telegram-notify runs). Best effort: if Telegram fails the notification simply stays queued and goes out on the
// next attempt (a later flush, or a call to telegram-notify).
import { createClient } from 'npm:@supabase/supabase-js@2';

import { flushNotifications } from '../_shared/notifyDeno.ts';
import { createShegerPayCaller } from '../_shared/shegerpayCall.ts';
import type { BeginResult, FinishResult } from '../_shared/verifyHandler.ts';
import { createHandler } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const callShegerPay = createShegerPayCaller({
  key: Deno.env.get('SHEGER_PAY_KEY') ?? '',
  baseUrl: Deno.env.get('SHEGER_PAY_BASE_URL') || undefined,
  userAgent: 'topup-verify-deposit/1.0',
});

Deno.serve(
  createHandler({
    async getUserId(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },

    async begin(depositId, userId, provider, reference) {
      const { data, error } = await admin.rpc('begin_deposit_verification', {
        p_deposit: depositId,
        p_user: userId,
        p_provider: provider,
        p_reference: reference,
      });
      if (error) throw error;
      return data as BeginResult;
    },

    async finish(depositId, decision) {
      const { data, error } = await admin.rpc('finish_deposit_verification', {
        p_deposit: depositId,
        p_outcome: decision.outcome,
        p_amount: decision.amount,
        p_mode: decision.mode,
        p_http: decision.http,
        p_response: decision.raw,
      });
      if (error) throw error;
      return data as FinishResult;
    },

    callShegerPay,

    async afterFinish(outcome) {
      if (outcome === 'paid' || outcome === 'mismatch') await flushNotifications(admin);
    },

    log: (event) => console.log(JSON.stringify(event)),
  }),
);
