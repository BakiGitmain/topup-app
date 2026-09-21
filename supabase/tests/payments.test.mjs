// Cart, checkout (create_cart_order), cancel, and the payment verification state machine
// (begin/finish_payment_verification), plus row-level security for all of it.
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
const err = async (uid, sql, params) => { try { await as('authenticated', uid, sql, params); return null; } catch (e) { return { message: e.message, detail: e.detail }; } };

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

// ------------------------------------------------------------------ fixtures
const mkUser = async (email) => (await one(`insert into auth.users (email) values ($1) returning id`, [email])).id;
const A = await mkUser('a@x.com'), B = await mkUser('b@x.com'), ADM = await mkUser('admin@x.com');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);

const FIELD = JSON.stringify([{ key: 'player_id', label: 'Player ID', type: 'text' }]);
const mkProduct = async (slug, name, category = 'games') => (await one(`insert into products (slug,name,category,is_active) values ($1,$2,$3,true) returning id`, [slug, name, category])).id;
const mkRegion = async (product, code, fields, mode) => (await one(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,$2,$2,$3::jsonb,$4,true) returning id`, [product, code, fields, mode])).id;
const mkPack = async (product, region, label, price, extra = '') => (await one(`insert into product_options (product_id,region_id,label,price,is_active ${extra ? ', ' + extra.split('|')[0] : ''}) values ($1,$2,$3,$4,true ${extra ? ', ' + extra.split('|')[1] : ''}) returning id`, [product, region, label, price])).id;

const P1 = await mkProduct('ff', 'Free Fire'); const R1 = await mkRegion(P1, 'mena', FIELD, 'supplier');
const O1 = await mkPack(P1, R1, '110 Diamonds', 100); const O2 = await mkPack(P1, R1, '231 Diamonds', 250);
const P2 = await mkProduct('pubg', 'PUBG Mobile'); const R2 = await mkRegion(P2, 'global', FIELD, 'supplier');
const O3 = await mkPack(P2, R2, '60 UC', 90, `region_locked, account_region_codes|true, array['ME']`);
const P3 = await mkProduct('steam', 'Steam Card', 'gift-cards'); const R3 = await mkRegion(P3, 'us', '[]', 'none');
const O4 = await mkPack(P3, R3, 'Br 500 card', 500);
const P4 = await mkProduct('blood', 'Blood Strike'); const R4 = await mkRegion(P4, 'mena', FIELD, 'none');
const O5 = await mkPack(P4, R4, '100 Gold', 40);
await db.exec(`insert into payment_accounts (provider, account_name, account_number) values ('telebirr','Eyosiyas Daniel Debebe','0911000000'), ('cbe','Eyosiyas Daniel Debebe','1000123456789')`);

const validate = (user, region, id, { region_code = 'ME', name = 'Player', minutes = 15 } = {}) =>
  db.query(`insert into id_validations (user_id, region_id, fields, account_region, player_name, created_at, expires_at) values ($1,$2,$3::jsonb,$4,$5, now() + ($6 || ' minutes')::interval - interval '30 minutes', now() + ($6 || ' minutes')::interval)`, [user, region, JSON.stringify({ player_id: id }), region_code, name, String(minutes)]);
const addLine = (user, option, fields, qty = 1, tick = false) => as('authenticated', user, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,$3,$4::jsonb,$5) returning id`, [user, option, qty, JSON.stringify(fields), tick]);
const reset = () => db.exec(`delete from cart_items; delete from order_items; delete from payment_attempts; delete from orders; delete from id_validations; update products set is_active = true; update product_options set is_active = true, price = case label when '110 Diamonds' then 100 when '231 Diamonds' then 250 when '60 UC' then 90 when 'Br 500 card' then 500 else 40 end; update product_regions set is_active = true;`);
const checkout = (user) => as('authenticated', user, `select public.create_cart_order() as r`);
const failuresOf = (e) => (e?.detail ? JSON.parse(e.detail) : []);
const counts = () => one(`select (select count(*)::int from orders) o, (select count(*)::int from order_items) i, (select count(*)::int from cart_items) c`);

// a standard 3-line cart for A: 2 x Free Fire (ID 111), PUBG (ID 222, ME), a gift card (no ID)
async function standardCart() {
  await validate(A, R1, '111', { name: 'Ali FF' });
  await validate(A, R2, '222', { region_code: 'ME', name: 'Bek PUBG' });
  await addLine(A, O1, { player_id: '111' }, 2);
  await addLine(A, O3, { player_id: '222' }, 1);
  await addLine(A, O4, {}, 1);
}

