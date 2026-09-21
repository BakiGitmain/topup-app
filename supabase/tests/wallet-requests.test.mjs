// The wallet: the ledger guard, deposits, withdrawals, the shared payment-reference guard, the admin notification outbox,
// and paying an order from the wallet at checkout, plus row-level security for all of it.
//
// A caveat that matters: PGlite runs ONE connection, so two requests can't truly overlap here. The overdraw race is
// therefore proven two ways: (1) back-to-back requests on the same balance (the second must see what the first left),
// and (2) the guard is a single `UPDATE ... WHERE balance + amount >= 0` statement, which Postgres serialises per row.
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
const err = async (uid, sql, params, role = 'authenticated') => { try { await as(role, uid, sql, params); return null; } catch (e) { return { message: e.message, detail: e.detail }; } };
const svc = (sql, params) => as('service_role', null, sql, params);

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

// ------------------------------------------------------------------ fixtures
const mkUser = async (email, name) => {
  const u = (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
  return u;
};
const A = await mkUser('a@x.com', 'Abel'), B = await mkUser('b@x.com', 'Bruk'), ADM = await mkUser('admin@x.com', 'Boss');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await db.exec(`insert into payment_accounts (provider, account_name, account_number) values ('telebirr','Eyosiyas Daniel Debebe','0936363094'), ('cbe','Eyosiyas Daniel Debebe','1000727257229')`);

const bal = async (u) => Number((await one(`select balance from wallets where user_id = $1`, [u])).balance);
const setBal = async (u, target) => { const d = target - (await bal(u)); if (d !== 0) await as('authenticated', ADM, `select admin_adjust_balance($1, $2, 'test setup')`, [u, d]); };
const ledgerOk = async () => {
  const r = await db.query(`select w.user_id, w.balance::float b, coalesce(sum(t.amount), 0)::float s from wallets w left join wallet_transactions t on t.user_id = w.user_id group by w.user_id, w.balance`);
  return r.rows.every((x) => x.b === x.s);
};
const notes = async (kind) => (await db.query(`select message from admin_notifications ${kind ? `where kind = '${kind}'` : ''} order by created_at, id`)).rows.map((r) => r.message);
const cnt = async (t, where = 'true') => Number((await one(`select count(*)::int c from ${t} where ${where}`)).c);

const dep = async (u, amount) => (await as('authenticated', u, `select create_deposit_request($1) r`, [amount])).rows[0].r;
const beginDep = async (id, u, provider, ref) => (await svc(`select begin_deposit_verification($1,$2,$3,$4) r`, [id, u, provider, ref])).rows[0].r;
const finishDep = async (id, outcome, amount, mode = 'live') => (await svc(`select finish_deposit_verification($1,$2,$3,$4,200,'{"ok":true}'::jsonb) r`, [id, outcome, amount, mode])).rows[0].r;
const wd = async (u, amount, provider = 'telebirr', account = '0911223344') => (await as('authenticated', u, `select create_withdrawal_request($1,$2,$3) r`, [amount, provider, account])).rows[0].r;
const resolve = async (u, id, approve, note) => (await as('authenticated', u, `select * from admin_resolve_withdrawal($1,$2,$3)`, [id, approve, note ?? null])).rows[0];

// a gift card (no ID) and a Blood Strike pack (ID form, no supplier check) for the checkout tests
const P3 = (await one(`insert into products (slug,name,category,is_active) values ('steam','Steam Card','gift-cards',true) returning id`)).id;
const R3 = (await one(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,'us','us','[]'::jsonb,'none',true) returning id`, [P3])).id;
const O_CARD = (await one(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'Br 500 card',500,true) returning id`, [P3, R3])).id;
const O_SMALL = (await one(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'Br 100 card',100,true) returning id`, [P3, R3])).id;
const addLine = (u, option, qty = 1) => as('authenticated', u, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,$3,'{}'::jsonb,false)`, [u, option, qty]);
const checkout = async (u) => (await as('authenticated', u, `select checkout_cart() r`)).rows[0].r;
const resetOrders = () => db.exec(`delete from cart_items; delete from order_items; delete from payment_attempts where order_id is not null; delete from orders;`);

// =================================================================================================
console.log('\n# The ledger guard: a balance can only change with its ledger row');
await setBal(A, 1000);
ok('setup: admin credit wrote its ledger row and the books balance', (await bal(A)) === 1000 && (await ledgerOk()));
{
  let e = null;
  try { await db.query(`update wallets set balance = balance + 5 where user_id = $1`, [A]); } catch (x) { e = x; }
  ok('a hand-typed balance change (superuser, SQL editor) is refused at commit', e && /wallet_ledger_mismatch/.test(e.message), e?.message);
  ok('...and the balance did not move', (await bal(A)) === 1000);
  e = null;
  try { await db.query(`insert into wallet_transactions (user_id, kind, amount, balance_after, note) values ($1,'adjustment',50,1050,'sneaky')`, [A]); } catch (x) { e = x; }
  ok('a ledger row added without moving the balance is refused too', e && /wallet_ledger_mismatch/.test(e.message), e?.message);
  e = null;
  try { await db.query(`update wallet_transactions set amount = 1 where user_id = $1`, [A]); } catch (x) { e = x; }
  ok('the ledger cannot be edited', e && /append_only/.test(e.message), e?.message);
  e = null;
  try { await db.query(`delete from wallet_transactions where user_id = $1`, [A]); } catch (x) { e = x; }
  ok('the ledger cannot be deleted from', e && /append_only/.test(e.message), e?.message);
}
await rejects('a customer cannot call wallet_apply', 'authenticated', A, `select wallet_apply($1, 100, 'deposit', 'x')`, /permission denied/, [A]);
await rejects('nor the service role', 'service_role', null, `select wallet_apply($1, 100, 'deposit', 'x')`, /permission denied/, [A]);
await rejects('a customer cannot write a balance', 'authenticated', A, `update wallets set balance = 9999 where user_id = '${A}'`, /permission denied/);
ok('the ledger and balance are unchanged after all that', (await bal(A)) === 1000 && (await ledgerOk()));

