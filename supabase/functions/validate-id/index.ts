// Edge Function: validate a player ID with the supplier and, if it is valid, record it.
//
// Each region's ID check is routed to the supplier its pack data belongs to (product_region_supplier.supplier):
// FazerCards, or Shop2Topup. The supplier keys (FAZER_API_KEY, SHOP2TOPUP_API_KEY) live only in this function's secrets.
// The app never sees them, never calls a supplier, and never learns wholesale prices: it gets back the player's
// name, the account's region, and a record id, nothing else. A game a supplier can't check is imported as "the customer
// ticks" and never reaches this function.
//
// Runs on Deno. The logic is in handler.ts (tested in Node); this file only wires it up.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { FazerCardsClient } from 'npm:fazercards@0.2.0';

import { S2Error, categoriesForCheck, createShop2TopupClient, validateWithAnyPack } from '../_shared/shop2topup.ts';
import { createHandler, type Target } from './handler.ts';
import { routeValidation } from './route.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FAZER_API_KEY = Deno.env.get('FAZER_API_KEY') ?? '';
const SHOP2TOPUP_API_KEY = Deno.env.get('SHOP2TOPUP_API_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// One quick try: the customer has a Retry button, and a long wait is worse than a fast "couldn't check".
const supplier = FAZER_API_KEY
  ? new FazerCardsClient({ apiKey: FAZER_API_KEY, appName: 'topup-validate/1.0', timeoutMs: 12_000, retries: 0 })
  : null;

const shop2topup = createShop2TopupClient({ key: SHOP2TOPUP_API_KEY, timeoutMs: 12_000 });

// Shop2Topup checks an ID against a PACK, not a category. The packs to try come from the saved catalog (or, if that category
// was never opened, from the supplier), and are remembered for ten minutes so one check costs one request.
const packMemo = new Map<string, { at: number; ids: number[] }>();
async function packsOfCategory(categoryId: string, saved: { ref?: string }[] | null): Promise<number[]> {
  const hit = packMemo.get(categoryId);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  let ids = (saved ?? []).map((o) => Number(o.ref)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) ids = (await shop2topup.subcategories(categoryId)).map((s) => s.id);
  packMemo.set(categoryId, { at: Date.now(), ids });
  return ids;
}

// The packs to try, in order: the category's own, then (only for games whose check does not depend on the region) its sibling
// categories', two from each, so a category that is entirely out of stock does not make the whole game "unavailable".
async function packsOf(categoryId: string): Promise<number[]> {
  const { data: own } = await admin
    .from('supplier_catalog')
    .select('game_name')
    .eq('supplier', 'shop2topup')
    .eq('family', 'topups')
    .eq('category_id', categoryId)
    .maybeSingle();
  const { data: rows } = own?.game_name
    ? await admin.from('supplier_catalog').select('category_id, game_name, offers').eq('supplier', 'shop2topup').eq('family', 'topups').eq('game_name', own.game_name)
    : { data: [] };
  const order = categoriesForCheck((rows ?? []) as { category_id: string; game_name: string }[], categoryId);
  const out: number[] = [];
  for (const id of order) {
    const saved = ((rows ?? []) as { category_id: string; offers: { ref?: string }[] | null }[]).find((r) => r.category_id === id)?.offers ?? null;
    out.push(...(await packsOfCategory(id, saved)).slice(0, order.length === 1 ? 3 : 2));
  }
  return out;
}

async function validateWithShop2Topup(categoryId: string, fields: Record<string, string>): Promise<unknown> {
  const playerId = fields.player_id;
  if (!playerId) throw new S2Error('no player id', 503, 'MISSING_REQUIRED_FIELD');
  return await validateWithAnyPack(shop2topup, await packsOf(categoryId), { playerId, zoneId: fields.zone_id }, 4);
}

Deno.serve(
  createHandler({
    timeoutMs: 13_000,

    async getUserId(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },

    async claimSlot(userId) {
      const { data, error } = await admin.rpc('claim_id_validation_slot', { p_user: userId });
      if (error) throw error;
      return data === true;
    },

    async getTarget(regionId) {
      const { data, error } = await admin.rpc('id_validation_target', { p_region_id: regionId });
      if (error) throw error;
      const row = ((data as Target[] | null) ?? [])[0] ?? null;
      if (!row) return null;
      // Which supplier the region's pack data belongs to. No tag (null) means FazerCards, as before suppliers were named.
      const which = await admin.rpc('id_validation_supplier', { p_region_id: regionId });
      if (which.error) throw which.error;
      return { ...row, supplier: (which.data as string | null) ?? null };
    },

    // The region's own supplier decides where the check goes (see route.ts).
    supplierValidate: routeValidation({
      fazercards: async (categoryId, fields) => {
        if (!supplier) throw Object.assign(new Error('supplier key is not configured'), { status: 503 });
        return await supplier.topups.validateId({ categoryId, fields });
      },
      shop2topup: validateWithShop2Topup,
    }),

    async record(userId, regionId, fields, accountRegion, playerName) {
      const { data, error } = await admin.rpc('record_id_validation', {
        p_user: userId,
        p_region_id: regionId,
        p_fields: fields,
        p_account_region: accountRegion,
        p_player_name: playerName,
      });
      if (error) throw error;
      const row = (data as { validation_id: string; valid_until: string }[])[0];
      if (!row) throw new Error('no record returned');
      return row;
    },

    log: (event) => console.log(JSON.stringify(event)),
  }),
);
