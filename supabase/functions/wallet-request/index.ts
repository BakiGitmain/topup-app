// Edge Function: create a deposit or withdrawal request for the signed-in customer, then notify the admin on Telegram.
// See handler.ts. The SQL functions do all the real work and are called with the customer's OWN token.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { flushNotifications } from '../_shared/notifyDeno.ts';
import { createHandler, type RpcResult } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A client that acts as this customer: their token, the public key. Row security and auth.uid() apply as normal. */
const asCustomer = (token: string) =>
  createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

Deno.serve(
  createHandler({
    async getUserId(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },

    async createDeposit(token, amount): Promise<RpcResult> {
      const { data, error } = await asCustomer(token).rpc('create_deposit_request', { p_amount: amount });
      return error ? { error: { message: error.message, details: error.details } } : { data };
    },

    async createWithdrawal(token, { amount, provider, account }): Promise<RpcResult> {
      const { data, error } = await asCustomer(token).rpc('create_withdrawal_request', {
        p_amount: amount,
        p_provider: provider,
        p_account: account,
      });
      return error ? { error: { message: error.message, details: error.details } } : { data };
    },

    // Sends what is waiting in the outbox, in-process (never a call to another function). Best effort.
    notify: () => flushNotifications(admin),

    log: (event) => console.log(JSON.stringify(event)),
  }),
);