// =================================================================================================
console.log('\n# RLS: carts');
await standardCart();
ok('a customer reads their own cart', (await rows('authenticated', A, `select id from cart_items`)).length === 3);
ok("another customer sees NONE of it", (await rows('authenticated', B, `select id from cart_items`)).length === 0);
ok("...even when asking for A's rows by user_id", (await rows('authenticated', B, `select id from cart_items where user_id=$1`, [A])).length === 0);
await rejects("a customer cannot put a line in someone else's cart", 'authenticated', B, `insert into cart_items (user_id, option_id) values ($1,$2)`, /row-level security/, [A, O1]);
ok("a customer cannot change someone else's cart (no rows affected)", (await as('authenticated', B, `update cart_items set quantity = 20 returning id`)).rows.length === 0);
ok("a customer cannot delete someone else's cart (no rows affected)", (await as('authenticated', B, `delete from cart_items returning id`)).rows.length === 0);
ok("...and A's cart is untouched", (await one(`select count(*)::int c, max(quantity)::int q from cart_items where user_id=$1`, [A])).c === 3);
await rejects('anonymous cannot read a cart', 'anon', null, `select * from cart_items`, /permission denied/);
await rejects('a line cannot be given a quantity above 20', 'authenticated', A, `update cart_items set quantity = 21`, /cart_items_quantity_check/);
await rejects('the same pack for the same ID is ONE line (no duplicate)', 'authenticated', A, `insert into cart_items (user_id, option_id, fields) values ($1,$2,'{"player_id":"111"}')`, /cart_items_line_unique|duplicate/, [A, O1]);
ok('the same pack for a DIFFERENT ID is a separate line (two accounts)', (await addLine(A, O1, { player_id: '999' })).rows.length === 1);
await as('authenticated', A, `delete from cart_items where fields->>'player_id' = '999'`);

// =================================================================================================
console.log('\n# checkout: a good cart becomes ONE pending_payment order');
const made = (await checkout(A)).rows[0].r;
ok('returns the new order id, the total and the item count', typeof made.order_id === 'string' && Number(made.amount) === 790 && made.items === 3, JSON.stringify(made));
const order = await one(`select * from orders where id=$1`, [made.order_id]);
ok("the order's id is its primary key, status pending_payment, total 790", order.id === made.order_id && order.status === 'pending_payment' && Number(order.amount) === 790 && order.user_id === A);
ok('a cart order is labelled as such (4 items)', order.product_name === 'Cart order' && order.option_label === '4 items');
const items = (await rows('authenticated', A, `select * from order_items where order_id=$1 order by unit_price`, [made.order_id]));
ok('every line is snapshotted with its price and quantity', items.length === 3 && items.map((i) => `${i.option_label}:${Number(i.unit_price)}x${i.quantity}=${Number(i.line_total)}`).join() === '60 UC:90x1=90,110 Diamonds:100x2=200,Br 500 card:500x1=500', items.map((i) => i.option_label).join());
const ff = items.find((i) => i.option_label === '110 Diamonds'), pubg = items.find((i) => i.option_label === '60 UC');
ok("each line keeps ITS OWN player ID (Free Fire 111 and PUBG 222 are different accounts)", ff.delivery.fields.player_id === '111' && ff.delivery.account_id === '111' && pubg.delivery.fields.player_id === '222' && pubg.delivery.account_id === '222');
ok("each line keeps its own ID-check result", ff.validated_player_name === 'Ali FF' && pubg.validated_player_name === 'Bek PUBG' && pubg.validated_account_region === 'ME' && ff.validation_id && pubg.validation_id);
ok('the gift card line needs and stores no player ID', items.find((i) => i.option_label === 'Br 500 card').delivery.account_id === undefined);
ok('the cart is emptied by the same step', (await one(`select count(*)::int c from cart_items where user_id=$1`, [A])).c === 0);
await db.exec(`update product_options set price = 999 where id='${O1}'`);
ok('a price change AFTER the order does not touch what the order charged', Number((await one(`select unit_price from order_items where id=$1`, [ff.id])).unit_price) === 100 && Number((await one(`select amount from orders where id=$1`, [made.order_id])).amount) === 790);
ok('the order total equals the sum of its lines', Number(order.amount) === items.reduce((s, i) => s + Number(i.line_total), 0));

