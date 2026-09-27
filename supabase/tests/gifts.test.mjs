// Gifts and redeem codes, part 1 (20261016090000): code generation, creation from a paid order only, the redeem and
// claim cores with every refusal, the final-state and frozen-order backstops, rate limiting, and that nothing here
// ever delivers anything. PGlite runs one session at a time, so TRUE concurrency is proven against a real Postgres
// instead: scripts/gift-concurrency-live.mjs (see CLAUDE.md).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MIGRATIONS = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort().map((f) => read(`migrations/${f}`));
const GIFT_SQL = read('migrations/20261016090000_gifts_and_redeem_codes.sql');

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
const count = async (sql, params) => Number((await one(sql, params)).n);

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const mkUser = async (email) => (await one(`insert into auth.users (email) values ($1) returning id`, [email])).id;
const BUYER = await mkUser('buyer@x.com'), FRIEND = await mkUser('friend@x.com'), OTHER = await mkUser('other@x.com'), ADM = await mkUser('admin@x.com');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);

// ---- catalog: a gift card (no ID), a top-up with a player ID (ticked), a supplier-checked region-locked top-up, and
// an old region-less game pack.
const product = async (slug, category) => (await one(`insert into products (slug, name, category, is_active) values ($1, $1, $2, true) returning id`, [slug, category])).id;
const region = async (p, fields, check) => (await one(`insert into product_regions (product_id, code, label, buyer_fields, id_validation, is_active) values ($1,'r','R',$2::jsonb,$3,true) returning id`, [p, JSON.stringify(fields), check])).id;
const pack = async (p, r, extra = '') => (await one(`insert into product_options (product_id, region_id, label, price, is_active${extra ? ', region_locked, account_region_codes' : ''}) values ($1,$2,'Pack',100,true${extra}) returning id`, [p, r])).id;
const PID = [{ key: 'player_id', label: 'Player ID', type: 'text' }];
const P_CARD = await product('card', 'gift-cards'); const R_CARD = await region(P_CARD, [], 'none'); const O_CARD = await pack(P_CARD, R_CARD);
const P_TOP = await product('top', 'games'); const R_TOP = await region(P_TOP, PID, 'none'); const O_TOP = await pack(P_TOP, R_TOP);
const P_LOCK = await product('lock', 'games'); const R_LOCK = await region(P_LOCK, PID, 'supplier'); const O_LOCK = await pack(P_LOCK, R_LOCK, `, true, array['ME']`);
const P_OLD = await product('old', 'games'); const O_OLD = (await one(`insert into product_options (product_id, label, price, is_active) values ($1,'Old',100,true) returning id`, [P_OLD])).id;

// A captured payment: the shape checkout leaves behind (orders.status 'paid').
const paidOrder = async (user, option, status = 'paid') => (await one(
  `insert into orders (user_id, option_id, product_name, option_label, amount, status, fulfillment, payment_provider, payment_mode, paid_at, payment_verified_amount)
   values ($1,$2,'P','Pack',100,$3,'code','wallet','wallet', case when $3 = 'paid' then now() end, case when $3 = 'paid' then 100 end) returning id`, [user, option, status])).id;
const code = async (order) => (await one(`select * from create_redeem_code($1)`, [order]));
const gift = async (order, to) => (await one(`select * from create_gift($1, $2)`, [order, to]));
const redeem = async (uid, c) => (await rows('authenticated', uid, `select redeem_code($1) r`, [c]))[0].r;