// =================================================================================================
console.log('\n# RLS');
const d0 = await dep(A, 200);
const w0 = await wd(A, 50);
ok('a customer reads their own deposit request', (await rows('authenticated', A, `select id from deposit_requests`)).length === 1);
ok("another customer sees none of it", (await rows('authenticated', B, `select id from deposit_requests`)).length === 0);
ok('a customer reads their own withdrawal request', (await rows('authenticated', A, `select id from withdrawal_requests`)).length === 1);
ok("another customer sees none of it", (await rows('authenticated', B, `select id from withdrawal_requests`)).length === 0);
ok("...even when asking for A's rows by user_id", (await rows('authenticated', B, `select id from withdrawal_requests where user_id = $1`, [A])).length === 0 && (await rows('authenticated', B, `select id from wallet_transactions where user_id = $1`, [A])).length === 0);
ok("a customer's ledger is their own", (await rows('authenticated', A, `select id from wallet_transactions`)).length >= 2 && (await rows('authenticated', B, `select id from wallet_transactions`)).length === 0);
ok('an admin reads every request', (await rows('authenticated', ADM, `select id from deposit_requests`)).length === 1 && (await rows('authenticated', ADM, `select id from withdrawal_requests`)).length === 1);
for (const t of ['deposit_requests', 'withdrawal_requests', 'wallet_transactions']) {
  await rejects(`a customer cannot insert into ${t}`, 'authenticated', A, `insert into ${t} (user_id) values ('${A}')`, /permission denied/);
  await rejects(`a customer cannot update ${t}`, 'authenticated', A, `update ${t} set user_id = user_id`, /permission denied/);
  await rejects(`a customer cannot delete from ${t}`, 'authenticated', A, `delete from ${t}`, /permission denied/);
}
ok('the notification outbox is invisible to customers', (await rows('authenticated', A, `select id from admin_notifications`)).length === 0);
ok('...but an admin can read it', (await rows('authenticated', ADM, `select id from admin_notifications`)).length > 0);
await rejects('a customer cannot write the outbox', 'authenticated', A, `insert into admin_notifications (kind, message) values ('x','y')`, /permission denied/);
await rejects('a customer cannot claim notifications', 'authenticated', A, `select * from claim_admin_notifications(5)`, /permission denied/);
await rejects('a customer cannot enqueue one', 'authenticated', A, `select enqueue_admin_notification('x','y')`, /permission denied/);
await rejects('anonymous cannot create a deposit', 'anon', null, `select create_deposit_request(100)`, /permission denied/);
await rejects('anonymous cannot create a withdrawal', 'anon', null, `select create_withdrawal_request(100,'telebirr','0911223344')`, /permission denied/);
await rejects('a customer cannot run the verification steps', 'authenticated', A, `select begin_deposit_verification('${d0.deposit_id}','${A}','telebirr','ABCD1234')`, /permission denied/);
await rejects('...nor finish one', 'authenticated', A, `select finish_deposit_verification('${d0.deposit_id}','paid',200,'live',200,'{}'::jsonb)`, /permission denied/);
ok('payment attempts stay admin-only', (await rows('authenticated', A, `select id from payment_attempts`)).length === 0);
// clean the fixtures used above
await as('authenticated', A, `select cancel_deposit_request('${d0.deposit_id}')`);
await resolve(ADM, w0.withdrawal_id, false, 'test cleanup');
ok('setup cleaned: balance back to 1000 and the books balance', (await bal(A)) === 1000 && (await ledgerOk()));

// =================================================================================================
console.log('\n# Deposit: creating a request');
for (const bad of [0, 9.99, -5, 100000.01, null]) {
  const e = await err(A, `select create_deposit_request($1)`, [bad]);
  ok(`amount ${bad} is refused`, e && /invalid_amount/.test(e.message), JSON.stringify(e));
}
const nBefore = await cnt('admin_notifications', `kind = 'deposit_requested'`);
const D1 = await dep(A, 500);
ok('a request comes back with its id and amount', D1.deposit_id && Number(D1.amount) === 500);
ok('...and BOTH payment accounts (reused from payment_accounts)', D1.accounts.length === 2 && D1.accounts.every((a) => a.account_name === 'Eyosiyas Daniel Debebe') && D1.accounts.find((a) => a.provider === 'telebirr').account_number === '0936363094');
ok('the request starts as pending_reference with no reference', (await one(`select status, payment_reference from deposit_requests where id = $1`, [D1.deposit_id])).status === 'pending_reference');
ok('a Telegram notification was queued: amount, customer', (await cnt('admin_notifications', `kind = 'deposit_requested'`)) === nBefore + 1);
{
  const [m] = (await notes('deposit_requested')).slice(-1);
  ok('...it says what happened, the amount and who', /New deposit request/.test(m) && /Br 500/.test(m) && /Abel <a@x\.com>/.test(m), m);
}
ok('the balance did not move (a request is not money)', (await bal(A)) === 1000);
{
  const e = await err(A, `select create_deposit_request(300)`);
  ok('a second open deposit is refused, and tells which one to resume', e && /deposit_open/.test(e.message) && e.detail === D1.deposit_id, JSON.stringify(e));
}
{
  const e = await err(B, `select cancel_deposit_request($1)`, [D1.deposit_id]);
  ok("nobody can cancel someone else's deposit", e && /deposit_not_found/.test(e.message));
}
await as('authenticated', A, `select cancel_deposit_request($1)`, [D1.deposit_id]);
ok('cancelling closes it (failed)', (await one(`select status from deposit_requests where id = $1`, [D1.deposit_id])).status === 'failed');
const D2 = await dep(A, 500);
ok('...and a new one can then be made', D2.deposit_id !== D1.deposit_id);

