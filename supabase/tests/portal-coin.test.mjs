// Item 3 of the creator feature set: Portal Coin. An append-only ledger (portal_coin_balances/portal_coin_transactions),
// guarded the same way as the wallet (deferred balance-matches-ledger trigger, append-only trigger, one-statement
// atomic portal_coin_apply). +1 Portal Coin for any completed order, +2 TOTAL (never +1 then +2 more) for one that
// redeemed a discount code (detected via orders.discount_code_id, item 2's own link). Credited inside
// _complete_order(), same place item 2 already logs redemptions. Redemption converts whole exchange units of coins
// into wallet balance atomically via portal_coin_apply + wallet_apply in one function/transaction.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATIONS = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort().map((f) => read(`migrations/${f}`));

const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else fail++; console.log(c ? '  PASS' : '  FAIL', n, c ? '' : x); };
async function as(role, uid, sql, params) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}
const rows = async (role, uid, sql, params) => (await as(role, uid, sql, params)).rows;
async function rejects(n, role, uid, sql, re, params) {
  try { await as(role, uid, sql, params); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message + ' ' + (e.detail ?? '')); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const svc = (sql, params) => as('service_role', null, sql, params);

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

// ------------------------------------------------------------------ fixtures
const mkUser = async (email, name) => (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
const A = await mkUser('a@x.com', 'Abel'), B = await mkUser('b@x.com', 'Bruk'), C = await mkUser('c@x.com', 'Chuchu'), ADM = await mkUser('admin@x.com', 'Boss');
const CR = await mkUser('cr@x.com', 'Chaltu');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await as('authenticated', ADM, `select admin_set_content_creator($1, true)`, [CR]);

const bal = async (u) => Number((await one(`select balance from wallets where user_id = $1`, [u])).balance);
const setBal = async (u, target) => { const d = target - (await bal(u)); if (d !== 0) await as('authenticated', ADM, `select admin_adjust_balance($1, $2, 'test setup')`, [u, d]); };
const pcBal = async (u) => Number((await one(`select balance from portal_coin_balances where user_id = $1`, [u])).balance);
const ledgerOk = async () => {
  const r = await db.query(`select w.user_id, w.balance::float b, coalesce(sum(t.amount), 0)::float s from wallets w left join wallet_transactions t on t.user_id = w.user_id group by w.user_id, w.balance`);
  return r.rows.every((x) => x.b === x.s);
};
const pcLedgerOk = async () => {
  const r = await db.query(`select b.user_id, b.balance b, coalesce(sum(t.amount), 0) s from portal_coin_balances b left join portal_coin_transactions t on t.user_id = b.user_id group by b.user_id, b.balance`);
  return r.rows.every((x) => Number(x.b) === Number(x.s));
};

const mk = async (sql, params) => (await one(sql, params));
// A gift-card product (fulfillment 'code' -- needs a delivery code) and a no-ID games product (fulfillment 'topup' --
// can be refunded after completion, unlike a delivered code, so the refund/no-clawback test has something to use).
const P1 = (await mk(`insert into products (slug,name,category,is_active) values ('gc1','Card One','gift-cards',true) returning id`)).id;
const R1 = (await mk(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,'us','US','[]'::jsonb,'none',true) returning id`, [P1])).id;
const O1 = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'2000 card',2000,true) returning id`, [P1, R1])).id;
const O1_SMALL = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'500 card',500,true) returning id`, [P1, R1])).id;

const P2 = (await mk(`insert into products (slug,name,category,is_active) values ('game1','Some Game','games',true) returning id`)).id;
const R2 = (await mk(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,'all','All','[]'::jsonb,'none',true) returning id`, [P2])).id;
const O2 = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'800 Gems',800,true) returning id`, [P2, R2])).id;

const addLine = (u, option, qty = 1) => as('authenticated', u, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,$3,'{}'::jsonb,false)`, [u, option, qty]);
const checkout = async (u, code = null) => (await as('authenticated', u, `select checkout_cart($1) r`, [code])).rows[0].r;
const clearCart = (u) => db.query(`delete from cart_items where user_id = $1`, [u]);
const cancelPending = async (u, orderId) => { await as('authenticated', u, `select cancel_pending_order($1)`, [orderId]); await clearCart(u); };
const mkCode = async (code, creator, discount, commission) =>
  (await mk(`insert into discount_codes (code, creator_id, discount_percent, commission_percent, created_by) values ($1,$2,$3,$4,$5) returning id`, [code, creator, discount, commission, ADM])).id;