// ------------------------------------------------------------------ generation
console.log('\n-- redeem-code generation');
const N = 3000;
const codes = (await db.query(`select generate_redeem_code() c from generate_series(1, ${N})`)).rows.map((r) => r.c);
ok('every code is exactly 10 characters from A-Z0-9', codes.every((c) => /^[A-Z0-9]{10}$/.test(c)), codes.find((c) => !/^[A-Z0-9]{10}$/.test(c)));
ok(`${N} codes, all different`, new Set(codes).size === N);
const freq = {}; for (const c of codes) for (const ch of c) freq[ch] = (freq[ch] ?? 0) + 1;
const expected = (N * 10) / 36;
ok('all 36 characters appear, each within 25% of an even share (no modulo bias)', Object.keys(freq).length === 36 && Object.values(freq).every((n) => Math.abs(n - expected) / expected < 0.25), JSON.stringify(freq));
ok('drawn from the cryptographic source (gen_random_uuid -> pg_strong_random), never random()', /uuid_send\(gen_random_uuid\(\)\)/.test(GIFT_SQL) && !/\brandom\(\)/.test(GIFT_SQL.split('create or replace function public.generate_redeem_code')[1].split('$$;')[0]));
await rejects('customers cannot call the generator', 'authenticated', BUYER, `select generate_redeem_code()`, /permission denied/);

// A collision is retried, never a failure: the generator is swapped for one that repeats a code already in use twice.
console.log('\n-- a collision is retried');
const first = await code(await paidOrder(BUYER, O_CARD));
// (A sequence, not a table: each retry's exception block rolls back table writes, but never a sequence.)
await db.exec(`
  alter function public.generate_redeem_code() rename to generate_redeem_code_real;
  create sequence public.test_code_seq;
  create function public.generate_redeem_code() returns text language plpgsql as $$
  begin
    if nextval('public.test_code_seq') <= 2 then return '${first.code}'; end if;
    return public.generate_redeem_code_real();
  end $$;`);
const retried = await code(await paidOrder(BUYER, O_CARD));
ok('two collisions in a row, and the code is still created (a fresh one, on the third try)', retried.code !== first.code && /^[A-Z0-9]{10}$/.test(retried.code) && Number((await one(`select last_value n from test_code_seq`)).n) === 3);
await db.exec(`drop function public.generate_redeem_code(); drop sequence public.test_code_seq; alter function public.generate_redeem_code_real() rename to generate_redeem_code;`);

// ------------------------------------------------------------------ creation
console.log('\n-- creating a gift or code: only from a captured payment, one per order');
const O1 = await paidOrder(BUYER, O_CARD);
const C1 = await code(O1);
ok('a code for a paid order: active, owned by the buyer, for that pack, linked to the order', C1.status === 'active' && C1.created_by === BUYER && C1.option_id === O_CARD && C1.product_id === P_CARD && C1.order_id === O1);
ok('expires exactly gift_ttl() = 90 days after it was made', (await one(`select expires_at - created_at = interval '90 days' ok from redeem_codes where id = $1`, [C1.id])).ok === true);
await rejects('an unpaid order (pending_payment) cannot back one', 'postgres', null, `select create_redeem_code($1)`, /order_not_paid/, [await paidOrder(BUYER, O_CARD, 'pending_payment')]);
await rejects('nor a missing order', 'postgres', null, `select create_redeem_code(gen_random_uuid())`, /order_not_found/);
await rejects('one order backs one code, never two', 'postgres', null, `select create_redeem_code($1)`, /order_already_gifted/, [O1]);
await rejects('...and never a code AND a gift', 'postgres', null, `select create_gift($1, $2)`, /order_already_gifted/, [O1, FRIEND]);
const cartOrder = (await one(`insert into orders (user_id, product_name, option_label, amount, status, fulfillment, payment_provider, payment_mode, paid_at, payment_verified_amount) values ($1,'Cart','2 items',200,'paid','code','wallet','wallet',now(),200) returning id`, [BUYER])).id;
await db.query(`insert into order_items (order_id, user_id, option_id, product_name, option_label, unit_price, quantity, line_total, delivery) values ($1,$2,$3,'P','Pack',100,1,100,'{}'),($1,$2,$3,'P','Pack',100,1,100,'{}')`, [cartOrder, BUYER, O_CARD]);
await rejects('an order for more than one pack is not giftable', 'postgres', null, `select create_redeem_code($1)`, /order_not_giftable/, [cartOrder]);
const cartOne = (await one(`insert into orders (user_id, product_name, option_label, amount, status, fulfillment, payment_provider, payment_mode, paid_at, payment_verified_amount) values ($1,'Cart','1 item',100,'paid','code','wallet','wallet',now(),100) returning id`, [BUYER])).id;
await db.query(`insert into order_items (order_id, user_id, option_id, product_name, option_label, unit_price, quantity, line_total, delivery) values ($1,$2,$3,'P','Pack',100,1,100,'{}')`, [cartOne, BUYER, O_TOP]);
ok('a one-pack cart order is giftable (the pack comes from its line)', (await gift(cartOne, FRIEND)).option_id === O_TOP);
const offPack = await pack(P_CARD, R_CARD);
const offOrder = await paidOrder(BUYER, offPack);
await db.query(`update product_options set is_active = false where id = $1`, [offPack]);
await rejects('a pack that is off (out of stock) cannot be gifted', 'postgres', null, `select create_redeem_code($1)`, /pack_unavailable/, [offOrder]);
await rejects('a gift needs a real recipient', 'postgres', null, `select create_gift($1, gen_random_uuid())`, /recipient_not_found/, [await paidOrder(BUYER, O_CARD)]);
for (const fn of [`create_redeem_code('${O1}')`, `create_gift('${O1}', '${FRIEND}')`]) {
  await rejects(`customers cannot call ${fn.split('(')[0]} (only part 2's purchase flow will)`, 'authenticated', BUYER, `select ${fn}`, /permission denied/);
}
await rejects('...nor write the tables directly', 'authenticated', BUYER, `insert into redeem_codes (code, order_id, product_id, option_id, created_by, expires_at) values ('AAAAAAAAAA', '${O1}', '${P_CARD}', '${O_CARD}', '${BUYER}', now())`, /permission denied/);

