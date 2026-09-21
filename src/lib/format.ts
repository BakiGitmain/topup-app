import { formatBirr } from './catalog';

export { formatBirr };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 21, 3:45 PM". Deliberately locale-independent so it looks the same everywhere. */
export function formatDateTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

export type Elapsed = { unit: 'now' | 'min' | 'hour' | 'day'; n: number };

/** How long ago `iso` was. The caller turns this into (translated) words. */
export function elapsed(iso: string, now = Date.now()): Elapsed {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return { unit: 'now', n: 0 };
  if (mins < 60) return { unit: 'min', n: mins };
  if (mins < 60 * 24) return { unit: 'hour', n: Math.floor(mins / 60) };
  return { unit: 'day', n: Math.floor(mins / (60 * 24)) };
}

/** English-only shorthand for admin screens: "12m", "3h", "2d". */
export function shortWait(iso: string, now = Date.now()) {
  const { unit, n } = elapsed(iso, now);
  return unit === 'now' ? 'just now' : `${n}${unit === 'min' ? 'm' : unit === 'hour' ? 'h' : 'd'}`;
}

/** Parses a birr amount typed by an admin ("1,250.5"). Null if it isn't a sensible positive price. */
export function parsePrice(text: string): number | null {
  const value = Number(text.replace(/,/g, '').trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}
