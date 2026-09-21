// Edge Function: verify a customer's Telebirr/CBE payment with ShegerPay and, only if it is exactly right, mark the
// order paid. The ShegerPay key (SHEGER_PAY_KEY) lives only in this function's secrets: the app never sees it and
// never calls ShegerPay. Going from the test key (sk_test_...) to the live one means changing that secret, nothing else.
//
// Runs on Deno. The logic is in _shared/verifyHandler.ts and _shared/shegerpay.ts (tested in Node); this file only wires it up.
import { createClient } from 'npm:@supabase/supabase-js@2';

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
  userAgent: 'topup-verify-payment/1.0',
});

Deno.serve(
  createHandler({
    async getUserId(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },

    async begin(orderId, userId, provider, reference) {
      const { data, error } = await admin.rpc('begin_payment_verification', {
        p_order: orderId,
        p_user: userId,
        p_provider: provider,
        p_reference: reference,
      });
      if (error) throw error;
      return data as BeginResult;
    },

    async finish(orderId, decision) {
      const { data, error } = await admin.rpc('finish_payment_verification', {
        p_order: orderId,
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

    log: (event) => console.log(JSON.stringify(event)),
  }),
);