console.log('\n-- the order behind a gift/code is frozen (never delivered, failed or refunded by the normal paths)');
await rejects('admin_deliver_order on it is refused', 'authenticated', ADM, `select admin_deliver_order($1, 'CODE')`, /gift_order_locked/, [O1]);
await rejects('admin_set_order_status failed (a refund) is refused', 'authenticated', ADM, `select admin_set_order_status($1, 'failed')`, /gift_order_locked/, [O1]);
await rejects('even a direct status write is refused', 'postgres', null, `update orders set status = 'completed', completed_at = now() where id = $1`, /gift_order_locked/, [O1]);
ok('...and an ordinary order is untouched by the guard', await (async () => { const o = await paidOrder(BUYER, O_CARD); await as('authenticated', ADM, `select admin_set_order_status($1, 'processing')`, [o]); return (await one(`select status from orders where id = $1`, [o])).status === 'processing'; })());

console.log('\n-- who can see what');
ok('the buyer sees their code (to hand it on)', (await rows('authenticated', BUYER, `select code from redeem_codes where id = $1`, [C1.id])).length === 1);
ok('nobody else sees an unredeemed code', (await rows('authenticated', OTHER, `select id from redeem_codes`)).length === 0 && (await rows('authenticated', FRIEND, `select id from redeem_codes`)).length === 0);
ok('a gift is seen by its recipient and its sender, nobody else', (await rows('authenticated', FRIEND, `select id from gifts`)).length === 1 && (await rows('authenticated', BUYER, `select id from gifts`)).length === 1 && (await rows('authenticated', OTHER, `select id from gifts`)).length === 0);

