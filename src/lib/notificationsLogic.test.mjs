// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { SEEN_AFTER_MS, badgeLabel, idsToMarkSeen, markSeenLocally, notificationAction, notificationIcon, notificationTarget, notificationText, relativeAge, targetIdsOf, unreadCount } from './notificationsLogic.ts';

const n = (id, seen = false, extra = {}) => ({ id, type: 'discount', title: 'T', body: 'B', data: {}, createdAt: '2026-09-27T10:00:00Z', seen, ...extra });

describe('the bell badge', () => {
  it('nothing, then a dot for one, then the number, capped at 99+', () => {
    assert.equal(badgeLabel(0), null);
    assert.deepEqual(badgeLabel(1), { kind: 'dot' });
    assert.deepEqual(badgeLabel(2), { kind: 'count', text: '2' });
    assert.deepEqual(badgeLabel(99), { kind: 'count', text: '99' });
    assert.deepEqual(badgeLabel(100), { kind: 'count', text: '99+' });
    assert.deepEqual(badgeLabel(150), { kind: 'count', text: '99+' });
    assert.equal(badgeLabel(-3), null);
  });
  it('counts only unseen', () => {
    assert.equal(unreadCount([n('a'), n('b', true), n('c')]), 2);
  });
});

describe('seen', () => {
  it('the timer marks exactly what is loaded and unseen', () => {
    assert.deepEqual(idsToMarkSeen([n('a'), n('b', true), n('c')]), ['a', 'c']);
    assert.equal(unreadCount(markSeenLocally([n('a'), n('b'), n('c')], ['a', 'b'])), 1);
  });
  it('the panel waits the full 2 seconds, and only while it stays open', () => {
    assert.equal(SEEN_AFTER_MS, 2000);
    const panel = fs.readFileSync(new URL('../components/header/NotificationPanel.tsx', import.meta.url), 'utf8');
    assert.match(panel, /setTimeout\([\s\S]*?SEEN_AFTER_MS\)/);
    assert.match(panel, /clearTimeout\(timer\)/, 'closing before 2 s cancels it');
  });
});

describe('text', () => {
  // Renders a key and its vars so the assertions show exactly what was asked for.
  const t = (key, vars) => (vars ? `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}` : key);
  const x = (type, data) => notificationText(n('a', false, { type, title: 'Stored title', body: 'Stored body', data }), t);
  it('a product going on sale names the product, pack and percent', () => {
    assert.deepEqual(x('product_discount', { product_name: 'PUBG Mobile', pack_label: '60 UC', discount_percent: 17 }),
      { title: 'notif.discount.title', body: 'notif.discount.body|product=PUBG Mobile,pack=60 UC,percent=17' });
  });
  it('the four money types show the amount in birr', () => {
    assert.deepEqual(x('deposit_approved', { amount: 500 }), { title: 'notif.deposit.title', body: 'notif.deposit.body|amount=Br 500' });
    assert.deepEqual(x('refund_credited', { amount: 30.5 }), { title: 'notif.refund.title', body: 'notif.refund.body|amount=Br 30.50' });
    assert.deepEqual(x('withdrawal_sent', { amount: 12500 }), { title: 'notif.withdrawal.title', body: 'notif.withdrawal.body|amount=Br 12,500' });
    assert.deepEqual(x('commission_credited', { amount: 25, discount_code: 'EXAMPLE5' }), { title: 'notif.commission.title', body: 'notif.commission.body|amount=Br 25,code=EXAMPLE5' });
    assert.deepEqual(x('commission_credited', { amount: 25, discount_code: null }), { title: 'notif.commission.title', body: 'notif.commissionNoCode.body|amount=Br 25' });
  });
  it('an unknown type, or a known one with incomplete data, falls back to the stored title and body', () => {
    const stored = { title: 'Stored title', body: 'Stored body' };
    assert.deepEqual(x('order_delivered', {}), stored);
    assert.deepEqual(x('discount', { discount_code: 'SAVE15', discount_percent: 15 }), stored, 'the removed code broadcast is no longer special');
    assert.deepEqual(x('product_discount', { product_name: 'PUBG Mobile' }), stored);
    assert.deepEqual(x('deposit_approved', { amount: 0 }), stored);
    assert.deepEqual(x('refund_credited', { amount: 'abc' }), stored);
    assert.deepEqual(x('withdrawal_sent', {}), stored);
  });
  it('every key it can ask for exists in both languages', () => {
    const src = fs.readFileSync(new URL('./strings.ts', import.meta.url), 'utf8');
    const logic = fs.readFileSync(new URL('./notificationsLogic.ts', import.meta.url), 'utf8');
    const keys = [...logic.matchAll(/'(notif\.[a-zA-Z.]+)'/g)].map((m) => m[1]);
    assert.ok(keys.length >= 11);
    for (const key of new Set(keys)) assert.equal(src.split(`'${key}':`).length - 1, 2, key);
  });
  it('relative age', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    assert.deepEqual(relativeAge('2026-09-27T11:59:30Z', now), { unit: 'now', n: 0 });
    assert.deepEqual(relativeAge('2026-09-27T11:55:00Z', now), { unit: 'm', n: 5 });
    assert.deepEqual(relativeAge('2026-09-27T09:00:00Z', now), { unit: 'h', n: 3 });
    assert.deepEqual(relativeAge('2026-09-25T12:00:00Z', now), { unit: 'd', n: 2 });
  });
});