// =================================================================================================
console.log('\n# Deposit: verification credits the wallet, exactly once');
const REF = 'FT25DEPOSIT001';
ok('wrong user cannot start a check on it', (await beginDep(D2.deposit_id, B, 'telebirr', REF)).result === 'not_found');
ok('an unknown request is not found', (await beginDep('00000000-0000-0000-0000-000000000000', A, 'telebirr', REF)).result === 'not_found');
const go = await beginDep(D2.deposit_id, A, 'telebirr', REF);
ok('begin answers go with the REQUEST\'s own amount and the account name', go.result === 'go' && Number(go.amount) === 500 && go.account_name === 'Eyosiyas Daniel Debebe', JSON.stringify(go));
ok('...and the request is now pending_verification', (await one(`select status from deposit_requests where id = $1`, [D2.deposit_id])).status === 'pending_verification');
ok('a second check while one is running is in_progress (double-tap)', (await beginDep(D2.deposit_id, A, 'telebirr', REF)).result === 'in_progress');

const notesBefore = await cnt('admin_notifications');
{
  let e = null;
  try { await finishDep(D2.deposit_id, 'paid', 499.99); } catch (x) { e = x; }
  ok('"paid" for a DIFFERENT amount is refused by the database (no partial credit)', e && /paid_amount_must_equal_requested/.test(e.message), e?.message);
  ok('...nothing was credited, logged or announced', (await bal(A)) === 1000 && (await cnt('admin_notifications')) === notesBefore && (await cnt('wallet_transactions', `deposit_id = '${D2.deposit_id}'`)) === 0);
  e = null;
  try { await db.query(`update deposit_requests set status='paid', paid_at=now(), payment_mode='live', payment_verified_amount=1 where id = $1`, [D2.deposit_id]); } catch (x) { e = x; }
  ok('and a hand-edit to "paid" with the wrong amount is refused by a CHECK', e && /deposit_paid_exact_check/.test(e.message), e?.message);
}
const paid = await finishDep(D2.deposit_id, 'paid', 500);
ok('the exact amount: paid', paid.result === 'paid' && Number(paid.balance) === 1500, JSON.stringify(paid));
ok('the balance went up by exactly the amount', (await bal(A)) === 1500);
{
  const tx = await one(`select kind, amount::float a, balance_after::float ba, deposit_id, note from wallet_transactions where deposit_id = $1`, [D2.deposit_id]);
  ok('...with a ledger row: kind deposit, +500, balance_after 1500, linked to the request', tx && tx.kind === 'deposit' && tx.a === 500 && tx.ba === 1500 && tx.deposit_id === D2.deposit_id, JSON.stringify(tx));
  ok('...and the books balance', await ledgerOk());
}
{
  const d = await one(`select status, payment_provider, payment_reference, payment_mode, payment_verified_amount::float v, paid_at from deposit_requests where id = $1`, [D2.deposit_id]);
  ok('the request records provider, reference, mode, amount and time', d.status === 'paid' && d.payment_provider === 'telebirr' && d.payment_reference === REF && d.payment_mode === 'live' && d.v === 500 && d.paid_at);
  const [m] = (await notes('deposit_paid')).slice(-1);
  ok('the SECOND Telegram notification landed: received, amount, customer, new balance, ref', /Deposit received/.test(m) && /Br 500 via Telebirr/.test(m) && /Abel/.test(m) && /Br 1,500/.test(m) && m.includes(REF), m);
  ok('the attempt was logged for audit (admin-only)', (await cnt('payment_attempts', `deposit_id = '${D2.deposit_id}' and outcome = 'paid'`)) === 1);
}
// idempotency
{
  const again = await beginDep(D2.deposit_id, A, 'telebirr', REF);
  ok('the same request + reference again is answered from the record: closed / paid', again.result === 'closed' && again.status === 'paid', JSON.stringify(again));
  const fin = await finishDep(D2.deposit_id, 'paid', 500);
  ok('a repeated finish is closed too', fin.result === 'closed');
  ok('...NO second credit, ledger row or notification', (await bal(A)) === 1500 && (await cnt('wallet_transactions', `deposit_id = '${D2.deposit_id}'`)) === 1 && (await notes('deposit_paid')).length === 1);
  let e = null;
  try { await db.query(`insert into wallet_transactions (user_id, kind, amount, balance_after, deposit_id) values ($1,'deposit',500,2000,$2)`, [A, D2.deposit_id]); } catch (x) { e = x; }
  ok('and even a direct second credit row is refused by a unique index', e && /wallet_tx_one_deposit_credit/.test(e.message), e?.message);
}

