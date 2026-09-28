// Tournaments: reads and writes, all through the database functions (the tables themselves are closed to the app).
import { supabase } from './supabase';
import type { CreatePayload, Game, StreamPlatform, TournamentKind, TournamentStatus } from './tournamentRules';
import { purchasablePackages, safeImageUrl } from './catalogRules';

export type TournamentReward = {
  place: number;
  slot: number;
  kind: 'money' | 'product';
  amount: number | null;
  productName: string | null;
  optionLabel: string | null;
  regionLabel: string | null;
};

export type Tournament = {
  id: string;
  kind: TournamentKind;
  game: Game;
  mode: string;
  name: string;
  teamSize: number;
  teamCount: number | null;
  entryFee: number;
  startsAt: string;
  streamPlatform: StreamPlatform | null;
  streamUrl: string | null;
  status: TournamentStatus;
  isHost: boolean;
  host: { name: string; avatarUrl: string | null };
  firstPlace: { money: number; products: number };
  places: number;
  /** Only on the detail read. */
  rewards: TournamentReward[] | null;
};

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (typeof v === 'string' ? v : null);

export function toTournament(r: Row): Tournament {
  const host = (r.host ?? {}) as Row;
  const first = (r.first_place ?? {}) as Row;
  return {
    id: String(r.id),
    kind: r.kind as TournamentKind,
    game: r.game as Game,
    mode: String(r.mode),
    name: String(r.name),
    teamSize: Number(r.team_size),
    teamCount: num(r.team_count),
    entryFee: Number(r.entry_fee ?? 0),
    startsAt: String(r.starts_at),
    streamPlatform: (str(r.stream_platform) as StreamPlatform | null) ?? null,
    streamUrl: str(r.stream_url),
    status: r.status as TournamentStatus,
    isHost: r.is_host === true,
    host: { name: str(host.name) ?? '', avatarUrl: str(host.avatar_url) },
    firstPlace: { money: Number(first.money ?? 0), products: Number(first.products ?? 0) },
    places: Number(r.places ?? 0),
    rewards: Array.isArray(r.rewards)
      ? (r.rewards as Row[]).map((w) => ({
          place: Number(w.place),
          slot: Number(w.slot),
          kind: w.kind as 'money' | 'product',
          amount: num(w.amount),
          productName: str(w.product_name),
          optionLabel: str(w.option_label),
          regionLabel: str(w.region_label),
        }))
      : null,
  };
}

export type ListScope = 'open' | 'hosting';

export async function fetchTournaments(scope: ListScope, game: Game | null): Promise<Tournament[]> {
  const { data, error } = await supabase.rpc('tournament_list', { p_scope: scope, p_game: game });
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toTournament);
}

/** null = no such tournament. */
export async function fetchTournament(id: string): Promise<Tournament | null> {
  const { data, error } = await supabase.rpc('tournament_detail', { p_id: id });
  if (error) throw error;
  return data ? toTournament(data as Row) : null;
}

/** Publishes it. Returns the new id. Throws the server's refusal (see serverErrorOf). */
export async function createTournament(payload: CreatePayload): Promise<string> {
  const { data, error } = await supabase.rpc('tournament_create', { p: payload });
  if (error) throw error;
  return String(data);
}

export async function updateTournament(
  id: string,
  changes: { name?: string; starts_at?: string; stream_platform?: StreamPlatform | ''; stream_url?: string }
): Promise<void> {
  const { error } = await supabase.rpc('tournament_update', { p_id: id, p: changes });
  if (error) throw error;
}

export async function cancelTournament(id: string): Promise<void> {
  const { error } = await supabase.rpc('tournament_cancel', { p_id: id });
  if (error) throw error;
}

/** A pack a host can give as a reward: on sale right now (the same rule the shop uses). */
export type RewardPack = {
  optionId: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  optionLabel: string;
  regionLabel: string | null;
  price: number;
};

type PackRow = {
  id: string;
  name: string;
  image_url: string | null;
  product_options: { id: string; label: string; price: number | string; is_active: boolean; sort_order: number; region_id: string | null }[] | null;
  product_regions: { id: string; label: string; is_active: boolean }[] | null;
};

export async function fetchRewardPacks(): Promise<RewardPack[]> {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, image_url, sort_order, product_options ( id, label, price, is_active, sort_order, region_id ), product_regions ( id, label, is_active )')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PackRow[]).flatMap((p) => {
    const regions = new Map((p.product_regions ?? []).map((r) => [r.id, r.label]));
    return purchasablePackages(p.product_options, p.product_regions)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((o) => ({
        optionId: o.id,
        productId: p.id,
        productName: p.name,
        imageUrl: safeImageUrl(p.image_url),
        optionLabel: o.label,
        regionLabel: o.region_id ? (regions.get(o.region_id) ?? null) : null,
        price: Number(o.price),
      }));
  });
}
