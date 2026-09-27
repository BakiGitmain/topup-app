// The prize wheel: admin-only prize/package CRUD, customers see only their own spin_credits/wheel_prizes_won,
// buy_spin_package/spin_wheel are atomic (portal_coin_apply + wheel_spin_credits_apply, same guarded-ledger reuse
// as redeem_portal_coins), the prize is picked server-side by weight BEFORE anything is returned to the client, a
// spin credit and a won prize are each one-time-use, a wheel discount never brings an order to exactly Br 0, and a
// wheel credit and a discount code cannot both be applied to one order.
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
const mkUser = async (email) => (await one(`insert into auth.users (email) values ($1) returning id`, [email])).id;
const A = await mkUser('a@x.com'), B = await mkUser('b@x.com'), ADM = await mkUser('adm@x.com');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);

const mk = async (sql, params) => (await one(sql, params));
const coinBal = async (u) => Number((await one(`select balance from portal_coin_balances where user_id = $1`, [u])).balance);
const credits = async (u) => Number((await one(`select credits from wheel_spin_credits where user_id = $1`, [u])).credits);
// Test-only shortcut: sets a customer's Portal Coin balance directly (there is no admin_adjust-style RPC for it),
// same idea as other suites' setBal for wallet balance, staying inside the deferred ledger-guard trigger by writing
// a matching ledger row in the same statement batch.
const grantCoins = async (u, amount) => {
  const before = await coinBal(u);
  await db.exec(`
    update portal_coin_balances set balance = balance + ${amount} where user_id = '${u}';
    insert into portal_coin_transactions (user_id, kind, amount, balance_after, note)
      values ('${u}', 'earn_purchase', ${amount}, ${before + amount}, 'test grant');
  `);
};

const mkPrize = async (label, discountBirr, weight) =>
  (await mk(`insert into wheel_prizes (label, discount_birr, weight, created_by) values ($1,$2,$3,$4) returning id`, [label, discountBirr, weight, ADM])).id;
const mkPackage = async (spins, cost) =>
  (await mk(`insert into wheel_spin_packages (spins_count, portal_coin_cost) values ($1,$2) returning id`, [spins, cost])).id;