/** Pays a pending order in full via the bank-transfer path (so it reaches 'paid' without needing wallet balance). */
const payViaBank = async (u, orderId, amount, ref) => {
  await svc(`select begin_payment_verification($1,$2,'telebirr',$3) r`, [orderId, u, ref]);
  await svc(`select finish_payment_verification($1,'paid',$2,'live',200,'{}'::jsonb)`, [orderId, amount]);
};
const deliver = (orderId, code = null) => as('authenticated', ADM, `select (admin_deliver_order($1,$2)).status s`, [orderId, code]);

// =================================================================================================
console.log('\n# The ledger guard: a balance can only change with its ledger row (same mechanism as the wallet)');
{
  const before = await pcBal(A);
  let e = null;
  try { await db.query(`update portal_coin_balances set balance = balance + 5 where user_id = $1`, [A]); } catch (x) { e = x; }
  ok('a hand-typed balance change is refused at commit', e && /portal_coin_ledger_mismatch/.test(e.message), e?.message);
  ok('...and the balance did not move', (await pcBal(A)) === before);
  e = null;
  try { await db.query(`insert into portal_coin_transactions (user_id, kind, amount, balance_after, note) values ($1,'earn_purchase',5,${before + 5},'sneaky')`, [A]); } catch (x) { e = x; }
  ok('a ledger row added without moving the balance is refused too', e && /portal_coin_ledger_mismatch/.test(e.message), e?.message);
  // The append-only checks need an EXISTING row to try to edit/delete -- A has none yet (nothing has been earned),
  // so an UPDATE/DELETE matching zero rows would trivially "succeed" without ever firing the row trigger. Moved to
  // just after A earns its first coin, further down.
}
await rejects('a customer cannot call portal_coin_apply directly', 'authenticated', A, `select portal_coin_apply($1, 5, 'earn_purchase', 'x')`, /permission denied/, [A]);
await rejects('nor the service role', 'service_role', null, `select portal_coin_apply($1, 5, 'earn_purchase', 'x')`, /permission denied/, [A]);
await rejects('a customer cannot write a balance directly', 'authenticated', A, `update portal_coin_balances set balance = 9999 where user_id = '${A}'`, /permission denied/);
ok('every profile starts with a zero, ledger-consistent Portal Coin balance', (await pcBal(A)) === 0 && (await pcLedgerOk()));

// =================================================================================================
console.log('\n# RLS: same shape as wallets/wallet_transactions');
ok('a customer reads their own balance', (await rows('authenticated', A, `select user_id from portal_coin_balances`)).length === 1);
ok("another customer cannot see it", (await rows('authenticated', B, `select user_id from portal_coin_balances where user_id = $1`, [A])).length === 0);
ok('an admin reads every balance', (await rows('authenticated', ADM, `select user_id from portal_coin_balances`)).length >= 3);
await rejects('anonymous has no access at all', 'anon', null, `select user_id from portal_coin_balances`, /permission denied/);