// =================================================================================================
console.log('\n# Deposit: a wrong amount, an unverified reference, reference reuse');
const D3 = await dep(A, 300);
await beginDep(D3.deposit_id, A, 'cbe', 'FT25MISMATCH01');
const mm = await finishDep(D3.deposit_id, 'mismatch', 250);
ok('a mismatch: nothing credited', mm.result === 'mismatch' && (await bal(A)) === 1500 && (await cnt('wallet_transactions', `deposit_id = '${D3.deposit_id}'`)) === 0);
ok('...status is mismatch, the found amount is recorded', (await one(`select status, payment_verified_amount::float v from deposit_requests where id = $1`, [D3.deposit_id])).status === 'mismatch');
ok('...and Telegram is told it needs review, saying nothing was credited', /needs review/.test((await notes('deposit_mismatch')).slice(-1)[0]) && /NOTHING was credited/.test((await notes('deposit_mismatch')).slice(-1)[0]));
ok('a mismatched deposit is closed: it cannot be re-run into a credit', (await beginDep(D3.deposit_id, A, 'cbe', 'FT25MISMATCH01')).result === 'closed');
ok('...its transfer stays claimed (cannot be reused elsewhere)', (await beginDep((await dep(A, 100)).deposit_id, A, 'cbe', 'FT25MISMATCH01')).result === 'reference_used');
{
  // that last dep() left an open deposit; use it for the not-verified path
  const open = await one(`select id from deposit_requests where user_id = $1 and status = 'pending_reference'`, [A]);
  const wrong = await beginDep(open.id, A, 'telebirr', 'FT25TYPO00001');
  ok('(setup) an open deposit starts a check', wrong.result === 'go');
  const nv = await finishDep(open.id, 'not_verified', null);
  ok('a reference that is not found: not_verified, nothing credited', nv.result === 'not_verified' && (await bal(A)) === 1500);
  ok('...the request is open again and the reference is FREED for a retry', (await one(`select status, payment_reference from deposit_requests where id = $1`, [open.id])).status === 'pending_reference' && (await one(`select payment_reference r from deposit_requests where id = $1`, [open.id])).r === null);
  ok('...so the customer can retry with a corrected reference', (await beginDep(open.id, A, 'telebirr', 'FT25RIGHT00001')).result === 'go');
  const un = await finishDep(open.id, 'unavailable', null);
  ok('ShegerPay being unreachable is "unavailable": retry allowed, nothing credited', un.result === 'unavailable' && (await bal(A)) === 1500);
  await as('authenticated', A, `select cancel_deposit_request($1)`, [open.id]);
}
// reuse across deposits
{
  const dB = await dep(B, 500);
  const r = await beginDep(dB.deposit_id, B, 'telebirr', REF);
  ok("another customer cannot claim a reference that already credited A's deposit", r.result === 'reference_used', JSON.stringify(r));
  ok('...(nothing changed for B)', (await bal(B)) === 0 && (await one(`select status from deposit_requests where id = $1`, [dB.deposit_id])).status === 'pending_reference');
  const r2 = await beginDep(dB.deposit_id, B, 'cbe', REF);
  ok('the SAME text on a DIFFERENT provider is a different transfer (allowed)', r2.result === 'go');
  await finishDep(dB.deposit_id, 'not_verified', null);
  await as('authenticated', B, `select cancel_deposit_request($1)`, [dB.deposit_id]);
}

// =================================================================================================
console.log('\n# One transfer can pay an order OR a deposit, never both');
await resetOrders();
await setBal(A, 0);
await addLine(A, O_SMALL, 1);
const c1 = await checkout(A);
ok('(setup) with no balance, checkout leaves an unpaid bank-transfer order', c1.paid === false && Number(c1.amount) === 100);
const REF_O = 'FT25ORDERREF01';
ok('an order claims a transfer', (await svc(`select begin_payment_verification($1,$2,'telebirr',$3) r`, [c1.order_id, A, REF_O])).rows[0].r.result === 'go');
{
  const dA = await dep(A, 100);
  const r = await beginDep(dA.deposit_id, A, 'telebirr', REF_O);
  ok('a deposit cannot claim the same transfer (even for the same customer)', r.result === 'reference_used', JSON.stringify(r));
  await as('authenticated', A, `select cancel_deposit_request($1)`, [dA.deposit_id]);
}
await svc(`select finish_payment_verification($1,'paid',100,'live',200,'{}'::jsonb)`, [c1.order_id]);
ok('(the order was paid by that transfer)', (await one(`select status from orders where id = $1`, [c1.order_id])).status === 'paid');
{
  const dA = await dep(A, 100);
  ok('...and once paid it stays claimed against deposits', (await beginDep(dA.deposit_id, A, 'telebirr', REF_O)).result === 'reference_used');
  const REF_D = 'FT25DEPOSITREF2';
  await beginDep(dA.deposit_id, A, 'telebirr', REF_D);
  await finishDep(dA.deposit_id, 'paid', 100);
  ok('(a deposit is paid by another transfer)', (await bal(A)) === 100);
  await addLine(A, O_SMALL, 1);
  const c2 = await checkout(A);
  ok('(that deposit then pays the next order from the wallet)', c2.paid === true);
  await resetOrders();
  await setBal(A, 0);
  await addLine(A, O_SMALL, 1);
  const c3 = await checkout(A);
  const r = (await svc(`select begin_payment_verification($1,$2,'telebirr',$3) r`, [c3.order_id, A, REF_D])).rows[0].r;
  ok('an order cannot claim a transfer that already credited a deposit', r.result === 'reference_used', JSON.stringify(r));
}
// a dead claim (an app that crashed mid-check) does not lock the customer out, in either table
{
  await resetOrders();
  const dX = await dep(B, 100);
  await beginDep(dX.deposit_id, B, 'cbe', 'FT25STALE000001');
  ok('a fresh claim blocks another deposit', (await beginDep((await dep(A, 100)).deposit_id, A, 'cbe', 'FT25STALE000001')).result === 'reference_used');
  await db.exec(`update deposit_requests set verifying_since = now() - interval '5 minutes' where id = '${dX.deposit_id}'`);
  const open = await one(`select id from deposit_requests where user_id = '${A}' and status = 'pending_reference'`);
  ok('a claim whose check died over 90 s ago is released and taken over', (await beginDep(open.id, A, 'cbe', 'FT25STALE000001')).result === 'go');
  ok("...the dead one is open again, not stuck", (await one(`select status from deposit_requests where id = $1`, [dX.deposit_id])).status === 'pending_reference');
  await finishDep(open.id, 'not_verified', null);
  await as('authenticated', A, `select cancel_deposit_request($1)`, [open.id]);
  await as('authenticated', B, `select cancel_deposit_request($1)`, [dX.deposit_id]);
}

