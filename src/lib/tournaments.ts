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
  /** Live: what the winner gets, in the host's words. */
  prizeText: string | null;
  /** Register: the host has paid for the rewards (held until the winners are paid). */
  rewardsFunded: boolean;
  teamsRegistered: number;
  /** The signed-in person asked to be reminded. */
  reminded: boolean;
  /** Their own team here, if any. */
  myTeam: { id: string; name: string; status: TeamStatus; isCaptain: boolean } | null;
  /** Only on the detail read. */
  rewards: TournamentReward[] | null;
  /** Only on the detail read: registered teams (game IDs only for the host). */
  teams: Team[] | null;
  /** Only on the detail read: where a player's game ID is checked for this game (null = nowhere right now). */
  idCheck: { regionId: string; fieldKey: string; fieldLabel: string } | null;
};

export type TeamStatus = 'draft' | 'registered' | 'cancelled';

export type TeamMember = {
  slot: number;
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
  gameId: string | null;
  playerName: string | null;
  validationId: string | null;
  verified: boolean;
};

export type Team = {
  id: string;
  name: string;
  status: TeamStatus;
  feePaid: number;
  isCaptain: boolean;
  members: TeamMember[];
};

export function toTeam(r: Row): Team {
  return {
    id: String(r.id),
    name: String(r.name),
    status: r.status as TeamStatus,
    feePaid: Number(r.fee_paid ?? 0),
    isCaptain: r.is_captain === true,
    members: Array.isArray(r.members)
      ? (r.members as Row[]).map((m) => ({
          slot: Number(m.slot),
          userId: str(m.user_id),
          name: str(m.name),
          avatarUrl: str(m.avatar_url),
          gameId: str(m.game_id),
          playerName: str(m.player_name),
          validationId: str(m.validation_id),
          verified: m.verified === true,
        }))
      : [],
  };
}

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
    prizeText: str(r.prize_text),
    rewardsFunded: r.rewards_funded === true,
    teamsRegistered: Number(r.teams_registered ?? 0),
    reminded: r.reminded === true,
    myTeam: r.my_team
      ? (() => {
          const m = r.my_team as Row;
          return { id: String(m.id), name: String(m.name), status: m.status as TeamStatus, isCaptain: m.is_captain === true };
        })()
      : null,
    teams: Array.isArray(r.teams) ? (r.teams as Row[]).map(toTeam) : null,
    idCheck: r.id_check
      ? (() => {
          const c = r.id_check as Row;
          return typeof c.region_id === 'string' && typeof c.field_key === 'string'
            ? { regionId: c.region_id, fieldKey: c.field_key, fieldLabel: str(c.field_label) ?? 'Player ID' }
            : null;
        })()
      : null,
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

export type ListScope = 'open' | 'hosting' | 'mine';

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
  changes: { name?: string; starts_at?: string; stream_platform?: StreamPlatform | ''; stream_url?: string; prize_text?: string }
): Promise<void> {
  const { error } = await supabase.rpc('tournament_update', { p_id: id, p: changes });
  if (error) throw error;
}

export async function setReminder(id: string, on: boolean): Promise<void> {
  const { error } = await supabase.rpc('tournament_set_reminder', { p_id: id, p_on: on });
  if (error) throw error;
}

/** The signed-in person's own team in a tournament (a captain's draft included), or null. */
export async function fetchMyTeam(tournamentId: string): Promise<Team | null> {
  const { data, error } = await supabase.rpc('tournament_my_team', { p_tournament: tournamentId });
  if (error) throw error;
  return data ? toTeam(data as Row) : null;
}

/** Saves the captain's draft (creates it the first time). Returns the team id. */
export async function saveTeam(
  tournamentId: string,
  payload: { name: string; members: { slot: number; user_id: string | null; game_id: string | null; validation_id: string | null }[] }
): Promise<string> {
  const { data, error } = await supabase.rpc('tournament_team_save', { p_tournament: tournamentId, p: payload });
  if (error) throw error;
  return String(data);
}

/** Pays the entry fee (if any) from the wallet and takes a spot. */
export async function registerTeam(teamId: string): Promise<{ balance: number | null }> {
  const { data, error } = await supabase.rpc('tournament_team_register', { p_team: teamId });
  if (error) throw error;
  const d = (data ?? {}) as Row;
  return { balance: d.balance === undefined || d.balance === null ? null : Number(d.balance) };
}

export async function discardTeam(teamId: string): Promise<void> {
  const { error } = await supabase.rpc('tournament_team_discard', { p_team: teamId });
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