console.log('\n# checkout: never a duplicate order');
await addLine(A, O2, { player_id: '333' }); await validate(A, R1, '333');
const dup = await err(A, `select public.create_cart_order()`);
ok('a second checkout while one is unpaid is refused, naming the order to resume', /pending_order_exists/.test(dup.message) && dup.detail === made.order_id, JSON.stringify(dup));
ok('...and exactly one order exists', (await counts()).o === 1);
ok("...and the new cart line was NOT consumed", (await counts()).c === 1);
await rejects('the database itself allows only one pending_payment order per customer', 'postgres', null, `insert into orders (user_id, product_name, option_label, amount, status) values ($1,'x','y',10,'pending_payment')`, /orders_one_pending_payment_per_user|duplicate/, [A]).catch(() => {});

console.log('\n# RLS: orders and order items');
ok('a customer reads their own order', (await rows('authenticated', A, `select id from orders where id=$1`, [made.order_id])).length === 1);
ok("another customer CANNOT read it", (await rows('authenticated', B, `select id from orders where id=$1`, [made.order_id])).length === 0);
ok("another customer CANNOT read its items", (await rows('authenticated', B, `select id from order_items where order_id=$1`, [made.order_id])).length === 0);
ok('an admin can read it', (await rows('authenticated', ADM, `select id from orders where id=$1`, [made.order_id])).length === 1);
await rejects('a customer cannot create an order directly (no write grant)', 'authenticated', A, `insert into orders (user_id, product_name, option_label, amount, status) values ($1,'x','y',1,'paid')`, /permission denied/, [A]);
await rejects('a customer cannot mark their own order paid', 'authenticated', A, `update orders set status='paid' where id=$1`, /permission denied/, [made.order_id]);
await rejects('a customer cannot write order items', 'authenticated', A, `insert into order_items (order_id, user_id, product_name, option_label, unit_price, quantity, line_total) values ($1,$2,'x','y',1,1,1)`, /permission denied/, [made.order_id, A]);
ok('a customer cannot read payment attempts (no rows)', (await rows('authenticated', A, `select * from payment_attempts`)).length === 0);
await rejects('a customer cannot call begin_payment_verification directly', 'authenticated', A, `select public.begin_payment_verification($1,$2,'cbe','FT123456')`, /permission denied/, [made.order_id, A]);
await rejects('a customer cannot call finish_payment_verification directly', 'authenticated', A, `select public.finish_payment_verification($1,'paid',790,'live',200,'{}')`, /permission denied/, [made.order_id]);
await rejects('anonymous cannot read orders', 'anon', null, `select * from orders`, /permission denied/);

console.log('\n# RLS: payment accounts');
ok('a customer reads the receiving accounts', (await rows('authenticated', A, `select provider from payment_accounts order by provider`)).map((r) => r.provider).join() === 'cbe,telebirr');
ok('a customer cannot change an account number (no rows affected)', (await as('authenticated', A, `update payment_accounts set account_number = '0000000000' returning provider`)).rows.length === 0);
ok('a customer cannot delete an account (no rows affected)', (await as('authenticated', A, `delete from payment_accounts returning provider`)).rows.length === 0);
ok('...and the numbers are unchanged', (await one(`select account_number from payment_accounts where provider='cbe'`)).account_number === '1000123456789');
ok('an admin can change them', (await as('authenticated', ADM, `update payment_accounts set account_number = '1000123456789' where provider='cbe' returning provider`)).rows.length === 1);
await db.exec(`update payment_accounts set is_active = false where provider = 'telebirr'`);
ok('an account that is switched off is hidden from customers', (await rows('authenticated', A, `select provider from payment_accounts`)).map((r) => r.provider).join() === 'cbe');
await db.exec(`update payment_accounts set is_active = true where provider = 'telebirr'`);