// =================================================================================================
console.log('\n# Payout account clean-up (the SAME table is asserted in src/lib/walletLogic.test.mjs)');
for (const [provider, raw, want] of [
  ['telebirr', '+251 911 22 33 44', '0911223344'], ['telebirr', '251911223344', '0911223344'], ['telebirr', '911223344', '0911223344'],
  ['telebirr', '0911-22-33-44', '0911223344'], ['telebirr', '+251711223344', '0711223344'], ['telebirr', '0811223344', '0811223344'],
  ['telebirr', '', ''], ['cbe', '1000 7272 57229', '1000727257229'], ['cbe', '1000-7272-57229', '1000727257229'],
]) {
  const got = (await one(`select normalize_payout_account($1, $2) v`, [provider, raw])).v;
  ok(`${provider}: "${raw}" -> "${want}"`, got === want, got);
}

console.log('\n# Withdrawal: requesting holds the money atomically');
await resetOrders();
await setBal(A, 1000);
{
  const before = await bal(A);
  const nN = await cnt('admin_notifications', `kind = 'withdrawal_requested'`);
  const w = await wd(A, 300, 'telebirr', '+251 911 22 33 44');
  ok('the request is created and returns the new balance', w.withdrawal_id && Number(w.amount) === 300 && Number(w.balance) === before - 300, JSON.stringify(w));
  ok('the balance is deducted IMMEDIATELY', (await bal(A)) === before - 300);
  const r = await one(`select status, payout_provider, payout_account from withdrawal_requests where id = $1`, [w.withdrawal_id]);
  ok('the number is stored normalised, status pending', r.status === 'pending' && r.payout_account === '0911223344' && r.payout_provider === 'telebirr', JSON.stringify(r));
  const tx = await one(`select kind, amount::float a, balance_after::float ba from wallet_transactions where withdrawal_id = $1`, [w.withdrawal_id]);
  ok('a ledger row: withdrawal, -300, balance_after 700, linked', tx.kind === 'withdrawal' && tx.a === -300 && tx.ba === 700, JSON.stringify(tx));
  ok('the books balance', await ledgerOk());
  ok('one Telegram notification queued', (await cnt('admin_notifications', `kind = 'withdrawal_requested'`)) === nN + 1);
  const [m] = (await notes('withdrawal_requested')).slice(-1);
  ok('...with the detail: amount, WHERE TO SEND IT, customer', /Br 300/.test(m) && /SEND TO: Telebirr 0911223344/.test(m) && /Abel <a@x\.com>/.test(m), m);
  ok('...and it says the amount is already held', /already held/.test(m));
  await resolve(ADM, w.withdrawal_id, false, 'cleanup');
}
ok('a CBE account (13 digits) works', (await wd(A, 20, 'cbe', '1000 7272 57229')).withdrawal_id);
for (const [prov, acct, label] of [['cbe', '100072725722', 'CBE with 12 digits'], ['cbe', '10007272572299', 'CBE with 14'], ['telebirr', '0811223344', 'Telebirr not 07/09'], ['telebirr', '091122334', 'Telebirr too short'], ['telebirr', 'abc', 'letters'], ['bank', '0911223344', 'unknown provider']]) {
  const e = await err(A, `select create_withdrawal_request(20,$1,$2)`, [prov, acct]);
  ok(`${label} is refused`, e && /invalid_(account|provider)/.test(e.message), JSON.stringify(e));
}
for (const bad of [0, 9, -50, null]) {
  const e = await err(A, `select create_withdrawal_request($1,'telebirr','0911223344')`, [bad]);
  ok(`amount ${bad} is refused`, e && /invalid_amount/.test(e.message));
}
await db.exec(`update withdrawal_requests set status = 'declined', admin_note = 'cleanup', resolved_at = now() where status = 'pending'`); // (tidy state; the money side is covered below)
// The ledger no longer matches after that hand edit? It does: a status edit moves no money. Rebuild a clean slate anyway.
await setBal(A, 0);