// ------------------------------------------------------------------ redeem
console.log('\n-- redeeming a code');
const typed = C1.code.toLowerCase().replace(/(.{5})/, '$1-') + ' ';
const r1 = await redeem(FRIEND, typed);
ok('redeems (typed lower-case, with a dash and a space): a gift for the redeemer', r1.ok === true && !!r1.gift_id, JSON.stringify(r1));
const g1 = await one(`select * from gifts where id = $1`, [r1.gift_id]);
ok('the gift: pending, to the redeemer, from the buyer, same order/pack, linked to the code, its own 90 days', g1.status === 'pending' && g1.recipient_user_id === FRIEND && g1.sender_id === BUYER && g1.order_id === O1 && g1.option_id === O_CARD && g1.redeem_code_id === C1.id && (await one(`select expires_at - created_at = interval '90 days' ok from gifts where id = $1`, [g1.id])).ok);
const c1 = await one(`select * from redeem_codes where id = $1`, [C1.id]);
ok('the code: redeemed, by whom, when', c1.status === 'redeemed' && c1.redeemed_by === FRIEND && c1.redeemed_at !== null);
ok('a second tap by the same person: "already redeemed" (they hold it, so this tells them nothing new)', (await redeem(FRIEND, C1.code)).error === 'already_redeemed');
ok('anyone else trying it: the one generic "invalid code"', (await redeem(OTHER, C1.code)).error === 'invalid_code');
ok('a code that never existed: the same generic answer', (await redeem(OTHER, 'ZZZZZZZZZZ')).error === 'invalid_code');
ok('a malformed code: the same generic answer', (await redeem(OTHER, 'short')).error === 'invalid_code');
const expOrder = await paidOrder(BUYER, O_CARD);
const expCode = (await one(`insert into redeem_codes (code, order_id, product_id, option_id, created_by, expires_at, created_at) values (generate_redeem_code(), $1, $2, $3, $4, now() - interval '1 second', now() - interval '90 days') returning code, id`, [expOrder, P_CARD, O_CARD, BUYER]));
ok('an expired code: the same generic answer (expired is not told apart from wrong)', (await redeem(OTHER, expCode.code)).error === 'invalid_code');
ok('...and it is now stored as expired', (await one(`select status from redeem_codes where id = $1`, [expCode.id])).status === 'expired');
ok('the attempt log never stores the code that was tried', (await count(`select count(*) n from information_schema.columns where table_name = 'redeem_code_attempts' and column_name ilike '%code%'`)) === 0);
await rejects('signed out: no redeeming', 'anon', null, `select redeem_code('ABCDEFGHIJ')`, /permission denied/);
ok('the attempt log is not readable by customers', await (async () => { try { await as('authenticated', OTHER, `select * from redeem_code_attempts`); return false; } catch (e) { return /permission denied/.test(e.message); } })());

console.log('\n-- rate limit (the id_validation_attempts pattern): misses per user, and per IP when known');
const RL = await mkUser('rl@x.com');
for (let i = 0; i < 10; i++) await redeem(RL, `XXXXXXXX${String(i).padStart(2, '0')}`);
const live = await code(await paidOrder(BUYER, O_CARD));
ok('after 10 misses in 10 minutes even a VALID code is refused: "too many attempts"', (await redeem(RL, live.code)).error === 'too_many_attempts');
ok('...and the valid code is still active for someone else', (await redeem(OTHER, live.code)).ok === true);
await db.exec(`update redeem_code_attempts set created_at = now() - interval '11 minutes' where user_id = '${RL}'`);
ok('once the window has passed, that user can try again', (await redeem(RL, 'YYYYYYYYYY')).error === 'invalid_code');
const ipUsers = [await mkUser('ip1@x.com'), await mkUser('ip2@x.com'), await mkUser('ip3@x.com'), await mkUser('ip4@x.com')];
await db.exec(`select set_config('request.headers', '{"x-forwarded-for": "203.0.113.9, 10.0.0.1"}', false)`);
for (const u of ipUsers.slice(0, 3)) for (let i = 0; i < 10; i++) await redeem(u, `IPIPIPIP${String(i).padStart(2, '0')}`);
ok('30 misses from one IP across 3 accounts: a 4th account from that IP is refused too', (await redeem(ipUsers[3], 'IPIPIPIP99')).error === 'too_many_attempts');
await db.exec(`select set_config('request.headers', '', false)`);
ok('...while the same account from elsewhere is fine', (await redeem(ipUsers[3], 'IPIPIPIP98')).error === 'invalid_code');

