// Tournaments: the rules the host form follows, as plain functions (no React, no network) so they are unit-tested.
// The database (tournament_create, 20261024090000_tournaments.sql) enforces every one of them again; these exist so the
// form can never offer a choice the server would refuse.

export type Game = 'free_fire' | 'pubg_mobile';
export type TournamentKind = 'register' | 'live';
export type StreamPlatform = 'tiktok' | 'youtube' | 'twitch' | 'facebook' | 'instagram' | 'kick' | 'other';

export type Mode = { game: Game; id: string; maxTeamSize: number; maxPlayers: number };

export const GAMES: readonly Game[] = ['free_fire', 'pubg_mobile'];

/** Mirrors tournament_modes() in the migration (parity-tested). */
export const MODES: readonly Mode[] = [
  { game: 'free_fire', id: 'battle_royale', maxTeamSize: 4, maxPlayers: 48 },
  { game: 'free_fire', id: 'clash_squad', maxTeamSize: 4, maxPlayers: 64 },
  { game: 'free_fire', id: 'lone_wolf', maxTeamSize: 2, maxPlayers: 32 },
  { game: 'pubg_mobile', id: 'classic', maxTeamSize: 4, maxPlayers: 100 },
  { game: 'pubg_mobile', id: 'tdm', maxTeamSize: 4, maxPlayers: 64 },
];

export const MIN_TEAMS = 2;
export const MAX_PLACES = 10;
export const NAME_MIN = 3;
export const NAME_MAX = 60;
export const MAX_FEE = 100_000;
export const MAX_REWARD = 1_000_000;
/** The platform's share of every entry fee; the host gets the rest when the tournament ends. */
export const PLATFORM_CUT_PERCENT = 15;
/** Mirrors tournament_start_window(). */
export const START_MIN_LEAD_MS = 15 * 60_000;
export const START_MAX_LEAD_MS = 90 * 24 * 3_600_000;

export function modesOf(game: Game): Mode[] {
  return MODES.filter((m) => m.game === game);
}

export function modeOf(game: Game | null, mode: string | null): Mode | null {
  return MODES.find((m) => m.game === game && m.id === mode) ?? null;
}

/** The most teams a mode allows at this team size (every team full: players = size x teams). */
export function maxTeams(mode: Mode, teamSize: number): number {
  return Math.floor(mode.maxPlayers / teamSize);
}

/** Keeps a team count inside what the mode allows at this size. */
export function clampTeamCount(count: number, mode: Mode, teamSize: number): number {
  return Math.min(Math.max(Math.round(count), MIN_TEAMS), maxTeams(mode, teamSize));
}

/** How many places can win something: never more than there are teams, never more than 10. */
export function maxPlaces(kind: TournamentKind, teamCount: number): number {
  return kind === 'live' ? MAX_PLACES : Math.min(MAX_PLACES, teamCount);
}

/** Birr typed by a person: digits with up to 2 decimals. null = not a usable amount. */
export function parseBirr(text: string, { allowZero = false, max = MAX_REWARD } = {}): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (n > max || (!allowZero && n <= 0)) return null;
  return n;
}

/**
 * A stream link as pasted: trimmed, https:// added when the person typed just "tiktok.com/@name", plain http refused
 * (the server takes https only). null = not a link we can use.
 */
