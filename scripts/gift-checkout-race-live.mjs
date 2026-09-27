// Proves the gift / redeem_codes row can never be missing while its order is 'paid', against the linked project:
// the REAL delivery job (the fulfill-order Edge Function, which runs attemptFulfillment) is fired over and over while
// another session marks a gift order paid through the real bank path (finish_payment_verification) and holds that
// transaction open for a few seconds before committing. At no point may delivery complete, and no reader may see the
// order paid without its gift/code.
//
//   node --env-file=.env scripts/gift-checkout-race-live.mjs
//
// Throwaway accounts only (giftpay-*@topup-test.invalid), removed at the end, pass or fail.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON) throw new Error('run with --env-file=.env');
const PASSWORD = 'GiftPay-2026!';
const HOLD_SECONDS = 4;
const PACK = 'f553f779-46ba-4f24-b528-63cf11a17ebc'; // a live Free Fire Garena card

const tmp = (sql) => { const f = path.join(os.tmpdir(), `giftpay-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`); fs.writeFileSync(f, sql); return f; };
function sql(query) {
  const file = tmp(query);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-o', 'json', '-f', `"${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(out.slice(out.indexOf('{'))).rows;
      } catch (e) {
        if (attempt >= 3) throw new Error(String(e.stderr || e.message).slice(0, 600));
      }
    }
  } finally { fs.rmSync(file, { force: true }); }
}
/** Starts a SQL run WITHOUT waiting: resolves when it has finished (its transaction committed). */
function sqlAsync(query) {
  const file = tmp(query);
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['supabase', 'db', 'query', '--linked', '-o', 'json', '-f', `"${file}"`], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      fs.rmSync(file, { force: true });
      if (code === 0) resolve(out);
      else reject(new Error(err.slice(0, 600)));
    });
  });
}
const user = (name) => `
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change,
                          email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'giftpay-${name}@topup-test.invalid',
         extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"GIFTPAY ${name}"}',
         now(), now(), '', '', '', '', '', '', '', ''
  where not exists (select 1 from auth.users where email = 'giftpay-${name}@topup-test.invalid');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), now(), now(), now()
    from auth.users u where u.email = 'giftpay-${name}@topup-test.invalid' and not exists (select 1 from auth.identities i where i.user_id = u.id);`;

async function signIn(email) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed: ${email}`);
  return j.access_token;
}
const rpc = async (token, fn, body) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

let failures = 0;
const check = (name, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); };

async function round(label, token, kind, recipientId, reference) {
  console.log(`\n-- ${label}`);
  const created = await rpc(token, 'checkout_gift', { p_option_id: PACK, p_kind: kind, p_recipient: recipientId });
  const orderId = created.json?.order_id;
  check('the gift order exists unpaid (no wallet money): the bank path is the one with a gap to race', created.status === 200 && created.json?.paid === false && !!orderId, JSON.stringify({ status: created.status, paid: created.json?.paid }));
  const child = kind === 'gift' ? 'gifts' : 'redeem_codes';

  // Session A: the real bank-payment finish, held open before it commits.
  const payment = sqlAsync(`do $$ begin
    perform public.begin_payment_verification('${orderId}', (select user_id from public.orders where id = '${orderId}'), 'telebirr', '${reference}');
    perform public.finish_payment_verification('${orderId}', 'paid', 185, 'test', 200, '{"note":"gift race test"}'::jsonb);
    perform pg_sleep(${HOLD_SECONDS});
  end $$;`);
  let committed = false;
  payment.then(() => { committed = true; }, () => { committed = true; });

  // Session B..: the delivery job and a one-statement reader, over and over, until well after the commit.
  const seen = { pending: 0, paidWithRow: 0, paidWithoutRow: 0, deliveries: {} };
  const stopAt = Date.now() + (HOLD_SECONDS + 12) * 1000;
  let afterCommit = 0;
  while (Date.now() < stopAt && afterCommit < 6) {
    const [delivery, read] = await Promise.all([
      fetch(`${URL_}/functions/v1/fulfill-order`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: orderId }) }).then((r) => r.json()).catch(() => ({ outcome: 'unreachable' })),
      // ONE statement (the order with its row embedded): one snapshot of both.
      fetch(`${URL_}/rest/v1/orders?id=eq.${orderId}&select=status,gift_kind,${child}(id)`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }).then((r) => r.json()),
    ]);
    const key = `${delivery.outcome}${delivery.reason ? `:${delivery.reason}` : ''}`;
    seen.deliveries[key] = (seen.deliveries[key] ?? 0) + 1;
    const o = read[0];
    // order_id is unique on gifts/redeem_codes, so PostgREST embeds the row as ONE object (or null), not an array.
    const embedded = o?.[child];
    const hasRow = Array.isArray(embedded) ? embedded.length > 0 : !!embedded;
    if (o?.status === 'paid' && hasRow) seen.paidWithRow++;
    else if (o?.status === 'paid') seen.paidWithoutRow++;
    else seen.pending++;
    if (committed) afterCommit++;
  }
  await payment;

  console.log('   observations:', JSON.stringify(seen));
  check('the race really overlapped: reads saw the order unpaid while the payment was held, and paid after', seen.pending > 0 && seen.paidWithRow > 0);
  check('NEVER seen paid without its row (the row is created in the same transaction as the flip)', seen.paidWithoutRow === 0);
  check('the delivery job never delivered: only "not paid yet" before the commit, "gift order" after', !Object.keys(seen.deliveries).some((k) => k.startsWith('completed')) && Object.keys(seen.deliveries).every((k) => ['skipped:status_pending_payment', 'skipped:gift_order'].includes(k)), JSON.stringify(seen.deliveries));
  const [after] = sql(`select o.status, (select count(*) from public.${child} where order_id = o.id) as rows, (select count(*) from public.vault_codes where order_id = o.id) as vault from public.orders o where o.id = '${orderId}'`);
  check(`afterwards: paid, exactly one ${kind === 'gift' ? 'gift' : 'redeem code'}, nothing delivered`, after.status === 'paid' && Number(after.rows) === 1 && Number(after.vault) === 0, JSON.stringify(after));
}

const CLEANUP = `
  delete from public.gifts where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'giftpay-%@topup-test.invalid');
  delete from public.redeem_codes where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'giftpay-%@topup-test.invalid');
  delete from auth.users where email like 'giftpay-%@topup-test.invalid';
  select (select count(*) from auth.users where email like 'giftpay-%') as users_left`;

try {
  sql(`${user('buyer')} ${user('friend')} select 1 as ok`);
  const buyer = await signIn('giftpay-buyer@topup-test.invalid');
  const [{ id: friendId }] = sql(`select id from auth.users where email = 'giftpay-friend@topup-test.invalid'`);
  await round('a GIFT paid by bank transfer while the delivery job hammers it', buyer, 'gift', friendId, 'FT25GIFTRACEG01');
  await round('a REDEEM CODE paid by bank transfer while the delivery job hammers it', buyer, 'redeem_code', null, 'FT25GIFTRACEC01');
} finally {
  const [left] = sql(CLEANUP);
  check('cleanup: throwaway accounts and everything they made are gone', Number(left.users_left) === 0);
}
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