// =================================================================================================
console.log('\n# checkout: all or nothing (availability)');
await reset();
await standardCart();
await db.exec(`update products set is_active = false where id='${P2}'`);   // PUBG switched off
await db.exec(`update product_options set is_active = false where id='${O4}'`); // the gift card pack switched off
const e1 = await err(A, `select public.create_cart_order()`);
const f1 = failuresOf(e1);
ok('one or more unavailable lines refuse the WHOLE checkout', /cart_unavailable/.test(e1.message));
ok('the error names exactly the lines that are gone, and why', f1.length === 2 && f1.some((f) => f.label === '60 UC' && f.problem === 'product_off') && f1.some((f) => f.label === 'Br 500 card' && f.problem === 'pack_off'), e1.detail);
ok('...and no order was created, the cart is intact', JSON.stringify(await counts()) === JSON.stringify({ o: 0, i: 0, c: 3 }));
await db.exec(`update products set is_active = true where id='${P2}'; update product_options set is_active = true where id='${O4}'; update product_regions set is_active = false where id='${R1}'`);
const e2 = await err(A, `select public.create_cart_order()`);
ok('a region switched off is reported for the lines in it', failuresOf(e2).length === 1 && failuresOf(e2)[0].problem === 'region_off' && failuresOf(e2)[0].label === '110 Diamonds');
// let the app drop the failing line and retry with the rest
await db.exec(`update product_regions set is_active = true where id='${R1}'`);
await as('authenticated', A, `delete from cart_items where option_id=$1`, [O1]);
const retry = await checkout(A);
ok('after the app drops the unavailable items, the rest checks out', Number(retry.rows[0].r.amount) === 590 && retry.rows[0].r.items === 2);

console.log('\n# checkout: each line needs its own valid player ID');
await reset();
await addLine(A, O1, { player_id: '111' });
let e = await err(A, `select public.create_cart_order()`);
ok('an ID that was never checked blocks checkout, naming the item', failuresOf(e)[0]?.problem === 'id_not_validated' && failuresOf(e)[0].label === '110 Diamonds', e?.detail);
await validate(A, R1, '111', { minutes: -1 });
e = await err(A, `select public.create_cart_order()`);
ok('an EXPIRED check blocks checkout', failuresOf(e)[0]?.problem === 'id_validation_expired', e?.detail);
await reset(); await addLine(A, O1, { player_id: '111' }); await validate(A, R1, '999');
e = await err(A, `select public.create_cart_order()`);
ok("a check for a DIFFERENT ID does not count for this line", failuresOf(e)[0]?.problem === 'id_not_validated');
await reset(); await addLine(A, O1, { player_id: '111' }); await validate(B, R1, '111');
e = await err(A, `select public.create_cart_order()`);
ok("another customer's check does not count", failuresOf(e)[0]?.problem === 'id_not_validated');
await reset(); await addLine(A, O1, { wrong_key: '1' });
e = await err(A, `select public.create_cart_order()`);
ok('fields the region does not declare are refused', failuresOf(e)[0]?.problem === 'id_fields_invalid');
await reset(); await addLine(A, O3, { player_id: '222' }); await validate(A, R2, '222', { region_code: 'BR' });
e = await err(A, `select public.create_cart_order()`);
ok("a region-locked pack refuses an account from another region", failuresOf(e)[0]?.problem === 'region_mismatch');
await reset(); await addLine(A, O5, { player_id: '55' }, 1, false);
e = await err(A, `select public.create_cart_order()`);
ok('a game the supplier cannot check needs the "I checked my ID" tick', failuresOf(e)[0]?.problem === 'id_check_required');
await reset(); await addLine(A, O5, { player_id: '55' }, 1, true);
const ticked = (await checkout(A)).rows[0].r;
ok('...and goes through once ticked, recording when', !!(await one(`select id_self_declared_at from order_items where order_id=$1`, [ticked.order_id])).id_self_declared_at);
await reset(); await validate(A, R1, '111'); await addLine(A, O1, { player_id: '111' }); await addLine(A, O5, { player_id: '55' }, 1, false);
e = await err(A, `select public.create_cart_order()`);
ok('with two bad-or-good lines only the bad one is named', failuresOf(e).length === 1 && failuresOf(e)[0].label === '100 Gold');
await reset();
e = await err(A, `select public.create_cart_order()`);
ok('an empty cart is refused', /cart_empty/.test(e.message));
await rejects('checkout needs a signed-in user', 'authenticated', null, `select public.create_cart_order()`, /not_authenticated/);
ok("checkout only ever uses the caller's own cart", await (async () => { await reset(); await validate(B, R1, '77'); await addLine(B, O1, { player_id: '77' }); const r = await err(A, `select public.create_cart_order()`); return /cart_empty/.test(r.message) && (await counts()).c === 1; })());