export function normalizeStreamUrl(text: string): string | null {
  let t = text.trim();
  if (!t) return null;
  if (/^http:\/\//i.test(t)) return null;
  if (!/^https:\/\//i.test(t)) t = `https://${t}`;
  t = t.replace(/^https:\/\//i, 'https://');
  if (/\s/.test(t) || t.length > 300) return null;
  let host: string;
  try {
    host = new URL(t).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
  return t;
}

/** Which platform a link is on, from its address (the host never has to pick it). */
export function streamPlatformOf(url: string): StreamPlatform {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^(www|m|vm|vt)\./, '');
  } catch {
    return 'other';
  }
  const is = (...domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));
  if (is('tiktok.com')) return 'tiktok';
  if (is('youtube.com', 'youtu.be')) return 'youtube';
  if (is('twitch.tv')) return 'twitch';
  if (is('facebook.com', 'fb.gg', 'fb.watch')) return 'facebook';
  if (is('instagram.com')) return 'instagram';
  if (is('kick.com')) return 'kick';
  return 'other';
}

// ------------------------------------------------------------------------------------------------ rewards

export type ProductReward = {
  kind: 'product';
  optionId: string;
  productName: string;
  optionLabel: string;
  regionLabel: string | null;
  /** Today's shop price, shown to the host so they know what it will cost them. */
  price: number;
};
export type MoneyReward = { kind: 'money'; amount: number };
export type Reward = MoneyReward | ProductReward;
/** rewards[place - 1][slot - 1]; null = not chosen yet. */
export type RewardGrid = (Reward | null)[][];

/** The grid at a new size, keeping every reward already chosen that still fits. */
export function resizeGrid(grid: RewardGrid, places: number, slots: number): RewardGrid {
  return Array.from({ length: places }, (_, p) => Array.from({ length: slots }, (_, s) => grid[p]?.[s] ?? null));
}

export function gridComplete(grid: RewardGrid): boolean {
  return grid.length > 0 && grid.every((row) => row.length > 0 && row.every((r) => r !== null));
}

/** Everything the host will pay when they pick the winners: money summed; products counted and priced at today's price. */
export function rewardTotals(grid: RewardGrid): { money: number; products: number; productsPrice: number } {
  let money = 0;
  let products = 0;
  let productsPrice = 0;
  for (const row of grid) {
    for (const r of row) {
      if (r?.kind === 'money') money += r.amount;
      if (r?.kind === 'product') {
        products += 1;
        productsPrice += r.price;
      }
    }
  }
  return { money: Math.round(money * 100) / 100, products, productsPrice: Math.round(productsPrice * 100) / 100 };
}

/** One place's rewards all set to the same thing (the "same for every player" shortcut). */
export function fillPlace(grid: RewardGrid, place: number, reward: Reward): RewardGrid {
  return grid.map((row, p) => (p === place - 1 ? row.map(() => reward) : row));
}

export function setReward(grid: RewardGrid, place: number, slot: number, reward: Reward | null): RewardGrid {
  return grid.map((row, p) => (p === place - 1 ? row.map((r, s) => (s === slot - 1 ? reward : r)) : row));
}

// ------------------------------------------------------------------------------------------------ the whole form

export type HostForm = {
  game: Game | null;
  kind: TournamentKind | null;
  mode: string | null;
  name: string;
  teamSize: number;
  teamCount: number;
  paid: boolean;
  fee: string;
  startsAt: Date | null;
  streamUrl: string;
  rewards: RewardGrid;
};

export function emptyHostForm(): HostForm {
  return { game: null, kind: null, mode: null, name: '', teamSize: 4, teamCount: 8, paid: false, fee: '', startsAt: null, streamUrl: '', rewards: [[null, null, null, null]] };
}

/** What each problem is called; the screen turns it into a sentence (tournament.err.<key>). */
export type FormProblem =
  | 'game'
  | 'kind'
  | 'mode'
  | 'name'
  | 'teamSize'
  | 'teamCount'
  | 'fee'
  | 'startMissing'
  | 'startTooSoon'
  | 'startTooFar'
  | 'streamRequired'
  | 'streamInvalid'
  | 'rewards';

export type CreatePayload = {
  kind: TournamentKind;
  game: Game;
  mode: string;
  name: string;
  team_size: number;
  team_count: number | null;
  entry_fee: number;
  starts_at: string;
  stream_platform: StreamPlatform | null;
  stream_url: string | null;
  rewards: ({ place: number; slot: number; kind: 'money'; amount: number } | { place: number; slot: number; kind: 'product'; option_id: string })[];
};

/** The details step only (everything but rewards): the first problem, or null. */
export function detailsProblem(form: HostForm, now: number): FormProblem | null {
  if (!form.game) return 'game';
  if (!form.kind) return 'kind';
  const mode = modeOf(form.game, form.mode);
  if (!mode) return 'mode';
  const name = form.name.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return 'name';
  if (!Number.isInteger(form.teamSize) || form.teamSize < 1 || form.teamSize > mode.maxTeamSize) return 'teamSize';
  if (form.kind === 'register') {
    if (!Number.isInteger(form.teamCount) || form.teamCount < MIN_TEAMS || form.teamCount > maxTeams(mode, form.teamSize)) return 'teamCount';
    if (form.paid && parseBirr(form.fee, { max: MAX_FEE }) === null) return 'fee';
  }
  if (!form.startsAt) return 'startMissing';
  const lead = form.startsAt.getTime() - now;
  if (lead < START_MIN_LEAD_MS) return 'startTooSoon';
  if (lead > START_MAX_LEAD_MS) return 'startTooFar';
  if (form.streamUrl.trim()) {
    if (!normalizeStreamUrl(form.streamUrl)) return 'streamInvalid';
  } else if (form.kind === 'live') {
    return 'streamRequired';
  }
  return null;
}

/** The whole form checked; the payload tournament_create takes when it is right. */
export function buildCreatePayload(form: HostForm, now: number): { ok: true; payload: CreatePayload } | { ok: false; problem: FormProblem } {
  const problem = detailsProblem(form, now);
  if (problem) return { ok: false, problem };
  const places = form.rewards.length;
  const expectedMax = maxPlaces(form.kind!, form.teamCount);
  if (!gridComplete(form.rewards) || places > expectedMax || form.rewards.some((row) => row.length !== form.teamSize)) {
    return { ok: false, problem: 'rewards' };
  }
  const url = normalizeStreamUrl(form.streamUrl);
  const rewards: CreatePayload['rewards'] = form.rewards.flatMap((row, p) =>
    row.map((r, s) => {
      const at = { place: p + 1, slot: s + 1 };
      return r!.kind === 'money' ? { ...at, kind: 'money' as const, amount: r!.amount } : { ...at, kind: 'product' as const, option_id: (r as ProductReward).optionId };
    })
  );
  return {
    ok: true,
    payload: {
      kind: form.kind!,
      game: form.game!,
      mode: form.mode!,
      name: form.name.trim(),
      team_size: form.teamSize,
      team_count: form.kind === 'register' ? form.teamCount : null,
      entry_fee: form.kind === 'register' && form.paid ? parseBirr(form.fee, { max: MAX_FEE })! : 0,
      starts_at: form.startsAt!.toISOString(),
      stream_platform: url ? streamPlatformOf(url) : null,
      stream_url: url,
      rewards,
    },
  };
}

/** What the host gets from one team's fee once the tournament ends. */
export function hostShareOfFee(fee: number): number {
  return Math.floor(fee * (100 - PLATFORM_CUT_PERCENT)) / 100;
}

// ------------------------------------------------------------------------------------------------ reading

export type TournamentStatus = 'published' | 'cancelled' | 'finished';
/** What a list row / the detail screen says about where a tournament is. */
export type Phase = 'upcoming' | 'started' | 'cancelled' | 'finished';

export function phaseOf(status: TournamentStatus, startsAt: string, now: number): Phase {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'finished') return 'finished';
  return new Date(startsAt).getTime() > now ? 'upcoming' : 'started';
}

/** "in 3 days" / "in 5 h" / "in 12 min" style countdown parts. null once it has started. */
export function countdown(startsAt: string, now: number): { unit: 'day' | 'hour' | 'min'; n: number } | null {
  const ms = new Date(startsAt).getTime() - now;
  if (!(ms > 0)) return null;
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return { unit: 'min', n: min };
  const hours = Math.floor(min / 60);
  if (hours < 48) return { unit: 'hour', n: hours };
  return { unit: 'day', n: Math.floor(hours / 24) };
}

/** The server's refusal codes the host form knows how to explain; anything else is a generic failure. */
export const SERVER_ERRORS = [
  'not_a_creator',
  'invalid_game_mode',
  'invalid_name',
  'invalid_team_size',
  'invalid_team_count',
  'invalid_entry_fee',
  'invalid_start',
  'invalid_stream',
  'invalid_rewards',
  'reward_pack_unavailable',
  'too_many_tournaments',
  'tournament_closed',
  'tournament_not_found',
] as const;
export type ServerError = (typeof SERVER_ERRORS)[number];

export function serverErrorOf(error: unknown): ServerError | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  return SERVER_ERRORS.find((code) => message.includes(code)) ?? null;
}
