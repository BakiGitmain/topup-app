// Edge Function: attempt automatic delivery for one paid order, right after payment. Runs on Deno; the logic is in
// handler.ts (auth/ownership) and _shared/fulfillment.ts (tested in Node); this file only wires up the real
// database reads/writes and picks the fulfillment adapter (today: always the mock -- see _shared/fulfillment.ts's
// FULFILLMENT_MODE, the one switch to flip when the real supplier adapters are implemented and tested).
import { createClient } from 'npm:@supabase/supabase-js@2';

import { adapterFor } from '../_shared/fulfillment.ts';
import { createOrderLookup, createSuccessRecorder } from '../_shared/fulfillmentDb.ts';
import { createHandler } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SHOP2TOPUP_API_KEY = Deno.env.get('SHOP2TOPUP_API_KEY') ?? '';
const GAMESDROP_API_KEY = Deno.env.get('GAMESDROP_API_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(
  createHandler({
    async getUserId(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },

    async ownsOrder(userId, orderId) {
      const { data, error } = await admin.from('orders').select('user_id').eq('id', orderId).maybeSingle();
      if (error) throw error;
      return data?.user_id === userId;
    },

    getOrder: createOrderLookup(admin),
    recordSuccess: createSuccessRecorder(admin),
    adapterFor: (supplier) => adapterFor(supplier, { shop2topup: SHOP2TOPUP_API_KEY, gamesdrop: GAMESDROP_API_KEY }),

    log: (event) => console.log(JSON.stringify(event)),
  }),
);