describe('zero balance in the header', () => {
  // format.ts imports a sibling without an extension, which Node's test runner can't resolve, so check the rule itself.
  const src = fs.readFileSync(new URL('./format.ts', import.meta.url), 'utf8');
  it('exactly zero drops the decimals; every other balance keeps two', () => {
    const fn = src.slice(src.indexOf('export function formatBirrExact'));
    assert.ok(fn.indexOf("if (amount === 0) return 'Br 0';") > 0);
    assert.ok(fn.indexOf("if (amount === 0) return 'Br 0';") < fn.indexOf('minimumFractionDigits: 2'), 'the zero case comes before the two-decimal format');
  });
});

describe('where a tap goes', () => {
  const P = '11111111-2222-4333-8444-555555555555';
  const O = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  const T = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  it('a discounted pack opens its product page at that pack', () => {
    assert.deepEqual(notificationTarget({ type: 'product_discount', data: { product_id: P, option_id: O, discount_percent: 20 } }), { kind: 'pack', productId: P, optionId: O });
  });
  it('all four money types open their transaction row', () => {
    for (const type of ['deposit_approved', 'refund_credited', 'commission_credited', 'withdrawal_sent']) {
      assert.deepEqual(notificationTarget({ type, data: { amount: 10, transaction_id: T } }), { kind: 'transaction', transactionId: T }, type);
    }
  });
  it('an old-format row, an unknown type or missing/garbled ids open nothing (the panel just closes)', () => {
    assert.equal(notificationTarget({ type: 'discount', data: { discount_code: 'BAKI', discount_percent: 5 } }), null);
    assert.equal(notificationTarget({ type: 'order_delivered', data: { transaction_id: T } }), null);
    assert.equal(notificationTarget({ type: 'product_discount', data: { product_id: P } }), null);
    assert.equal(notificationTarget({ type: 'product_discount', data: { product_id: P, option_id: 'not-a-uuid' } }), null);
    assert.equal(notificationTarget({ type: 'deposit_approved', data: { amount: 500, deposit_id: T } }), null);
    assert.equal(notificationTarget({ type: 'withdrawal_sent', data: { transaction_id: null } }), null);
    assert.equal(notificationTarget({ type: 'refund_credited', data: null }), null);
  });
});