// =================================================================================================
console.log('\n# +1 Portal Coin for a plain completed order (no discount code)');
{
  await addLine(A, O1_SMALL, 1);
  const c = await checkout(A); // no code, no balance -> unpaid bank-transfer order
  ok('(setup) unpaid, bank flow', c.paid === false);
  await payViaBank(A, c.order_id, c.amount, 'PC0000000000001');
  ok('no coin yet -- paid, not completed', (await pcBal(A)) === 0);
  const before = await pcBal(A);
  await deliver(c.order_id, 'GIFTCARD-PC-1');
  ok('exactly +1 after completion', (await pcBal(A)) === before + 1);
  const tx = await one(`select kind, amount, order_id from portal_coin_transactions where order_id = $1`, [c.order_id]);
  ok('one ledger row, kind earn_purchase, amount 1, linked to the order', tx.kind === 'earn_purchase' && Number(tx.amount) === 1 && tx.order_id === c.order_id, JSON.stringify(tx));
  ok('the books balance', await pcLedgerOk());

  // Now that A has one real ledger row, the append-only checks (deferred from the ledger-guard block above) can
  // actually try to edit/delete something.
  let e = null;
  try { await db.query(`update portal_coin_transactions set amount = amount where user_id = $1`, [A]); } catch (x) { e = x; }
  ok('the ledger cannot be edited (append-only)', e && /append_only/.test(e.message), e?.message);
  e = null;
  try { await db.query(`delete from portal_coin_transactions where user_id = $1`, [A]); } catch (x) { e = x; }
  ok('the ledger cannot be deleted from', e && /append_only/.test(e.message), e?.message);
}

console.log('\n# +2 TOTAL (never +1 then +2 more) for an order that redeemed a discount code');
{
  // A fresh customer: item 2's first-order-only rule means A (which just completed an order above) can no longer
  // redeem a discount code -- unrelated to this test, so a new customer keeps the two concerns apart.
  const D = await mkUser('d@x.com', 'Dagim');
  const code = await mkCode('PCCODE', CR, 10, 5);
  await addLine(D, O1, 1); // 2000 birr
  const c = await checkout(D, 'PCCODE');
  await payViaBank(D, c.order_id, c.amount, 'PC0000000000002');
  const before = await pcBal(D);
  await deliver(c.order_id, 'GIFTCARD-PC-2');
  ok('balance moved by exactly +2, not +1 then +2 more (+3)', (await pcBal(D)) === before + 2, `before=${before} after=${await pcBal(D)}`);
  const tx = await one(`select kind, amount from portal_coin_transactions where order_id = $1`, [c.order_id]);
  ok('a SINGLE ledger row for this order, kind earn_purchase_discount, amount 2', tx.kind === 'earn_purchase_discount' && Number(tx.amount) === 2, JSON.stringify(tx));
  ok('exactly one earn row per order (the partial unique index)', (await rows('authenticated', ADM, `select id from portal_coin_transactions where order_id = $1`, [c.order_id])).length === 1);
  ok('the books balance', await pcLedgerOk());
}

console.log('\n# per-code Portal Coin bonus (replaces the flat +2 default)');
{
  const E = await mkUser('e@x.com', 'Eyob');
  const bigBonus = (await one(
    `insert into discount_codes (code, creator_id, discount_percent, commission_percent, portal_coin_bonus) values ('BIGBONUS',$1,10,5,10) returning id`,
    [CR]
  )).id;
  await addLine(E, O1, 1);
  const c = await checkout(E, 'BIGBONUS');
  await payViaBank(E, c.order_id, c.amount, 'PC0000000000009');
  await deliver(c.order_id, 'GIFTCARD-PC-9');
  ok('a code with portal_coin_bonus=10 credits 10, not the default 2', (await pcBal(E)) === 10, await pcBal(E));
  ok('default portal_coin_bonus is still 2 for a code that does not set one', (await one(`select portal_coin_bonus from discount_codes where code = 'PCCODE'`)).portal_coin_bonus === 2);
}

console.log('\n# completing the same order twice cannot double-credit (invalid_transition blocks the second call)');
{
  await addLine(B, O1_SMALL, 1);
  const c = await checkout(B);
  await payViaBank(B, c.order_id, c.amount, 'PC0000000000003');
  await deliver(c.order_id, 'GIFTCARD-PC-3');
  const afterFirst = await pcBal(B);
  await rejects('a second admin_deliver_order call on the same order is refused', 'authenticated', ADM, `select admin_deliver_order($1, $2)`, /invalid_transition/, [c.order_id, 'GIFTCARD-PC-3-AGAIN']);
  ok('...and nothing extra was credited', (await pcBal(B)) === afterFirst);
}

