// Proves redeem_code and claim_gift are single-winner under REAL concurrency, against the linked Supabase project.
// (The in-process PGlite DB suites run one session at a time, so they cannot.) Each race fires N simultaneous RPCs
// through PostgREST -- the app's own path -- where every in-flight request runs on its own database connection.
//
//   node --env-file=.env scripts/gift-concurrency-live.mjs
//
// Throwaway accounts only (giftrace-*@topup-test.invalid), all removed at the end, pass or fail. Codes are held in
// memory only and never printed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON) throw new Error('run with --env-file=.env');
const RACERS = 8;
const PASSWORD = 'GiftRace-2026!';

/** Runs SQL on the linked project. Always through a file: a multi-line query does not survive a Windows shell. */
function sql(fileOrQuery, isFile) {
  let file = fileOrQuery;
  if (!isFile) {
    file = path.join(os.tmpdir(), `giftrace-${process.pid}-${Date.now()}.sql`);
    fs.writeFileSync(file, fileOrQuery);
  }
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-o', 'json', '-f', `"${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(out.slice(out.indexOf('{'))).rows;
      } catch (e) {
        if (attempt >= 3) throw new Error(String(e.stderr || e.message).slice(0, 600));
      }
    }
  } finally {
    if (!isFile) fs.rmSync(file, { force: true });
  }
}

async function signIn(email) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}`);
  return j.access_token;
}

/** All calls are built first, then released together; each result keeps its own start/end time. */
async function race(calls) {
  const t0 = performance.now();
  const results = await Promise.all(calls.map(async ({ token, fn, body }) => {
    const start = performance.now() - t0;
    const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, json, start, end: performance.now() - t0 };
  }));
  const overlap = Math.max(...results.map((r) => r.start)) < Math.min(...results.map((r) => r.end));
  return { results, overlap };
}

let failures = 0;
const check = (name, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); };

const CLEANUP = `
  delete from public.gifts where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'giftrace-%@topup-test.invalid');
  delete from public.redeem_codes where order_id in (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email like 'giftrace-%@topup-test.invalid');
  delete from public.admin_notifications where sent_at is null and message like '%giftrace-%@topup-test.invalid%';
  delete from auth.users where email like 'giftrace-%@topup-test.invalid';
  select (select count(*) from auth.users where email like 'giftrace-%') as users_left,
         (select count(*) from public.admin_notifications where message like '%giftrace-%') as outbox_left`;

try {
  console.log('setting up (real deposit + 7 real wallet checkouts)...');
  const [setup] = sql(fileURLToPath(new URL('./gift-concurrency-live.sql', import.meta.url)), true);
  const codes = setup.codes, gifts = setup.gifts;
  check('setup: 5 codes and 2 gifts, all from real paid orders', codes.length === 5 && gifts.length === 2);

  const tokens = [];
  for (let i = 1; i <= RACERS; i++) tokens.push(await signIn(`giftrace-r${i}@topup-test.invalid`));

  console.log(`\n-- ${RACERS} different accounts redeem the SAME code at the same moment (3 rounds)`);
  for (const code of codes.slice(0, 3)) {
    const { results, overlap } = await race(tokens.map((token) => ({ token, fn: 'redeem_code', body: { p_code: code } })));
    const wins = results.filter((r) => r.json?.ok === true).length;
    const losses = results.filter((r) => r.json?.ok === false && r.json.error === 'invalid_code').length;
    check(`exactly one winner, ${RACERS - 1} generic refusals`, wins === 1 && losses === RACERS - 1, `wins=${wins} refusals=${losses} all-in-flight-together=${overlap} spread=${Math.round(Math.max(...results.map((r) => r.start)))}ms`);
  }

  console.log(`\n-- one account double-taps: ${RACERS} simultaneous redeems of the same code (2 rounds)`);
  for (const code of codes.slice(3, 5)) {
    const { results, overlap } = await race(Array.from({ length: RACERS }, () => ({ token: tokens[1], fn: 'redeem_code', body: { p_code: code } })));
    const wins = results.filter((r) => r.json?.ok === true).length;
    const again = results.filter((r) => r.json?.error === 'already_redeemed').length;
    check(`exactly one winner, ${RACERS - 1} "already redeemed"`, wins === 1 && again === RACERS - 1, `wins=${wins} already=${again} all-in-flight-together=${overlap}`);
  }

  console.log(`\n-- the recipient claims the SAME gift ${RACERS} times at once (2 rounds)`);
  for (const id of gifts) {
    const { results, overlap } = await race(Array.from({ length: RACERS }, () => ({ token: tokens[0], fn: 'claim_gift', body: { p_gift_id: id, p_fields: {} } })));
    const wins = results.filter((r) => r.status === 200).length;
    const already = results.filter((r) => r.status >= 400 && /gift_already_claimed/.test(r.json?.message ?? '')).length;
    check(`exactly one claim, ${RACERS - 1} "already claimed"`, wins === 1 && already === RACERS - 1, `claims=${wins} already=${already} all-in-flight-together=${overlap}`);
  }

  console.log('\n-- the database afterwards');
  const [state] = sql(`
    with mine as (select o.id from public.orders o join auth.users u on u.id = o.user_id where u.email = 'giftrace-buyer@topup-test.invalid')
    select (select count(*) from public.redeem_codes where order_id in (select id from mine) and status = 'redeemed' and redeemed_by is not null) as codes_redeemed,
           (select count(*) from public.gifts where order_id in (select id from mine)) as gifts_total,
           (select max(n) from (select count(*) n from public.gifts where redeem_code_id is not null and order_id in (select id from mine) group by redeem_code_id) s) as max_gifts_per_code,
           (select count(*) from public.gifts where order_id in (select id from mine) and status = 'claimed') as gifts_claimed,
           (select count(*) from public.orders where id in (select id from mine) and status <> 'paid') as orders_not_paid,
           (select count(*) from public.vault_codes where order_id in (select id from mine)) as vault_codes`);
  check('all 5 codes redeemed once; 5 gifts from codes + 2 sent = 7 gifts; never 2 gifts from one code', Number(state.codes_redeemed) === 5 && Number(state.gifts_total) === 7 && Number(state.max_gifts_per_code) === 1, JSON.stringify(state));
  check('the 2 raced gifts claimed exactly once each', Number(state.gifts_claimed) === 2);
  check('nothing was delivered: every order still just paid, no vault code', Number(state.orders_not_paid) === 0 && Number(state.vault_codes) === 0);
} finally {
  const [left] = sql(CLEANUP, false);
  check('cleanup: throwaway accounts and everything they made are gone', Number(left.users_left) === 0 && Number(left.outbox_left) === 0);
}
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