describe('actionable vs inert rows (chevron shown vs hidden)', () => {
  const P = '11111111-2222-4333-8444-555555555555';
  const O = '66666666-7777-4888-9999-aaaaaaaaaaaa';
  const T = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const sale = { type: 'product_discount', data: { product_id: P, option_id: O, product_name: 'Free Fire', pack_label: 'Booyah Pass', discount_percent: 3 } };
  const deposit = { type: 'deposit_approved', data: { amount: 1000, transaction_id: T } };
  const none = new Map();
  it('a working target: actionable, with a label naming where it goes', () => {
    assert.deepEqual(notificationAction(sale, new Map([[O, { live: true, onSale: true }]])), { target: { kind: 'pack', productId: P, optionId: O }, opens: 'notif.opens.discountPack', vars: { product: 'Free Fire' } });
    assert.equal(notificationAction(deposit, new Map([[T, { live: true }]])).opens, 'notif.opens.deposit');
    for (const [type, key] of [['refund_credited', 'refund'], ['commission_credited', 'commission'], ['withdrawal_sent', 'withdrawal']]) {
      assert.equal(notificationAction({ type, data: { transaction_id: T } }, none).opens, `notif.opens.${key}`, type);
    }
  });
  it('not checked yet counts as working (a live row never loses its chevron to a slow check)', () => {
    assert.ok(notificationAction(sale, none));
    assert.ok(notificationAction(deposit, none));
  });
  it('a pack that still exists but is no longer on sale still opens its product page', () => {
    assert.equal(notificationAction(sale, new Map([[O, { live: true, onSale: false }]])).opens, 'notif.opens.product');
  });
  it('inert: a target known to be gone, an old-format row, a row from before transaction_id', () => {
    assert.equal(notificationAction(sale, new Map([[O, { live: false }]])), null);
    assert.equal(notificationAction(deposit, new Map([[T, { live: false }]])), null);
    assert.equal(notificationAction({ type: 'discount', data: { discount_code: 'BAKI', discount_percent: 5 } }, none), null);
    assert.equal(notificationAction({ type: 'commission_credited', data: { amount: 285, discount_code: 'BAKI', order_id: T } }, none), null);
  });
  it('the check asks only about targets a row points at', () => {
    assert.deepEqual(targetIdsOf([sale, sale, deposit, { type: 'discount', data: {} }]), { optionIds: [O], transactionIds: [T] });
  });
  it('the panel draws the chevron, pressed tint and button role only for an actionable row', () => {
    const panel = fs.readFileSync(new URL('../components/header/NotificationPanel.tsx', import.meta.url), 'utf8');
    assert.match(panel, /const action = notificationAction\(item, availability\)/);
    assert.match(panel, /\{action && \(\s*<View style=\{styles\.chevron\}/);
    assert.match(panel, /action && pressed && styles\.rowPressed/);
    assert.match(panel, /accessibilityRole=\{action \? 'button' : 'text'\}/);
    assert.match(panel, /accessibilityLabel=\{action \? `\$\{summary\}\. \$\{t\(action\.opens, action\.vars\)\}` : summary\}/);
    // navigation itself is untouched: the tap still goes through notificationTarget
    assert.match(panel, /const target = notificationTarget\(item\);/);
  });
});

describe('panel polish: icons, cap, empty state', () => {
  const panel = fs.readFileSync(new URL('../components/header/NotificationPanel.tsx', import.meta.url), 'utf8');
  const feather = fs.readFileSync(new URL('../components/art/FeatherIcon.tsx', import.meta.url), 'utf8');
  it('one icon per type, the money ones matching their Transactions-list glyph; anything else a bell', () => {
    assert.deepEqual(
      ['product_discount', 'deposit_approved', 'refund_credited', 'commission_credited', 'withdrawal_sent', 'discount', 'order_delivered'].map(notificationIcon),
      ['percent', 'arrow-down-left', 'rotate-ccw', 'tag', 'arrow-up-right', 'gift', 'bell']
    );
    const profile = fs.readFileSync(new URL('../app/(customer)/profile.tsx', import.meta.url), 'utf8');
    for (const [kind, glyph] of [['deposit', 'arrow-down-left'], ['refund', 'rotate-ccw'], ['withdrawal', 'arrow-up-right'], ['commission', 'tag']]) {
      assert.match(profile, new RegExp(`  ${kind}: '${glyph}',`), kind);
    }
  });
  it('every icon exists in the one icon set the app uses (Feather)', () => {
    for (const name of ['percent', 'arrow-down-left', 'rotate-ccw', 'tag', 'arrow-up-right', 'gift', 'bell', 'chevron-right']) {
      assert.match(feather, new RegExp(`"${name}":`), name);
    }
  });
  it('the panel is capped (60% of the screen, at most 480) and its list scrolls inside it, with the shared fade', () => {
    assert.match(panel, /MAX_HEIGHT_SHARE = 0\.6;/);
    assert.match(panel, /MAX_HEIGHT = 480;/);
    assert.match(panel, /maxHeight: Math\.min\(Math\.round\(height \* MAX_HEIGHT_SHARE\), MAX_HEIGHT\)/);
    assert.match(panel, /<FadeScrollView indicator=\{false\}>/);
    const fade = fs.readFileSync(new URL('../components/ui/FadeScrollView.tsx', import.meta.url), 'utf8');
    assert.match(fade, /overscrollBehavior: 'contain'/, 'web: the page behind never scrolls along');
    assert.match(fade, /scroll: \{ flexGrow: 0, flexShrink: 1 \}/, 'native: the list shrinks to the cap instead of overflowing it');
  });
  it('inert rows fade their icon; unread is one dot on the icon; the empty state says something', () => {
    assert.match(panel, /<View style=\{\[styles\.badge, !action && styles\.badgeInert\]\}>/);
    assert.match(panel, /\{!item\.seen && <View style=\{styles\.unread\}/);
    assert.doesNotMatch(panel, /styles\.dot/, 'the separate dot column is gone');
    assert.match(panel, /t\('notif\.emptyHint'\)/);
  });
});

describe('gift notifications (20261021090000): recipient -> Vault, buyer -> their receipt', async () => {
  const { giftSideOf } = await import('./orderView.ts');
  const tt = (key, vars = {}) => `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}`;
  const G = '11111111-2222-4333-8444-555555555555';
  const ORDER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const note = (type, data) => ({ type, title: 'T', body: 'B', data });

  it('each type renders in the customer\'s language from its data', () => {
    assert.equal(notificationText(note('gift_received', { product_name: 'Roblox', pack_label: '800 Robux', sender_name: 'Abel' }), tt).body, 'notif.giftReceived.body|name=Abel,product=Roblox,pack=800 Robux');
    assert.equal(notificationText(note('gift_claimed', { product_name: 'Roblox', pack_label: '800 Robux', recipient_name: 'Bruk' }), tt).body, 'notif.giftClaimed.body|name=Bruk,product=Roblox,pack=800 Robux');
    assert.equal(notificationText(note('code_redeemed', { product_name: 'Roblox', pack_label: '800 Robux' }), tt).body, 'notif.codeRedeemed.body|product=Roblox,pack=800 Robux');
    assert.equal(notificationText(note('gift_delivered', { product_name: 'Roblox', pack_label: '800 Robux' }), tt).title, 'notif.giftDelivered.title|');
  });
  it('a redeemed code names nobody, even if the data somehow carried a name', () => {
    const body = notificationText(note('code_redeemed', { product_name: 'Roblox', pack_label: '800 Robux', recipient_name: 'Chala' }), tt).body;
    assert.doesNotMatch(body, /Chala/);
  });
  it('incomplete data falls back to the stored text', () => {
    assert.deepEqual(notificationText(note('gift_received', {}), tt), { title: 'T', body: 'B' });
  });
  it('the recipient\'s side opens the Vault (gifts; a delivered code on the gift cards), never a receipt', () => {
    assert.deepEqual(notificationTarget(note('gift_received', { gift_id: G })), { kind: 'vault', filter: 'gifts' });
    assert.deepEqual(notificationTarget(note('gift_delivered', { order_id: ORDER, fulfillment: 'code' })), { kind: 'vault', filter: 'cards' });
    assert.deepEqual(notificationTarget(note('gift_delivered', { order_id: ORDER, fulfillment: 'topup' })), { kind: 'vault', filter: 'gifts' });
  });
  it('the buyer\'s side opens their order: the receipt', () => {
    assert.deepEqual(notificationTarget(note('gift_claimed', { order_id: ORDER })), { kind: 'order', orderId: ORDER });
    assert.deepEqual(notificationTarget(note('code_redeemed', { order_id: ORDER })), { kind: 'order', orderId: ORDER });
    assert.equal(notificationTarget(note('code_redeemed', { order_id: 'nope' })), null);
  });
  it('rows look tappable and say where they go; gift icons', () => {
    assert.equal(notificationAction(note('gift_received', {}), new Map()).opens, 'notif.opens.vault');
    assert.equal(notificationAction(note('gift_claimed', { order_id: ORDER }), new Map()).opens, 'notif.opens.receipt');
    assert.equal(notificationIcon('gift_received'), 'gift');
    assert.equal(notificationIcon('code_redeemed'), 'key');
    assert.equal(notificationIcon('gift_delivered'), 'check-circle');
  });
  it('the receipt is the buyer\'s: a gift received is its own side', () => {
    assert.equal(giftSideOf({ gift_id: G }), 'delivery');
    assert.equal(giftSideOf({ gift_id: null, is_gift_delivery: true }), 'delivery', 'still a gift after its gift row is gone');
    assert.equal(giftSideOf({ gift_kind: 'gift' }), 'purchase');
    assert.equal(giftSideOf({ gift_kind: 'redeem_code' }), 'purchase');
    assert.equal(giftSideOf({}), null);
  });
  it('the screens follow it', () => {
    const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    const orderScreen = read('../app/order/[id].tsx');
    assert.match(orderScreen, /giftSide === 'delivery' \? \(\s*<GiftDeliveryCard/, 'a gift received shows the gift card, not ReceiptCard');
    assert.match(orderScreen, /canDownload = data !== null && giftSide !== 'delivery'/, 'and has no download');
    assert.doesNotMatch(read('../components/order/GiftDeliveryCard.tsx'), /amount|formatBirr/, 'no price on the recipient\'s side');
    assert.doesNotMatch(read('../components/gift/GiftCard.tsx'), /deliveryOrderId \}\s*\}\);\s*\n\s*\} catch/, 'claiming does not jump to a receipt');
    assert.doesNotMatch(read('../components/gift/GiftCard.tsx'), /router\.push\(\{ pathname: '\/order\/\[id\]', params: \{ id: result\./);
    assert.match(read('../app/gift/done/[id].tsx'), /t\('gift\.done\.receipt'\)/, 'the buyer is offered their receipt right after paying');
    assert.match(read('../components/market/OrderRow.tsx'), /giftSideOf\(order\) === 'delivery'/);
    assert.match(read('../components/admin/OrderSheet.tsx'), /const canRefundCompleted = !giftDelivery/);
    const panel = read('../components/header/NotificationPanel.tsx');
    assert.match(panel, /target\?\.kind === 'vault'/);
    assert.match(panel, /target\?\.kind === 'order'/);
  });
});

describe('tournament notifications', () => {
  const TID = '11111111-2222-4333-8444-555555555555';
  const t = (key, vars = {}) => `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}`;
  it('each type renders from its data and opens the tournament', () => {
    for (const [type, data] of [
      ['tournament_team_registered', { tournament_id: TID, tournament_name: 'Cup', team_name: 'Wolves', teams: 1, team_count: 8 }],
      ['tournament_joined', { tournament_id: TID, tournament_name: 'Cup', team_name: 'Wolves', captain_name: 'Abel' }],
      ['tournament_starting', { tournament_id: TID, tournament_name: 'Cup' }],
      ['tournament_cancelled', { tournament_id: TID, tournament_name: 'Cup' }],
      ['tournament_room_posted', { tournament_id: TID, tournament_name: 'Cup', updated: false }],
      ['tournament_won', { tournament_id: TID, tournament_name: 'Cup', team_name: 'Wolves', place: 2 }],
      ['tournament_finished', { tournament_id: TID, tournament_name: 'Cup' }],
    ]) {
      const text = notificationText({ type, title: 'x', body: 'y', data }, t);
      assert.notEqual(text.title, 'x', type);
      assert.match(text.body, /Cup/, type);
      assert.deepEqual(notificationTarget({ type, data }), { kind: 'tournament', tournamentId: TID }, type);
      assert.notEqual(notificationIcon(type), 'bell', type);
      assert.equal(notificationAction({ type, data }, new Map())?.opens, 'notif.opens.tournament');
    }
  });
  it('a room update says "updated"; a win names the place in words; a bad place falls back', () => {
    assert.match(notificationText({ type: 'tournament_room_posted', title: 'x', body: 'y', data: { tournament_name: 'Cup', updated: true } }, t).title, /tournamentRoomUpdated/);
    assert.match(notificationText({ type: 'tournament_won', title: 'x', body: 'y', data: { tournament_name: 'Cup', team_name: 'W', place: 1 } }, t).body, /place=tournament\.place\.1\|/);
    assert.match(notificationText({ type: 'tournament_won', title: 'x', body: 'y', data: { tournament_name: 'Cup', team_name: 'W', place: 7 } }, t).body, /place=tournament\.place\.n\|n=7/);
    assert.deepEqual(notificationText({ type: 'tournament_won', title: 'T', body: 'B', data: { tournament_name: 'Cup', team_name: 'W', place: '1; drop' } }, t), { title: 'T', body: 'B' });
  });
  it('the room notice never shows a room ID or password, even if the data had one', () => {
    const text = notificationText({ type: 'tournament_room_posted', title: 'x', body: 'y', data: { tournament_name: 'Cup', room_id: '123456', password: 'secret' } }, t);
    assert.doesNotMatch(JSON.stringify(text), /123456|secret/);
  });
  it('missing data falls back to the stored text and opens nothing', () => {
    assert.deepEqual(notificationText({ type: 'tournament_starting', title: 'T', body: 'B', data: {} }, t), { title: 'T', body: 'B' });
    assert.equal(notificationTarget({ type: 'tournament_starting', data: { tournament_id: 'nope' } }), null);
  });
});
