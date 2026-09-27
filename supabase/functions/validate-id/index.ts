// Edge Function: validate a player ID with the supplier and, if it is valid, record it.
//
// Each region's ID check is routed to its VALIDATION supplier (id_validation_supplier(), independent of which supplier its
// packs come from -- see product_region_supplier.validation_supplier). Shop2Topup and GamesDrop are the two live suppliers
// (2026-09-22); FazerCards' trial has ended and it is no longer called here, even for a region whose packs still come from
// it (Blood Strike: Shop2Topup packs, GamesDrop check). FAZER_API_KEY is left configured (untouched, unused) in case
// FazerCards is wired back in later; nothing here reads it. Each supplier's key lives only in this function's secrets: the
// app never sees either, never calls a supplier directly, and never learns wholesale prices: it gets back the player's
// name, the account's region, and a record id, nothing else. A game with no check reaches this function only if
// id_validation is wrongly 'supplier'; routeValidation refuses an unknown target supplier rather than guessing, so that
// can never silently validate against the wrong game's IDs.
//
// Runs on Deno. The logic is in handler.ts (tested in Node); this file only wires it up.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { GDError, createGamesDropClient } from '../_shared/gamesdrop.ts';
import { S2Error, categoriesForCheck, createShop2TopupClient, validateWithAnyPack } from '../_shared/shop2topup.ts';
import { createHandler, type Target } from './handler.ts';
import { routeValidation } from './route.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SHOP2TOPUP_API_KEY = Deno.env.get('SHOP2TOPUP_API_KEY') ?? '';
const GAMESDROP_API_KEY = Deno.env.get('GAMESDROP_API_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const shop2topup = createShop2TopupClient({ key: SHOP2TOPUP_API_KEY, timeoutMs: 12_000 });
const gamesdrop = createGamesDropClient({ key: GAMESDROP_API_KEY, timeoutMs: 12_000 });

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

// GamesDrop checks an ID against one fixed OFFER (validation_category_id holds that offerId, as text). Unlike Shop2Topup
// there is no signal that tells "this offer is unavailable" apart from "that ID is wrong" (both answer INVALID), so there
// is no try-another-pack fallback here: this only ever checks the one offerId a region was imported with.
async function validateWithGamesDrop(categoryId: string, fields: Record<string, string>): Promise<unknown> {
  const offerId = Number(categoryId);
  if (!Number.isInteger(offerId) || offerId <= 0) throw new GDError('not a numeric offer id', 503, 'BAD_OFFER_ID');
  const gameUserId = fields.gameUserId;
  if (!gameUserId) throw new GDError('no player id', 503, 'MISSING_REQUIRED_FIELD');
  return await gamesdrop.checkGameData({ offerId, gameUserId, gameServerId: fields.gameServerId });
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
      // Which supplier CHECKS this region's IDs (validation_supplier, or the packs' own supplier when that is unset).
      const which = await admin.rpc('id_validation_supplier', { p_region_id: regionId });
      if (which.error) throw which.error;
      return { ...row, supplier: (which.data as string | null) ?? null };
    },

    // The region's validation supplier decides where the check goes (see route.ts). FazerCards is not in this list any
    // more: a region routed there (none, today) gets "could not check" (503), never a silent fallback.
    supplierValidate: routeValidation({
      shop2topup: validateWithShop2Topup,
      gamesdrop: validateWithGamesDrop,
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