// =================================================================================================
console.log('\n# cancelling an unpaid order');
await reset(); await validate(A, R1, '111'); await addLine(A, O1, { player_id: '111' }, 2);
const c1 = (await checkout(A)).rows[0].r;
await rejects("another customer cannot cancel it", 'authenticated', B, `select public.cancel_pending_order($1)`, /order_not_found/, [c1.order_id]);
await as('authenticated', A, `select public.cancel_pending_order($1)`, [c1.order_id]);
ok('the order is closed as cancelled', (await one(`select status from orders where id=$1`, [c1.order_id])).status === 'cancelled');
const back = await rows('authenticated', A, `select quantity, fields from cart_items`);
ok('its lines are back in the cart with their ID and quantity', back.length === 1 && back[0].quantity === 2 && back[0].fields.player_id === '111');
await validate(A, R1, '111');
ok('and a new checkout works again', Number((await checkout(A)).rows[0].r.amount) === 200);
const c2 = (await one(`select id from orders where status='pending_payment'`)).id;
await db.exec(`update orders set verifying_since = now() where id='${c2}'`);
await rejects('an order being verified right now cannot be cancelled', 'authenticated', A, `select public.cancel_pending_order($1)`, /order_not_cancellable/, [c2]);
await db.exec(`update orders set verifying_since = null, status='paid', payment_provider='cbe', payment_reference='FT000001', paid_at=now(), payment_verified_amount=200, payment_mode='live' where id='${c2}'`);
await rejects('a paid order cannot be cancelled', 'authenticated', A, `select public.cancel_pending_order($1)`, /order_not_cancellable/, [c2]);

// =================================================================================================
console.log('\n# database rules on the payment columns');
await reset();
const mkOrder = async (user, amount = 100, status = 'pending_payment') => (await one(`insert into orders (user_id, product_name, option_label, amount, status) values ($1,'T','t',$2,$3) returning id`, [user, amount, status])).id;
const oa = await mkOrder(A, 100);
await rejects('a provider without a reference is refused', 'postgres', null, `update orders set payment_provider='cbe' where id=$1`, /orders_payment_pair_check/, [oa]);
await rejects('an unknown provider is refused', 'postgres', null, `update orders set payment_provider='mpesa', payment_reference='FT123456' where id=$1`, /orders_payment_provider_check/, [oa]);
await rejects('a badly formed reference is refused (lower case)', 'postgres', null, `update orders set payment_provider='cbe', payment_reference='ft123456' where id=$1`, /orders_payment_reference_check/, [oa]);
await rejects("'paid' without a verified amount is refused", 'postgres', null, `update orders set status='paid', paid_at=now(), payment_provider='cbe', payment_reference='FT123456' where id=$1`, /orders_paid_needs_amount_check/, [oa]);
await rejects("'paid' without a paid_at is refused", 'postgres', null, `update orders set status='paid', payment_provider='cbe', payment_reference='FT123456', payment_verified_amount=100, payment_mode='live' where id=$1`, /orders_paid_needs_time_check/, [oa]);
await db.exec(`update orders set payment_provider='cbe', payment_reference='FT123456' where id='${oa}'`);
const ob = await mkOrder(B, 100);
await rejects('THE SAME transfer cannot be attached to a second order (unique constraint)', 'postgres', null, `update orders set payment_provider='cbe', payment_reference='FT123456' where id=$1`, /orders_payment_reference_unique|duplicate/, [ob]);
await db.exec(`update orders set payment_provider='telebirr', payment_reference='FT123456' where id='${ob}'`);
ok('the same text under a DIFFERENT provider is a different transfer', true);
await db.exec(`delete from orders`);
ok('unpaid orders never collide (NULL references are allowed many times)', await (async () => { await db.exec(`insert into orders (user_id, product_name, option_label, amount, status) values ('${A}','a','a',1,'cancelled'),('${A}','a','a',1,'cancelled')`); return true; })());

// =================================================================================================
console.log('\n# payment verification state machine');
await reset(); await db.exec(`delete from orders`);
await validate(A, R1, '111'); await addLine(A, O1, { player_id: '111' }, 1);
const V = (await checkout(A)).rows[0].r;   // 100 Br order
const begin = (order, user, provider, ref) => as('service_role', null, `select public.begin_payment_verification($1,$2,$3,$4) as r`, [order, user, provider, ref]).then((x) => x.rows[0].r);
const finish = (order, outcome, amount, mode = 'live', http = 200, resp = { ok: true }) => as('service_role', null, `select public.finish_payment_verification($1,$2,$3,$4,$5,$6::jsonb) as r`, [order, outcome, amount, mode, http, JSON.stringify(resp)]).then((x) => x.rows[0].r);