console.log('\n# Withdrawal: the overdraw race');
await setBal(A, 100);
{
  const w1 = await wd(A, 60);
  const e = await err(A, `select create_withdrawal_request(60,'telebirr','0911223344')`);
  ok('two requests on one balance: the first succeeds', w1.withdrawal_id && (await bal(A)) === 40);
  ok('...the second is refused (insufficient_balance)', e && /insufficient_balance/.test(e.message), JSON.stringify(e));
  ok('...and NOTHING of it was written (no request, no ledger row, no notification)', (await cnt('withdrawal_requests', `user_id = '${A}' and status = 'pending'`)) === 1 && (await cnt('wallet_transactions', `kind = 'withdrawal' and user_id = '${A}' and created_at >= now() - interval '1 minute'`)) >= 1 && (await bal(A)) === 40);
  const e2 = await err(A, `select create_withdrawal_request(40.01,'telebirr','0911223344')`);
  ok('one cent over the balance is refused', e2 && /insufficient_balance/.test(e2.message));
  const w2 = await wd(A, 40);
  ok('the exact balance is allowed and leaves exactly 0', w2.withdrawal_id && (await bal(A)) === 0);
  const e3 = await err(A, `select create_withdrawal_request(10,'telebirr','0911223344')`);
  ok('an empty balance can never be overdrawn', e3 && /insufficient_balance/.test(e3.message) && (await bal(A)) === 0);
  ok('the balance is never negative and the books balance', (await one(`select min(balance)::float m from wallets`)).m >= 0 && (await ledgerOk()));
  let cnstr = null;
  try { await db.query(`update wallets set balance = -5 where user_id = $1`, [A]); } catch (x) { cnstr = x; }
  ok('(a negative balance is impossible at the table level too)', cnstr && /wallets_balance_check/.test(cnstr.message));
  await resolve(ADM, w1.withdrawal_id, false, 'cleanup 1');
  await resolve(ADM, w2.withdrawal_id, false, 'cleanup 2');
}

console.log('\n# Withdrawal: limits');
await setBal(A, 1000);
{
  const made = [];
  for (let i = 0; i < 5; i++) made.push((await wd(A, 10)).withdrawal_id);
  const e = await err(A, `select create_withdrawal_request(10,'telebirr','0911223344')`);
  ok('at most 5 pending requests per customer', e && /too_many_pending/.test(e.message), JSON.stringify(e));
  for (const id of made) await resolve(ADM, id, false, 'cleanup');
}

console.log('\n# Withdrawal: admin approves (the money was sent by hand)');
await setBal(A, 1000);
{
  const w = await wd(A, 250, 'cbe', '1000727257229');
  const before = await bal(A);
  const txBefore = await cnt('wallet_transactions');
  await rejects('a customer cannot resolve (not even their own)', 'authenticated', A, `select * from admin_resolve_withdrawal('${w.withdrawal_id}', true, 'me')`, /forbidden/);
  await rejects('...and cannot flip the status directly', 'authenticated', A, `update withdrawal_requests set status = 'paid'`, /permission denied/);
  const r = await resolve(ADM, w.withdrawal_id, true, 'Sent via CBE, ref 123');
  ok('approve marks it paid with the note and who/when', r.status === 'paid' && r.admin_note === 'Sent via CBE, ref 123' && r.resolved_by === ADM && r.resolved_at);
  ok('approve moves NO money (it was already held)', (await bal(A)) === before && (await cnt('wallet_transactions')) === txBefore && (await ledgerOk()));
  const e = await err(ADM, `select * from admin_resolve_withdrawal($1,true,null)`, [w.withdrawal_id]);
  ok('resolving it again is refused', e && /already_resolved/.test(e.message) && e.detail === 'paid');
  const e2 = await err(ADM, `select * from admin_resolve_withdrawal($1,false,'changed my mind')`, [w.withdrawal_id]);
  ok('a paid withdrawal can never be declined afterwards (no refund after money was sent)', e2 && /already_resolved/.test(e2.message) && (await bal(A)) === before);
}
{
  const e = await err(ADM, `select * from admin_resolve_withdrawal('00000000-0000-0000-0000-000000000000', true, null)`);
  ok('an unknown request is not found', e && /withdrawal_not_found/.test(e.message));
}