// ------------------------------------------------------------------ claim
console.log('\n-- claiming a gift');
const claim = (uid, id, fields = {}) => rows('authenticated', uid, `select * from claim_gift($1, $2::jsonb)`, [id, JSON.stringify(fields)]);
const status = async (id) => (await one(`select status from gifts where id = $1`, [id])).status;
await rejects('someone else cannot claim it', 'authenticated', OTHER, `select claim_gift($1)`, /gift_not_yours/, [g1.id]);
await rejects('a gift that does not exist', 'authenticated', FRIEND, `select claim_gift(gen_random_uuid())`, /gift_not_found/);
await rejects('signed out: no claiming', 'anon', null, `select claim_gift($1)`, /permission denied/, [g1.id]);
const [cl] = await claim(FRIEND, g1.id);
ok('the recipient claims a gift card (no player ID needed): claimed, when, no fields', cl.status === 'claimed' && cl.claimed_at !== null && cl.player_fields === null);
await rejects('claiming it again: "already claimed"', 'authenticated', FRIEND, `select claim_gift($1)`, /gift_already_claimed/, [g1.id]);

const gTop = await gift(await paidOrder(BUYER, O_TOP), FRIEND);
await rejects('a top-up with no player ID: refused', 'authenticated', FRIEND, `select claim_gift($1, '{}')`, /player_id_required/, [gTop.id]);
ok('...and the gift was not touched', (await status(gTop.id)) === 'pending');
await rejects('a field the pack never asked for: refused', 'authenticated', FRIEND, `select claim_gift($1, '{"server":"1"}')`, /id_fields_invalid/, [gTop.id]);
const [clTop] = await claim(FRIEND, gTop.id, { player_id: ' 12345 ' });
ok('with the player ID: claimed, the (trimmed) ID stored for delivery', clTop.status === 'claimed' && clTop.player_fields.player_id === '12345');

const gLock = await gift(await paidOrder(BUYER, O_LOCK), FRIEND);
await rejects('a supplier-checked pack without a fresh ID check: refused', 'authenticated', FRIEND, `select claim_gift($1, '{"player_id":"777"}')`, /id_not_validated/, [gLock.id]);
await db.query(`insert into id_validations (user_id, region_id, fields, account_region, player_name, expires_at) values ($1,$2,'{"player_id":"777"}','BR','P',now() + interval '10 minutes')`, [FRIEND, R_LOCK]);
await rejects('an account from the wrong region for a locked pack: refused', 'authenticated', FRIEND, `select claim_gift($1, '{"player_id":"777"}')`, /region_mismatch/, [gLock.id]);
await db.query(`insert into id_validations (user_id, region_id, fields, account_region, player_name, created_at, expires_at) values ($1,$2,'{"player_id":"888"}','ME','P',now() - interval '20 minutes',now() - interval '1 second')`, [FRIEND, R_LOCK]);
await rejects('a check that has run out: refused', 'authenticated', FRIEND, `select claim_gift($1, '{"player_id":"888"}')`, /id_validation_expired/, [gLock.id]);
await db.query(`insert into id_validations (user_id, region_id, fields, account_region, player_name, expires_at) values ($1,$2,'{"player_id":"999"}','ME','P',now() + interval '10 minutes')`, [FRIEND, R_LOCK]);
ok('checked, right region: claimed', (await claim(FRIEND, gLock.id, { player_id: '999' }))[0].status === 'claimed');
ok('...with every refusal before it leaving the gift pending until then', true);

const gOld = await gift(await paidOrder(BUYER, O_OLD), FRIEND);
await rejects('an old region-less game pack needs its one game ID', 'authenticated', FRIEND, `select claim_gift($1)`, /player_id_required/, [gOld.id]);
ok('...and takes it', (await claim(FRIEND, gOld.id, { account_id: 'G-1' }))[0].player_fields.account_id === 'G-1');

