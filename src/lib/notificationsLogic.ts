/** In-app notification rules. Pure, no runtime imports (Node tests it directly). */

export type AppNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  createdAt: string;
  seen: boolean;
};

/** How long the list must stay open, continuously, before what it shows counts as seen. */
export const SEEN_AFTER_MS = 2000;

/** The bell's badge: nothing at 0, a plain dot for exactly 1, the number above that, "99+" past 99. */
export function badgeLabel(unread: number): null | { kind: 'dot' } | { kind: 'count'; text: string } {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  if (unread === 1) return { kind: 'dot' };
  return { kind: 'count', text: unread > 99 ? '99+' : String(Math.floor(unread)) };
}

export function unreadCount(items: readonly AppNotification[]): number {
  return items.reduce((n, item) => (item.seen ? n : n + 1), 0);
}

/** The ids to mark seen when the 2-second timer fires: whatever is loaded and not seen yet, nothing else. */
export function idsToMarkSeen(items: readonly AppNotification[]): string[] {
  return items.filter((item) => !item.seen).map((item) => item.id);
}

export function markSeenLocally(items: readonly AppNotification[], ids: readonly string[]): AppNotification[] {
  const set = new Set(ids);
  return items.map((item) => (set.has(item.id) ? { ...item, seen: true } : item));
}

/** "now", "5m", "3h", "2d": the unit and number, for the caller to put into the customer's language. */
export function relativeAge(createdAt: string, now: number): { unit: 'now' | 'm' | 'h' | 'd'; n: number } {
  const seconds = Math.max(0, (now - new Date(createdAt).getTime()) / 1000);
  if (seconds < 60) return { unit: 'now', n: 0 };
  if (seconds < 3600) return { unit: 'm', n: Math.floor(seconds / 60) };
  if (seconds < 86400) return { unit: 'h', n: Math.floor(seconds / 3600) };
  return { unit: 'd', n: Math.floor(seconds / 86400) };
}

/** Every key notificationText may ask for; strings.ts has each in English and Amharic. */
export type NotifTextKey =
  | 'notif.discount.title'
  | 'notif.discount.body'
  | 'notif.deposit.title'
  | 'notif.deposit.body'
  | 'notif.refund.title'
  | 'notif.refund.body'
  | 'notif.commission.title'
  | 'notif.commission.body'
  | 'notif.commissionNoCode.body'
  | 'notif.withdrawal.title'
  | 'notif.withdrawal.body'
  | 'notif.giftReceived.title'
  | 'notif.giftReceived.body'
  | 'notif.giftClaimed.title'
  | 'notif.giftClaimed.body'
  | 'notif.codeRedeemed.title'
  | 'notif.codeRedeemed.body'
  | 'notif.giftDelivered.title'
  | 'notif.giftDelivered.body'
  | 'notif.tournamentTeam.title'
  | 'notif.tournamentTeam.body'
  | 'notif.tournamentJoined.title'
  | 'notif.tournamentJoined.body'
  | 'notif.tournamentStarting.title'
  | 'notif.tournamentStarting.body'
  | 'notif.tournamentCancelled.title'
  | 'notif.tournamentCancelled.body'
  | 'notif.tournamentRefunded.title'
  | 'notif.tournamentRefunded.body'
  | 'notif.tournamentRoom.title'
  | 'notif.tournamentRoomUpdated.title'
  | 'notif.tournamentRoom.body'
  | 'notif.tournamentWon.title'
  | 'notif.tournamentWon.body'
  | 'notif.tournamentFinished.title'
  | 'notif.tournamentFinished.body'
  | 'tournament.place.1'
  | 'tournament.place.2'
  | 'tournament.place.3'
  | 'tournament.place.n';