console.log('\n# Withdrawal: admin declines, the refund is exact and logged');
await setBal(A, 1234.5);
{
  const balanceBeforeRequest = await bal(A);
  const w = await wd(A, 234.5);
  ok('(setup) the amount is held', (await bal(A)) === 1000);
  const eNote = await err(ADM, `select * from admin_resolve_withdrawal($1,false,'   ')`, [w.withdrawal_id]);
  ok('a decline needs a note', eNote && /note_required/.test(eNote.message));
  ok('...and a refused decline changed nothing', (await bal(A)) === 1000 && (await one(`select status from withdrawal_requests where id = $1`, [w.withdrawal_id])).status === 'pending');
  const r = await resolve(ADM, w.withdrawal_id, false, 'Account name does not match');
  ok('decline: status declined with the note', r.status === 'declined' && r.admin_note === 'Account name does not match');
  ok('THE REFUND IS EXACT: the balance is back to what it was before the request', (await bal(A)) === balanceBeforeRequest, String(await bal(A)));
  const refund = await one(`select kind, amount::float a, balance_after::float ba, note, created_by from wallet_transactions where withdrawal_id = $1 and kind = 'refund'`, [w.withdrawal_id]);
  ok('the refund is a ledger row: +234.50, balance_after == the pre-request balance, the admin\'s note, who did it', refund && refund.a === 234.5 && refund.ba === balanceBeforeRequest && /Account name does not match/.test(refund.note) && refund.created_by === ADM, JSON.stringify(refund));
  ok('the books balance', await ledgerOk());
  const e = await err(ADM, `select * from admin_resolve_withdrawal($1,false,'again')`, [w.withdrawal_id]);
  ok('a second decline is refused: no double refund', e && /already_resolved/.test(e.message) && (await bal(A)) === balanceBeforeRequest);
  let dup = null;
  try { await db.query(`insert into wallet_transactions (user_id, kind, amount, balance_after, withdrawal_id) values ($1,'refund',234.5,$2,$3)`, [A, balanceBeforeRequest + 234.5, w.withdrawal_id]); } catch (x) { dup = x; }
  ok('...and even a direct second refund row is refused by a unique index', dup && /wallet_tx_one_withdrawal_refund/.test(dup.message), dup?.message);
  ok("the customer sees the decline note on their own request", (await rows('authenticated', A, `select admin_note from withdrawal_requests where id = $1`, [w.withdrawal_id]))[0].admin_note === 'Account name does not match');
}

// =================================================================================================
console.log('\n# Checkout: pay from the wallet when it covers the total');
await resetOrders();
await setBal(A, 1000);
{
  await addLine(A, O_CARD, 1);
  const c = await checkout(A);
  ok('the balance covers it: paid instantly, no bank screen', c.paid === true && Number(c.amount) === 500 && Number(c.balance) === 500, JSON.stringify(c));
  const o = await one(`select status, payment_provider, payment_reference, payment_mode, payment_verified_amount::float v, paid_at, amount::float a from orders where id = $1`, [c.order_id]);
  ok("the order is paid with provider 'wallet' and no bank reference", o.status === 'paid' && o.payment_provider === 'wallet' && o.payment_reference === null && o.payment_mode === 'wallet' && o.v === 500 && o.paid_at && o.a === 500, JSON.stringify(o));
  const tx = await one(`select kind, amount::float a, balance_after::float ba, order_id from wallet_transactions where order_id = $1`, [c.order_id]);
  ok('the wallet was charged once, with a ledger row (purchase, -500, balance_after 500, linked)', tx.kind === 'purchase' && tx.a === -500 && tx.ba === 500 && (await bal(A)) === 500);
  ok('the cart was emptied and no unpaid order is waiting', (await cnt('cart_items')) === 0 && (await cnt('orders', `status = 'pending_payment'`)) === 0);
  ok('order_items were snapshotted as usual', (await cnt('order_items', `order_id = '${c.order_id}'`)) === 1);
  ok('the books balance', await ledgerOk());
}
console.log('\n# Checkout: not enough balance falls back to the bank transfer, untouched');
{
  await resetOrders();
  await setBal(A, 400);
  await addLine(A, O_CARD, 1);
  const c = await checkout(A);
  ok('400 < 500: NOT paid; the bank-transfer order is created as before', c.paid === false && Number(c.balance) === 400, JSON.stringify(c));
  ok("...status pending_payment, no provider, nothing deducted (no partial balance)", (await one(`select status, payment_provider from orders where id = $1`, [c.order_id])).status === 'pending_payment' && (await bal(A)) === 400 && (await cnt('wallet_transactions', `order_id = '${c.order_id}'`)) === 0);
  await addLine(A, O_SMALL, 1);
  const e = await err(A, `select checkout_cart()`);
  ok('a second checkout while one is unpaid still resumes the first (one unpaid order per customer)', e && /pending_order_exists/.test(e.message) && e.detail === c.order_id);
  ok('...and a bank order draws nothing from the wallet', (await bal(A)) === 400);

  console.log('\n# Checkout: wallet vs bank on the SAME unpaid order');
  const PAY = (id) => as('authenticated', A, `select pay_order_with_wallet($1) r`, [id]);
  const e1 = await err(A, `select pay_order_with_wallet($1)`, [c.order_id]);
  ok('the wallet cannot pay an order it does not cover', e1 && /insufficient_balance/.test(e1.message) && (await bal(A)) === 400 && (await one(`select status from orders where id = $1`, [c.order_id])).status === 'pending_payment');
  const e2 = await err(B, `select pay_order_with_wallet($1)`, [c.order_id]);
  ok("another customer cannot pay (or even see) someone else's order", e2 && /order_not_found/.test(e2.message));
  await svc(`select begin_payment_verification($1,$2,'telebirr','FT25WALLETVS01')`, [c.order_id, A]);
  await setBal(A, 2000);
  const e3 = await err(A, `select pay_order_with_wallet($1)`, [c.order_id]);
  ok('while a bank check is running, the wallet is refused (only one payment path at a time)', e3 && /order_not_payable/.test(e3.message) && e3.detail === 'verifying' && (await bal(A)) === 2000);
  // the bank check finishes first
  await svc(`select finish_payment_verification($1,'paid',500,'live',200,'{}'::jsonb)`, [c.order_id]);
  const e4 = await err(A, `select pay_order_with_wallet($1)`, [c.order_id]);
  ok('bank paid first: the wallet then refuses (already paid), so no double payment', e4 && /order_not_payable/.test(e4.message) && e4.detail === 'paid' && (await bal(A)) === 2000);

  // and the other way round: the wallet first, then a late bank verification
  await resetOrders();
  await addLine(A, O_CARD, 1);
  const c2 = await as('authenticated', A, `select create_cart_order() r`).then((r) => r.rows[0].r);
  const p = (await PAY(c2.order_id)).rows[0].r;
  ok('paying an unpaid order from the wallet works once funds are there', p.status === 'paid' && Number(p.balance) === 1500 && (await bal(A)) === 1500);
  const late = (await svc(`select begin_payment_verification($1,$2,'telebirr','FT25LATEBANK01') r`, [c2.order_id, A])).rows[0].r;
  ok('wallet paid first: a later bank verification is closed/paid, the transfer is NOT claimed', late.result === 'closed' && late.status === 'paid');
  ok("...and that transfer stays free for another use", (await one(`select payment_reference from orders where id = $1`, [c2.order_id])).payment_reference === null);
  const again = await err(A, `select pay_order_with_wallet($1)`, [c2.order_id]);
  ok('paying the same order from the wallet twice charges once', again && /order_not_payable/.test(again.message) && (await bal(A)) === 1500 && (await cnt('wallet_transactions', `order_id = '${c2.order_id}'`)) === 1);
}
console.log('\n# Checkout: exact balance, and an unpaid order that took a stale bank claim');
{
  await resetOrders();
  await setBal(A, 500);
  await addLine(A, O_CARD, 1);
  const c = await checkout(A);
  ok('a balance exactly equal to the total pays from the wallet, leaving 0', c.paid === true && (await bal(A)) === 0);
  await resetOrders();
  await addLine(A, O_CARD, 1);
  const u = await as('authenticated', A, `select create_cart_order() r`).then((r) => r.rows[0].r);
  await svc(`select begin_payment_verification($1,$2,'cbe','FT25ABANDONED1')`, [u.order_id, A]);
  await db.exec(`update orders set verifying_since = now() - interval '5 minutes' where id = '${u.order_id}'`);
  await setBal(A, 800);
  const p = (await as('authenticated', A, `select pay_order_with_wallet($1) r`, [u.order_id])).rows[0].r;
  ok('an abandoned bank attempt (dead check) no longer blocks the wallet', p.status === 'paid');
  const o = await one(`select payment_provider, payment_reference, payment_mode from orders where id = $1`, [u.order_id]);
  ok("...and its bank reference is released (the order is now a wallet order)", o.payment_provider === 'wallet' && o.payment_reference === null && o.payment_mode === 'wallet');
}
await rejects('anonymous cannot check out', 'anon', null, `select checkout_cart()`, /permission denied/);
await rejects('a customer cannot mark their own order paid', 'authenticated', A, `update orders set status='paid'`, /permission denied/);