ok("someone else's order is 'not_found' (never says it exists)", (await begin(V.order_id, B, 'cbe', 'FT100001')).result === 'not_found');
ok('an unknown order is not_found too', (await begin('00000000-0000-0000-0000-000000000000', A, 'cbe', 'FT100001')).result === 'not_found');
const g1 = await begin(V.order_id, A, 'cbe', 'FT100001');
ok("the owner's first request may go ahead, and learns the amount and the merchant name", g1.result === 'go' && Number(g1.amount) === 100 && g1.account_name === 'Eyosiyas Daniel Debebe', JSON.stringify(g1));
ok('the reference is now claimed by this order', (await one(`select payment_provider p, payment_reference r, verifying_since is not null v, payment_attempts n from orders where id=$1`, [V.order_id])).r === 'FT100001');
ok('DOUBLE-TAP: a second request while the first is running is told "in_progress" (only one can win)', (await begin(V.order_id, A, 'cbe', 'FT100001')).result === 'in_progress');
ok('...even with a different reference typed meanwhile', (await begin(V.order_id, A, 'cbe', 'FT999999')).result === 'in_progress');
ok('...and it does not count as another attempt', (await one(`select payment_attempts n from orders where id=$1`, [V.order_id])).n === 1);

let f = await finish(V.order_id, 'not_verified', null, null, 200, { valid: false, reason: 'not found' });
ok('a payment that is not confirmed is reported, and the order stays awaiting payment', f.result === 'not_verified' && (await one(`select status from orders where id=$1`, [V.order_id])).status === 'pending_payment');
ok('...the reference is FREED so the customer can correct it', (await one(`select payment_reference r, verifying_since v from orders where id=$1`, [V.order_id])).r === null);
ok('...and the raw response was kept for audit', (await one(`select response->>'reason' r from payment_attempts where order_id=$1`, [V.order_id])).r === 'not found');

const g2 = await begin(V.order_id, A, 'telebirr', 'CBT200002');
ok('the customer can retry with a corrected reference (and a different provider)', g2.result === 'go');
await rejects('the database refuses to mark an order paid unless the amount equals the order total exactly', 'service_role', null, `select public.finish_payment_verification($1,'paid',99,'live',200,'{}')`, /paid_amount_must_equal_total/, [V.order_id]);
ok('...so nothing became paid', (await one(`select status from orders where id=$1`, [V.order_id])).status === 'pending_payment');
await rejects('a bad outcome word is refused', 'service_role', null, `select public.finish_payment_verification($1,'yes',100,'live',200,'{}')`, /bad_outcome/, [V.order_id]);

f = await finish(V.order_id, 'paid', 100, 'live', 200, { verified: true, amount: 100 });
ok('a verified payment of exactly the total marks the order paid', f.result === 'paid');
const paid = await one(`select * from orders where id=$1`, [V.order_id]);
ok('...recording when, how much, with what, and the reference', paid.status === 'paid' && paid.paid_at !== null && Number(paid.payment_verified_amount) === 100 && paid.payment_mode === 'live' && paid.payment_provider === 'telebirr' && paid.payment_reference === 'CBT200002' && paid.verifying_since === null);
ok('...and both attempts are in the audit log', (await one(`select count(*)::int n from payment_attempts where order_id=$1`, [V.order_id])).n === 2);

console.log('\n# idempotency: the same order, the same request, again');
const again = await begin(V.order_id, A, 'telebirr', 'CBT200002');
ok('resubmitting for a paid order returns its status and does NOT process again', again.result === 'closed' && again.status === 'paid');
ok('...with a different reference too (an order can only be paid once)', (await begin(V.order_id, A, 'cbe', 'FT555555')).status === 'paid');
ok('...and nothing was claimed or counted', (await one(`select payment_reference r, payment_attempts n from orders where id=$1`, [V.order_id])).r === 'CBT200002' && (await one(`select payment_attempts n from orders where id=$1`, [V.order_id])).n === 2);
f = await finish(V.order_id, 'paid', 100, 'live');
ok('a second "finish" for a paid order is a no-op (never two deliveries)', f.result === 'closed' && f.status === 'paid' && (await one(`select count(*)::int n from payment_attempts where order_id=$1`, [V.order_id])).n === 2);