/** "Br 1,250" for a whole amount, "Br 30.50" otherwise. Local copy of the birr style so this file stays import-free. */
export function notifBirr(value: unknown): string | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const whole = Number.isInteger(amount);
  return `Br ${amount.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/**
 * The text to show. A type the app knows is rendered from its `data` in the customer's language; anything else
 * (or a known type whose data is incomplete) falls back to the stored plain-text title/body, so a notification
 * type added server-side later still shows up sensibly in an app that hasn't been updated for it.
 */
export function notificationText(
  n: Pick<AppNotification, 'type' | 'title' | 'body' | 'data'>,
  t: (key: NotifTextKey, vars?: Record<string, string>) => string
): { title: string; body: string } {
  const d = n.data ?? {};
  const amount = notifBirr(d.amount);
  switch (n.type) {
    case 'product_discount': {
      const product = str(d.product_name);
      const pack = str(d.pack_label);
      const percent = typeof d.discount_percent === 'number' ? d.discount_percent : null;
      if (product && pack && percent != null) {
        return { title: t('notif.discount.title'), body: t('notif.discount.body', { product, pack, percent: String(percent) }) };
      }
      break;
    }
    case 'deposit_approved':
      if (amount) return { title: t('notif.deposit.title'), body: t('notif.deposit.body', { amount }) };
      break;
    case 'refund_credited':
      if (amount) return { title: t('notif.refund.title'), body: t('notif.refund.body', { amount }) };
      break;
    case 'commission_credited': {
      const code = str(d.discount_code);
      if (amount) {
        return {
          title: t('notif.commission.title'),
          body: code ? t('notif.commission.body', { amount, code }) : t('notif.commissionNoCode.body', { amount }),
        };
      }
      break;
    }
    case 'withdrawal_sent':
      if (amount) return { title: t('notif.withdrawal.title'), body: t('notif.withdrawal.body', { amount }) };
      break;
    // Gifts (20261021090000). A code's redeemer is never named: code_redeemed carries no person at all.
    case 'gift_received': {
      const product = str(d.product_name);
      const pack = str(d.pack_label);
      if (product && pack) return { title: t('notif.giftReceived.title'), body: t('notif.giftReceived.body', { name: str(d.sender_name) ?? '…', product, pack }) };
      break;
    }
    case 'gift_claimed': {
      const product = str(d.product_name);
      const pack = str(d.pack_label);
      if (product && pack) return { title: t('notif.giftClaimed.title'), body: t('notif.giftClaimed.body', { name: str(d.recipient_name) ?? '…', product, pack }) };
      break;
    }
    case 'code_redeemed': {
      const product = str(d.product_name);
      const pack = str(d.pack_label);
      if (product && pack) return { title: t('notif.codeRedeemed.title'), body: t('notif.codeRedeemed.body', { product, pack }) };
      break;
    }
    case 'gift_delivered': {
      const product = str(d.product_name);
      const pack = str(d.pack_label);
      if (product && pack) return { title: t('notif.giftDelivered.title'), body: t('notif.giftDelivered.body', { product, pack }) };
      break;
    }
    case 'tournament_team_registered': {
      const tournament = str(d.tournament_name);
      const team = str(d.team_name);
      if (tournament && team) {
        return { title: t('notif.tournamentTeam.title'), body: t('notif.tournamentTeam.body', { team, tournament, n: String(d.teams ?? '?'), total: String(d.team_count ?? '?') }) };
      }
      break;
    }
    case 'tournament_joined': {
      const tournament = str(d.tournament_name);
      const team = str(d.team_name);
      if (tournament && team) return { title: t('notif.tournamentJoined.title'), body: t('notif.tournamentJoined.body', { name: str(d.captain_name) ?? '…', team, tournament }) };
      break;
    }
    case 'tournament_starting': {
      const tournament = str(d.tournament_name);
      if (tournament) return { title: t('notif.tournamentStarting.title'), body: t('notif.tournamentStarting.body', { tournament }) };
      break;
    }
    case 'tournament_cancelled': {
      const tournament = str(d.tournament_name);
      if (tournament) return { title: t('notif.tournamentCancelled.title'), body: t('notif.tournamentCancelled.body', { tournament }) };
      break;
    }
    case 'tournament_entry_refunded': {
      const tournament = str(d.tournament_name);
      if (tournament) return { title: t('notif.tournamentRefunded.title'), body: t('notif.tournamentRefunded.body', { tournament }) };
      break;
    }
    case 'tournament_room_posted': {
      const tournament = str(d.tournament_name);
      if (tournament) {
        return { title: t(d.updated === true ? 'notif.tournamentRoomUpdated.title' : 'notif.tournamentRoom.title'), body: t('notif.tournamentRoom.body', { tournament }) };
      }
      break;
    }
    case 'tournament_won': {
      const tournament = str(d.tournament_name);
      const team = str(d.team_name);
      const place = typeof d.place === 'number' && Number.isInteger(d.place) && d.place >= 1 ? d.place : null;
      if (tournament && team && place) {
        const placeText = place <= 3 ? t(`tournament.place.${place}` as 'tournament.place.1') : t('tournament.place.n', { n: String(place) });
        return { title: t('notif.tournamentWon.title'), body: t('notif.tournamentWon.body', { team, place: placeText, tournament }) };
      }
      break;
    }
    case 'tournament_finished': {
      const tournament = str(d.tournament_name);
      if (tournament) return { title: t('notif.tournamentFinished.title'), body: t('notif.tournamentFinished.body', { tournament }) };
      break;
    }
  }
  return { title: n.title, body: n.body };
}

// ------------------------------------------------------------------ where tapping a notification goes

/** What a tapped notification points at: a pack on its product page, or a row in the Transactions list. */
export type NotificationTarget =
  | { kind: 'pack'; productId: string; optionId: string }
  | { kind: 'transaction'; transactionId: string }
  /** The Vault on one of its filters (a gift received; a delivered gift's code). */
  | { kind: 'vault'; filter: 'gifts' | 'cards' }
  /** The buyer's own order: their receipt for the gift / redeem code. */
  | { kind: 'order'; orderId: string }
  /** A tournament's page. */
  | { kind: 'tournament'; tournamentId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);

const MONEY_TYPES = new Set(['deposit_approved', 'refund_credited', 'commission_credited', 'withdrawal_sent']);
const TOURNAMENT_TYPES = new Set(['tournament_team_registered', 'tournament_joined', 'tournament_starting', 'tournament_cancelled', 'tournament_entry_refunded',
  'tournament_room_posted', 'tournament_won', 'tournament_finished']);

/**
 * The target of a tap, or null when the notification has nothing usable to open (an old-format row, a type this
 * app doesn't know, or data missing an id): the panel then just closes. A target that turns out to be gone is the
 * destination screen's business -- it still opens, only without the highlight.
 */
export function notificationTarget(n: Pick<AppNotification, 'type' | 'data'>): NotificationTarget | null {
  const d = n.data ?? {};
  if (n.type === 'product_discount') {
    const productId = uuidOf(d.product_id);
    const optionId = uuidOf(d.option_id);
    return productId && optionId ? { kind: 'pack', productId, optionId } : null;
  }
  if (MONEY_TYPES.has(n.type)) {
    const transactionId = uuidOf(d.transaction_id);
    return transactionId ? { kind: 'transaction', transactionId } : null;
  }
  // The recipient's side goes to the Vault (never to a receipt: the receipt is the buyer's).
  if (n.type === 'gift_received') return { kind: 'vault', filter: 'gifts' };
  if (n.type === 'gift_delivered') return { kind: 'vault', filter: d.fulfillment === 'code' ? 'cards' : 'gifts' };
  // The buyer's side goes to their order: the receipt.
  if (n.type === 'gift_claimed' || n.type === 'code_redeemed') {
    const orderId = uuidOf(d.order_id);
    return orderId ? { kind: 'order', orderId } : null;
  }
  if (TOURNAMENT_TYPES.has(n.type)) {
    const tournamentId = uuidOf(d.tournament_id);
    return tournamentId ? { kind: 'tournament', tournamentId } : null;
  }
  return null;
}

// ------------------------------------------------------------------ whether a row looks (and reads) tappable

/**
 * What the app has found out about a target: `live` = the customer can still open it (a pack they can see, a
 * transaction of theirs); `onSale` only for packs. A target not checked yet is absent from the map.
 */
export type TargetStatus = { live: false } | { live: true; onSale?: boolean };
export type TargetAvailability = ReadonlyMap<string, TargetStatus>;

export type NotifOpensKey =
  | 'notif.opens.discountPack'
  | 'notif.opens.product'
  | 'notif.opens.deposit'
  | 'notif.opens.refund'
  | 'notif.opens.commission'
  | 'notif.opens.withdrawal'
  | 'notif.opens.vault'
  | 'notif.opens.receipt'
  | 'notif.opens.tournament';

export type NotificationAction = { target: NotificationTarget; opens: NotifOpensKey; vars: Record<string, string> };

const OPENS_BY_TYPE: Record<string, NotifOpensKey> = {
  deposit_approved: 'notif.opens.deposit',
  refund_credited: 'notif.opens.refund',
  commission_credited: 'notif.opens.commission',
  withdrawal_sent: 'notif.opens.withdrawal',
};

/** The id a target is checked by: the pack, or the transaction. Vault and order targets are never checked (always live). */
export const targetKey = (target: NotificationTarget) =>
  target.kind === 'pack'
    ? target.optionId
    : target.kind === 'transaction'
      ? target.transactionId
      : target.kind === 'order'
        ? target.orderId
        : target.kind === 'tournament'
          ? `tournament:${target.tournamentId}`
          : `vault:${target.filter}`;

/**
 * THE decision for how a row looks: a row with somewhere real to go gets the chevron, the pressed tint and a label
 * saying where it goes; null = inert (no usable id -- an old-format or pre-transaction_id row -- or a target that is
 * known to be gone). A target not checked yet counts as live, so a working row never loses its chevron to a slow
 * check. A pack that still exists but is no longer on sale is still a destination: its product page opens.
 */
export function notificationAction(
  n: Pick<AppNotification, 'type' | 'data'>,
  availability: TargetAvailability
): NotificationAction | null {
  const target = notificationTarget(n);
  if (!target) return null;
  const status = availability.get(targetKey(target));
  if (status && !status.live) return null;
  if (target.kind === 'pack') {
    const product = str((n.data ?? {}).product_name) ?? '';
    const onSale = !(status?.live && status.onSale === false);
    return { target, opens: onSale ? 'notif.opens.discountPack' : 'notif.opens.product', vars: { product } };
  }
  if (target.kind === 'vault') return { target, opens: 'notif.opens.vault', vars: {} };
  if (target.kind === 'order') return { target, opens: 'notif.opens.receipt', vars: {} };
  if (target.kind === 'tournament') return { target, opens: 'notif.opens.tournament', vars: {} };
  return { target, opens: OPENS_BY_TYPE[n.type], vars: {} };
}

/** The targets a list points at, split by kind, for the one availability check. */
export function targetIdsOf(items: readonly Pick<AppNotification, 'type' | 'data'>[]): { optionIds: string[]; transactionIds: string[] } {
  const optionIds = new Set<string>();
  const transactionIds = new Set<string>();
  for (const item of items) {
    const target = notificationTarget(item);
    if (target?.kind === 'pack') optionIds.add(target.optionId);
    else if (target?.kind === 'transaction') transactionIds.add(target.transactionId);
  }
  return { optionIds: [...optionIds], transactionIds: [...transactionIds] };
}

// ------------------------------------------------------------------ each type's icon

/**
 * One glyph per type (Feather names, see components/art/FeatherIcon). The money types use the SAME glyph as their
 * row in the Transactions list, so a notification and the row it opens look alike. Anything else: the legacy
 * promo-code broadcast gets a gift, an unknown type a plain bell.
 */
export type NotifIcon = 'percent' | 'arrow-down-left' | 'rotate-ccw' | 'tag' | 'arrow-up-right' | 'gift' | 'key' | 'check-circle' | 'bell' | 'award' | 'users' | 'clock' | 'x';

const ICON_BY_TYPE: Record<string, NotifIcon> = {
  product_discount: 'percent',
  deposit_approved: 'arrow-down-left',
  refund_credited: 'rotate-ccw',
  commission_credited: 'tag',
  withdrawal_sent: 'arrow-up-right',
  discount: 'gift',
  gift_received: 'gift',
  gift_claimed: 'gift',
  code_redeemed: 'key',
  gift_delivered: 'check-circle',
  tournament_team_registered: 'users',
  tournament_joined: 'award',
  tournament_starting: 'clock',
  tournament_cancelled: 'x',
  tournament_entry_refunded: 'rotate-ccw',
  tournament_room_posted: 'key',
  tournament_won: 'award',
  tournament_finished: 'check-circle',
};

export const notificationIcon = (type: string): NotifIcon => ICON_BY_TYPE[type] ?? 'bell';