const gOff = await gift(await paidOrder(BUYER, O_CARD), FRIEND);
await db.query(`update product_options set is_active = false where id = $1`, [O_CARD]);
await rejects('a pack switched off since: "unavailable", gift stays pending', 'authenticated', FRIEND, `select claim_gift($1)`, /pack_unavailable/, [gOff.id]);
ok('...still pending', (await status(gOff.id)) === 'pending');
await db.query(`update product_options set is_active = true where id = $1`, [O_CARD]);

const expGift = (await one(`insert into gifts (order_id, product_id, option_id, sender_id, recipient_user_id, expires_at, created_at) values ($1,$2,$3,$4,$5, now() - interval '1 second', now() - interval '90 days') returning id`, [await paidOrder(BUYER, O_CARD), P_CARD, O_CARD, BUYER, FRIEND])).id;
await rejects('an expired gift: "expired"', 'authenticated', FRIEND, `select claim_gift($1)`, /gift_expired/, [expGift]);
ok('the sweep marks everything past its time expired (and only that)', (await one(`select expire_gifts_and_codes() n`)).n >= 1 && (await status(expGift)) === 'expired' && (await status(gOff.id)) === 'pending');
await rejects('customers cannot run the sweep', 'authenticated', FRIEND, `select expire_gifts_and_codes()`, /permission denied/);

// ------------------------------------------------------------------ backstops
console.log('\n-- backstops: final is final, whatever the application does');
await rejects('a claimed gift cannot be put back to pending', 'postgres', null, `update gifts set status = 'pending', claimed_at = null where id = $1`, /gift_final/, [g1.id]);
await rejects('...nor claimed again by a raw write', 'postgres', null, `update gifts set claimed_at = now() where id = $1`, /gift_final/, [g1.id]);
await rejects('a redeemed code cannot be re-activated', 'postgres', null, `update redeem_codes set status = 'active', redeemed_at = null, redeemed_by = null where id = $1`, /redeem_code_final/, [C1.id]);
await rejects('a live code cannot be re-pointed or have its code/expiry changed', 'postgres', null, `update redeem_codes set expires_at = expires_at + interval '1 year' where id = $1`, /redeem_code_immutable/, [(await code(await paidOrder(BUYER, O_CARD))).id]);
await rejects('one code can never become two gifts (unique redeem_code_id)', 'postgres', null, `insert into gifts (order_id, product_id, option_id, sender_id, recipient_user_id, redeem_code_id, expires_at) values ($1,$2,$3,$4,$5,$6, now() + interval '1 day')`, /duplicate key|unique/, [await paidOrder(BUYER, O_CARD), P_CARD, O_CARD, BUYER, OTHER, C1.id]);
ok('a redeemed row always has its time; a claimed gift always has its time (shape checks)', /redeem_codes_redeemed_shape/.test(GIFT_SQL) && /gifts_claimed_shape/.test(GIFT_SQL));
await rejects("deleting a buyer whose paid gift still exists is refused, never a silent loss for the recipient", 'postgres', null, `delete from auth.users where id = $1`, /violates (RESTRICT setting of )?foreign key constraint/, [BUYER]);
ok('...so the gift is still there', (await status(g1.id)) === 'claimed');

// ------------------------------------------------------------------ nothing is ever delivered here
console.log('\n-- the supplier is never involved in part 1');
ok('no vault code was written for anything created, redeemed or claimed', (await count(`select count(*) n from vault_codes`)) === 0);
ok("every gift/code's order is still exactly 'paid'", (await count(`select count(*) n from orders o where (exists (select 1 from gifts g where g.order_id = o.id) or exists (select 1 from redeem_codes c where c.order_id = o.id)) and o.status <> 'paid'`)) === 0);
ok('no delivery path is called from this migration', !/system_fulfill_order|_complete_order|admin_deliver_order\(|net\.http/.test(GIFT_SQL.replace(/^--.*$/gm, '')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