console.log('\n# a reference cannot pay a second order');
await validate(B, R1, '77'); await addLine(B, O1, { player_id: '77' });
const W = (await as('authenticated', B, `select public.create_cart_order() as r`)).rows[0].r;
ok("a paid order's reference is refused for someone else's order", (await begin(W.order_id, B, 'telebirr', 'CBT200002')).result === 'reference_used');
ok('...and nothing was claimed by the second order', (await one(`select payment_reference r from orders where id=$1`, [W.order_id])).r === null);
ok('the same characters under ANOTHER provider are a different transfer', (await begin(W.order_id, B, 'cbe', 'CBT200002')).result === 'go');
await finish(W.order_id, 'not_verified', null, null, 200, {});

console.log('\n# amount mismatch needs a human');
const gM = await begin(W.order_id, B, 'cbe', 'FT300003');
ok('proceeds to verification', gM.result === 'go');
f = await finish(W.order_id, 'mismatch', 50, 'live', 200, { verified: true, amount: 50 });
const mm = await one(`select * from orders where id=$1`, [W.order_id]);
ok("a payment of the wrong amount becomes 'payment_mismatch', NOT paid", f.result === 'mismatch' && mm.status === 'payment_mismatch' && mm.paid_at === null);
ok('...it records what was actually paid (50) next to the order total (100)', Number(mm.payment_verified_amount) === 50 && Number(mm.amount) === 100);
ok('...and the wrong-amount transfer stays claimed, so it cannot be reused on another order', await (async () => {
  await validate(A, R1, '111'); await addLine(A, O1, { player_id: '111' });
  const X = (await checkout(A)).rows[0].r;
  return (await begin(X.order_id, A, 'cbe', 'FT300003')).result === 'reference_used';
})());
ok('a mismatched order cannot be verified again (closed, status shown)', (await begin(W.order_id, B, 'cbe', 'FT300003')).status === 'payment_mismatch');
ok('a customer cannot cancel a mismatched order (a person must look at it)', await (async () => { try { await as('authenticated', B, `select public.cancel_pending_order($1)`, [W.order_id]); return false; } catch (e) { return /order_not_cancellable/.test(e.message + e.detail); } })());

console.log('\n# a freed reference can be used again; a dead claim does not wedge anything');
const X2 = (await one(`select id from orders where user_id=$1 and status='pending_payment'`, [A])).id;
await begin(X2, A, 'cbe', 'FT400004');
await finish(X2, 'unavailable', null, null, 503, { error_code: 'X' });
ok('an outage ("unavailable") frees the reference and leaves the order awaiting payment', (await one(`select status, payment_reference r from orders where id=$1`, [X2])).r === null && (await one(`select status from orders where id=$1`, [X2])).status === 'pending_payment');
await validate(B, R1, '77'); await addLine(B, O1, { player_id: '77' });
const Y = (await as('authenticated', B, `select public.create_cart_order() as r`)).rows[0].r;
ok('...and another order can now use that reference', (await begin(Y.order_id, B, 'cbe', 'FT400004')).result === 'go');
await db.exec(`update orders set verifying_since = now() - interval '5 minutes' where id='${Y.order_id}'`);   // that check "crashed"
ok('a check that died 5 minutes ago no longer blocks its own order', (await begin(Y.order_id, B, 'cbe', 'FT400004')).result === 'go');
await db.exec(`update orders set verifying_since = now() - interval '5 minutes' where id='${Y.order_id}'`);
ok('...and its dead claim on a reference does not block a different order', (await begin(X2, A, 'cbe', 'FT400004')).result === 'go');
ok('...(the dead claim was taken over)', (await one(`select payment_reference r from orders where id=$1`, [Y.order_id])).r === null);
await finish(X2, 'not_verified', null, null, 200, {});
ok('a check that is only 10 seconds old still protects its reference', await (async () => {
  await begin(Y.order_id, B, 'cbe', 'FT500005');
  return (await begin(X2, A, 'cbe', 'FT500005')).result === 'reference_used';
})());

console.log('\n# the audit log');
ok('every attempt is logged with its outcome, mode and raw response', (await one(`select count(*)::int n, count(*) filter (where response is not null)::int r, count(*) filter (where mode = 'live')::int l from payment_attempts`)).r > 0);
ok('an admin can read the log', (await rows('authenticated', ADM, `select id from payment_attempts`)).length > 0);
ok('a customer sees none of it', (await rows('authenticated', A, `select id from payment_attempts`)).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
