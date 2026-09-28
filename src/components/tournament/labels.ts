// How tournaments read on screen, shared by the list card, the detail screen and the host wizard.
import { formatBirr } from '../../lib/catalog';
import type { StringKey } from '../../lib/strings';
import { countdown, phaseOf, type Game, type StreamPlatform, type TournamentStatus } from '../../lib/tournamentRules';

type T = (key: StringKey, vars?: Record<string, string | number>) => string;

export function gameLabel(t: T, game: Game): string {
  return t(`tournament.game.${game}` as StringKey);
}

export function modeLabel(t: T, mode: string): string {
  return t(`tournament.mode.${mode}` as StringKey);
}

export function placeLabel(t: T, place: number): string {
  return place <= 3 ? t(`tournament.place.${place}` as StringKey) : t('tournament.place.n', { n: place });
}

export function platformLabel(t: T, platform: StreamPlatform | null): string {
  return t(`tournament.platform.${platform ?? 'other'}` as StringKey);
}

/** "8 teams of 4" (register) / "Teams of 4" (live), or their solo forms. */
export function formatLine(t: T, teamSize: number, teamCount: number | null): string {
  if (teamCount === null) return teamSize === 1 ? t('tournament.solo') : t('tournament.teamSizeOnly', { size: teamSize });
  return teamSize === 1 ? t('tournament.teamsSolo', { teams: teamCount }) : t('tournament.teams', { teams: teamCount, size: teamSize });
}

export function entryLabel(t: T, fee: number): string {
  return fee > 0 ? t('tournament.feePerTeam', { amount: formatBirr(fee) }) : t('tournament.free');
}

/** "Br 500 + 2 items" / "Br 500" / "1 item". */
export function prizeText(t: T, money: number, products: number): string {
  const parts: string[] = [];
  if (money > 0) parts.push(formatBirr(money));
  if (products > 0) parts.push(products === 1 ? t('tournament.prizeItem') : t('tournament.prizeItems', { n: products }));
  return parts.join(' + ');
}

/** "in 3 d" while upcoming, else Started / Cancelled / Finished. */
export function whenText(t: T, status: TournamentStatus, startsAt: string, now: number): string {
  const phase = phaseOf(status, startsAt, now);
  if (phase !== 'upcoming') return t(`tournament.phase.${phase}` as StringKey);
  const c = countdown(startsAt, now);
  return c ? t(`tournament.in.${c.unit}` as StringKey, { n: c.n }) : t('tournament.phase.started');
}