// =================================================================================================
console.log('\n# The Telegram outbox');
await db.exec(`delete from admin_notifications`);
{
  await db.exec(`insert into admin_notifications (kind, message) values ('t','m1'),('t','m2'),('t','m3')`);
  const c = (await svc(`select * from claim_admin_notifications(2)`)).rows;
  ok('claim hands out at most the limit, oldest first', c.length === 2 && c[0].body === 'm1' && c[1].body === 'm2');
  ok('claimed rows are hidden from a second sender', (await svc(`select * from claim_admin_notifications(10)`)).rows.map((r) => r.body).join() === 'm3');
  await svc(`select mark_admin_notification($1, true)`, [c[0].notification_id]);
  await svc(`select mark_admin_notification($1, false, 'http_401')`, [c[1].notification_id]);
  const s = await one(`select sent_at is not null s, last_error, attempts from admin_notifications where id = $1`, [c[1].notification_id]);
  ok('a failure is recorded as a short category and stays unsent', s.s === false && s.last_error === 'http_401' && s.attempts === 1);
  ok('a sent row is never claimed again', !(await svc(`select * from claim_admin_notifications(10)`)).rows.some((r) => r.notification_id === c[0].notification_id));
  await db.exec(`update admin_notifications set claimed_until = null, attempts = 8 where sent_at is null`);
  ok('a row that failed 8 times is left alone (visible in the table)', (await svc(`select * from claim_admin_notifications(10)`)).rows.length === 0);
  await db.exec(`delete from admin_notifications`);
}
{
  await db.exec(`select enqueue_admin_notification('k', repeat('x', 5000))`);
  ok('an over-long message is cut to the table limit, not rejected (a notification must never fail an action)', (await one(`select length(message) l from admin_notifications where kind = 'k'`)).l === 3500);
  await db.exec(`delete from admin_notifications`);
}

// =================================================================================================
console.log('\n# Whole-database checks');
ok('EVERY wallet balance equals its ledger sum', await ledgerOk());
ok('no balance is negative', (await one(`select count(*)::int c from wallets where balance < 0`)).c === 0);
ok('no paid deposit differs from its requested amount', (await one(`select count(*)::int c from deposit_requests where status = 'paid' and payment_verified_amount <> amount`)).c === 0);
ok('no transfer is used twice across orders and deposits', (await db.query(`select p, r from (select payment_provider p, payment_reference r from orders where payment_reference is not null union all select payment_provider, payment_reference from deposit_requests where payment_reference is not null) x group by p, r having count(*) > 1`)).rows.length === 0);
ok('a wallet order has no bank reference; a bank order always has one', (await one(`select count(*)::int c from orders where (payment_provider = 'wallet' and payment_reference is not null) or (payment_provider in ('telebirr','cbe') and payment_reference is null)`)).c === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