const P1 = (await mk(`insert into products (slug,name,category,is_active) values ('gc1','Card','gift-cards',true) returning id`)).id;
const R1 = (await mk(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,'us','US','[]'::jsonb,'none',true) returning id`, [P1])).id;
const O_500 = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'500 card',500,true) returning id`, [P1, R1])).id;
const addLine = (u, option, qty = 1) => as('authenticated', u, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,$3,'{}'::jsonb,false)`, [u, option, qty]);
const checkout = async (u, code = null, wheelWonId = null) => (await as('authenticated', u, `select checkout_cart($1,$2) r`, [code, wheelWonId])).rows[0].r;
const clearCart = (u) => db.query(`delete from cart_items where user_id = $1`, [u]);

// =================================================================================================
console.log('\n# wheel_prizes / wheel_spin_packages: admin-only write, everyone signed-in reads active ones');
await rejects('a customer cannot create a prize', 'authenticated', A, `insert into wheel_prizes (label, discount_birr, weight) values ('x',10,1)`, /permission denied|row-level security/);
{
  const id = await mkPrize('Br 10 off', 10, 1);
  ok('an admin can create a prize', !!id);
}
ok('a customer sees active prizes', (await rows('authenticated', A, `select id from wheel_prizes where active`)).length >= 1);
{
  const inactiveId = await mkPrize('Hidden prize', 5, 1);
  await as('authenticated', ADM, `update wheel_prizes set active = false where id = $1`, [inactiveId]);
  ok('a customer does not see an inactive prize', (await rows('authenticated', A, `select id from wheel_prizes where id = $1`, [inactiveId])).length === 0);
  ok('an admin still sees it', (await rows('authenticated', ADM, `select id from wheel_prizes where id = $1`, [inactiveId])).length === 1);
}
await rejects('weight of 0 is refused', 'authenticated', ADM, `insert into wheel_prizes (label, discount_birr, weight) values ('x',10,0)`, /check constraint|violates/);
await rejects('discount_birr of 0 is refused', 'authenticated', ADM, `insert into wheel_prizes (label, discount_birr, weight) values ('x',0,1)`, /check constraint|violates/);

await rejects('a customer cannot create a spin package', 'authenticated', A, `insert into wheel_spin_packages (spins_count, portal_coin_cost) values (1,5)`, /permission denied|row-level security/);
const PKG1 = await mkPackage(1, 5);
ok('a customer sees the active package', (await rows('authenticated', A, `select id from wheel_spin_packages where id = $1`, [PKG1])).length === 1);

// =================================================================================================
console.log('\n# wheel_spin_credits / wheel_prizes_won: customers see only their own');
ok('a customer has a zero starting spin_credits row (created by the profile trigger)', (await credits(A)) === 0);
ok('a customer sees only their own spin_credits row', (await rows('authenticated', A, `select user_id from wheel_spin_credits`)).length === 1);
ok('a customer sees no other customer\'s wheel_prizes_won', (await rows('authenticated', B, `select id from wheel_prizes_won where customer_id = $1`, [A])).length === 0);
await rejects('anonymous has no access to spin_credits', 'anon', null, `select credits from wheel_spin_credits`, /permission denied/);
await rejects('anonymous has no access to wheel_prizes_won', 'anon', null, `select id from wheel_prizes_won`, /permission denied/);

// =================================================================================================
console.log('\n# buy_spin_package: atomic (portal_coin_apply + wheel_spin_credits_apply together)');
await rejects('buying with 0 Portal Coins is refused, nothing changes', 'authenticated', A, `select buy_spin_package($1)`, /insufficient_portal_coins/, [PKG1]);
ok('...spin_credits is still 0', (await credits(A)) === 0);
ok('...no new portal_coin_transactions row from the failed attempt', (await one(`select count(*)::int c from portal_coin_transactions where user_id = $1 and kind = 'spend_wheel_spins'`, [A])).c === 0);

await grantCoins(A, 20);
{
  const before = await coinBal(A);
  const r = (await as('authenticated', A, `select buy_spin_package($1) r`, [PKG1])).rows[0].r;
  ok('buying succeeds: coins burned, spin_credits granted, in one call', r.spins_bought === 1 && r.spin_credits === 1 && Number(r.coin_balance) === before - 5, JSON.stringify(r));
  ok('...matches the real balances', (await credits(A)) === 1 && (await coinBal(A)) === before - 5);
}
await rejects('buying an unknown/inactive package is refused', 'authenticated', A, `select buy_spin_package($1)`, /package_not_found/, ['00000000-0000-0000-0000-000000000000']);

// =================================================================================================
console.log('\n# spin_wheel: a spin credit is one-time-use, the prize is chosen before anything is returned');
{
  const before = await credits(A);
  const r = (await as('authenticated', A, `select spin_wheel() r`)).rows[0].r;
  ok('spin_credits went down by exactly 1', (await credits(A)) === before - 1);
  ok('the response names a real prize with a valid index', typeof r.prize_id === 'string' && typeof r.index === 'number' && r.index >= 0 && r.index < r.total_prizes, JSON.stringify(r));
  ok('a wheel_prizes_won row now exists for this customer, unredeemed', (await one(`select redeemed_at from wheel_prizes_won where id = $1 and customer_id = $2`, [r.won_id, A])).redeemed_at === null);
}
await rejects('spinning again with 0 credits left is refused, nothing changes', 'authenticated', A, `select spin_wheel()`, /insufficient_spin_credits/);
ok('...still 0 credits, not negative', (await credits(A)) === 0);

// =================================================================================================
console.log('\n# weighted selection genuinely respects relative weights (statistical test)');
{
  // A clean, separate pair of prizes for a predictable ratio: weight 1 vs weight 3 -> ~25% / ~75%.
  await db.exec(`update wheel_prizes set active = false`); // isolate: only these two are active for this test
  const low = await mkPrize('Stat low (25%)', 5, 1);
  const high = await mkPrize('Stat high (75%)', 5, 3);
  const N = 1000;
  await db.exec(`update wheel_spin_credits set credits = ${N} where user_id = '${A}'`);
  const counts = { [low]: 0, [high]: 0 };
  for (let i = 0; i < N; i++) {
    const r = (await as('authenticated', A, `select spin_wheel() r`)).rows[0].r;
    counts[r.prize_id] = (counts[r.prize_id] ?? 0) + 1;
  }
  const lowShare = counts[low] / N;
  const highShare = counts[high] / N;
  ok(`low-weight prize lands near 25% over ${N} trials (got ${(lowShare * 100).toFixed(1)}%)`, lowShare > 0.17 && lowShare < 0.33, JSON.stringify(counts));
  ok(`high-weight prize lands near 75% over ${N} trials (got ${(highShare * 100).toFixed(1)}%)`, highShare > 0.67 && highShare < 0.83, JSON.stringify(counts));
  ok('every trial landed on one of the two active prizes, nothing else', counts[low] + counts[high] === N);
  await db.exec(`update wheel_prizes set active = true where id in ('${low}', '${high}')`); // leave them active for later checkout tests
}

// =================================================================================================
console.log('\n# spending a won prize at checkout: caps at Br (total - 1), never exactly Br 0, and is one-time-use');
{
  const bigPrize = await mkPrize('Huge discount', 100000, 1); // deliberately bigger than any cart total
  await db.exec(`update wheel_spin_credits set credits = 1 where user_id = '${B}'`);
  await db.exec(`update wheel_prizes set active = false where id != '${bigPrize}'`); // isolate the spin
  const spin = (await as('authenticated', B, `select spin_wheel() r`)).rows[0].r;
  ok('(setup) B won the huge-discount prize', spin.prize_id === bigPrize);
  await db.exec(`update wheel_prizes set active = true`); // restore for anything after

  await addLine(B, O_500, 1); // 500 birr cart
  const c = await checkout(B, null, spin.won_id);
  ok('discount is capped so the total never hits exactly Br 0', Number(c.amount) === 1 && Number(c.discount) === 499, JSON.stringify(c));

  const o = await one(`select wheel_prize_won_id, discount_amount::float d from orders where id = $1`, [c.order_id]);
  ok('the order carries the wheel_prize_won_id and the capped discount', o.wheel_prize_won_id === spin.won_id && o.d === 499);
  ok('not redeemed yet -- only pending_payment, same discipline as code_redemptions', (await one(`select redeemed_at from wheel_prizes_won where id = $1`, [spin.won_id])).redeemed_at === null);

  await svc(`select begin_payment_verification($1,$2,'telebirr',$3) r`, [c.order_id, B, 'FT25WHEELREF001']);
  await svc(`select finish_payment_verification($1,'paid',$2,'live',200,'{}'::jsonb)`, [c.order_id, c.amount]);
  await as('authenticated', ADM, `select admin_deliver_order($1, 'GIFTCARD-WHEEL-1')`, [c.order_id]);
  const won = await one(`select redeemed_at, applied_order_id from wheel_prizes_won where id = $1`, [spin.won_id]);
  ok('completing the order marks the prize redeemed, linked to the order', won.redeemed_at !== null && won.applied_order_id === c.order_id, JSON.stringify(won));
  const pcTx = await one(`select kind, amount from portal_coin_transactions where order_id = $1`, [c.order_id]);
  ok('a wheel-discounted order earns the flat base +1 Portal Coin (no special wheel bonus)', pcTx.kind === 'earn_purchase' && Number(pcTx.amount) === 1, JSON.stringify(pcTx));

  await clearCart(B);
  await addLine(B, O_500, 1);
  await rejects('the SAME won prize cannot be spent a second time', 'authenticated', B, `select checkout_cart($1,$2) r`, /wheel_prize_unavailable/, [null, spin.won_id]);
  await clearCart(B);
}

// =================================================================================================
console.log('\n# a wheel credit and a discount code never stack on the same order');
{
  await as('authenticated', ADM, `select admin_set_content_creator($1, true)`, [A]);
  await mk(`insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('WHEELSTACK', $1, 10, 5) returning id`, [A]);
  await db.exec(`update wheel_spin_credits set credits = 1 where user_id = '${A}'`);
  const spin = (await as('authenticated', A, `select spin_wheel() r`)).rows[0].r;
  await addLine(A, O_500, 1);
  await rejects('checkout_cart refuses a call carrying both a code and a wheel prize', 'authenticated', A, `select checkout_cart($1,$2) r`, /multiple_discounts_not_allowed/, ['WHEELSTACK', spin.won_id]);
  await clearCart(A);
}

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