console.log('\n# system_fulfill_order (the automatic-fulfilment path) credits coins the same way');
{
  await setBal(B, 5000);
  await addLine(B, O1_SMALL, 1);
  const c = await checkout(B); // wallet covers it -> paid instantly
  ok('(setup) wallet paid it instantly', c.paid === true);
  const before = await pcBal(B);
  await svc(`select system_fulfill_order($1, $2)`, [c.order_id, 'AUTO-PC-1']);
  ok('+1 via system_fulfill_order too', (await pcBal(B)) === before + 1);
}

// =================================================================================================
console.log("\n# flagged design call: a completed order's coins are NOT clawed back if it is later refunded");
{
  // A topup-fulfilment order (not 'code'): completed orders CAN be refunded for these (a delivered CODE order cannot
  // be refunded at all -- admin_set_order_status's own existing 'code_already_delivered' guard blocks that).
  await setBal(C, 5000);
  await addLine(C, O2, 1);
  const c = await checkout(C);
  ok('(setup) topup order, paid instantly', c.paid === true);
  await deliver(c.order_id); // no code needed: fulfillment is 'topup'
  const afterComplete = await pcBal(C);
  ok('earned its coin on completion', afterComplete === 1);
  const walletBefore = await bal(C);
  await as('authenticated', ADM, `select admin_set_order_status($1, 'refunded')`, [c.order_id]);
  ok('(setup) the order really was refunded: wallet got the money back', (await bal(C)) === walletBefore + Number(c.amount));
  ok('the Portal Coin it earned is untouched by the refund -- a deliberate call, see the migration header', (await pcBal(C)) === afterComplete);
}

// =================================================================================================
console.log('\n# portal_coin_settings: any signed-in customer can READ the rate (deviates from pricing_settings on purpose, see the migration header); only an admin can change it');
{
  const r = await one(`select coins_per_redemption cp, birr_per_redemption::float bp from portal_coin_settings`);
  ok('starts at the placeholder rate (1000 coins = 1 birr), flagged as needing a real value', r.cp === 1000 && r.bp === 1, JSON.stringify(r));
}
ok('a customer CAN read the rate -- unlike pricing_settings, this is not the shop\'s margin, the customer needs it to decide whether redeeming is worth it', (await rows('authenticated', A, `select * from portal_coin_settings`)).length === 1);
{
  // RLS filters the row out for a non-admin UPDATE (0 rows matched), not an error -- the exact behaviour pricing_settings
  // already relies on for the same reason. Proven by the value itself, not by trusting an affected-row count.
  await as('authenticated', A, `update portal_coin_settings set coins_per_redemption = 1 where id = true`);
  const check = await one(`select coins_per_redemption cp from portal_coin_settings`);
  ok('a customer cannot change the rate', check.cp === 1000, `cp=${check.cp}`);
}
await rejects('anonymous still cannot read it (signed-in only)', 'anon', null, `select * from portal_coin_settings`, /permission denied/);
await rejects('coins_per_redemption of 0 is refused', 'authenticated', ADM, `update portal_coin_settings set coins_per_redemption = 0 where id = true`, /check constraint|violates/);
await rejects('birr_per_redemption of 0 is refused', 'authenticated', ADM, `update portal_coin_settings set birr_per_redemption = 0 where id = true`, /check constraint|violates/);
await as('authenticated', ADM, `update portal_coin_settings set coins_per_redemption = 3, birr_per_redemption = 30 where id = true`);
{
  const r = await one(`select coins_per_redemption cp, birr_per_redemption::float bp from portal_coin_settings`);
  ok('an admin can set the real rate', r.cp === 3 && r.bp === 30, JSON.stringify(r));
}

// =================================================================================================
console.log('\n# redemption is paused (2026-10-02 follow-up): the function is revoked from every role, earning is untouched');
await rejects('a customer cannot call redeem_portal_coins', 'authenticated', C, `select redeem_portal_coins()`, /permission denied/);
await rejects('nor the service role', 'service_role', null, `select redeem_portal_coins()`, /permission denied/);
await rejects('nor anonymous', 'anon', null, `select redeem_portal_coins()`, /permission denied/);

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
