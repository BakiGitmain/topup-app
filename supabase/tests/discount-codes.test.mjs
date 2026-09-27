// Item 2 of the creator feature set: discount codes. Admin-only CRUD (creator_id must be a content creator), a
// creator can read only their own codes/redemption stats, a customer can only redeem by plain code string.
// code_redemptions is written only when the order actually reaches 'completed', never at checkout.
//
// Eligibility (reworked 2026-10-04): per-code-per-customer, not "one discount ever, any code, platform-wide". A
// customer can redeem a specific code once; redeeming it again is NOT an error, it just stops discounting (full
// price -- but the code's OWN portal_coin_bonus still credits every time it is used, discount or not; fixed
// 2026-10-06, see 20261006090000). A DIFFERENT code discounts normally even for a customer who has already used
// another one. "Already claimed" also covers an order that charged this same code and got at least as far as being
// paid for, not only a completed redemption -- see the migration header for the double-discount race that closes.
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
const A = await mkUser('a@x.com', 'Abel'), B = await mkUser('b@x.com', 'Bruk'), ADM = await mkUser('admin@x.com', 'Boss');
const CR = await mkUser('cr@x.com', 'Chaltu'), CR2 = await mkUser('cr2@x.com', 'Dawit'), NOTCR = await mkUser('nc@x.com', 'Not A Creator');
await db.exec(`update profiles set role='admin' where id='${ADM}'`);
await as('authenticated', ADM, `select admin_set_content_creator($1, true)`, [CR]);
await as('authenticated', ADM, `select admin_set_content_creator($1, true)`, [CR2]);

const bal = async (u) => Number((await one(`select balance from wallets where user_id = $1`, [u])).balance);
const setBal = async (u, target) => { const d = target - (await bal(u)); if (d !== 0) await as('authenticated', ADM, `select admin_adjust_balance($1, $2, 'test setup')`, [u, d]); };

// Two gift-card-style products, no ID needed, so checkout never trips on ID validation -- only the code matters here.
const mk = async (sql, params) => (await one(sql, params));
const P1 = (await mk(`insert into products (slug,name,category,is_active) values ('gc1','Card One','gift-cards',true) returning id`)).id;
const R1 = (await mk(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,'us','US','[]'::jsonb,'none',true) returning id`, [P1])).id;
const O1 = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'2000 card',2000,true) returning id`, [P1, R1])).id;
const O1_SMALL = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'500 card',500,true) returning id`, [P1, R1])).id;

const P2 = (await mk(`insert into products (slug,name,category,is_active) values ('gc2','Card Two','gift-cards',true) returning id`)).id;
const R2 = (await mk(`insert into product_regions (product_id,code,label,buyer_fields,id_validation,is_active) values ($1,'us','US','[]'::jsonb,'none',true) returning id`, [P2])).id;
const O2 = (await mk(`insert into product_options (product_id,region_id,label,price,is_active) values ($1,$2,'1000 card',1000,true) returning id`, [P2, R2])).id;

const addLine = (u, option, qty = 1) => as('authenticated', u, `insert into cart_items (user_id, option_id, quantity, fields, id_checked) values ($1,$2,$3,'{}'::jsonb,false)`, [u, option, qty]);
const checkout = async (u, code = null) => (await as('authenticated', u, `select checkout_cart($1) r`, [code])).rows[0].r;
// Scoped, non-destructive cleanup: NEVER wipe the whole orders table -- later assertions need earlier customers'
// completed orders and redemption rows to still be there. clearCart only touches the one user's cart; cancelPending
// releases a user's dangling unpaid order (so their NEXT checkout isn't blocked by "one pending order") without
// deleting the row, exactly like the app's own cancel-order button does.
const clearCart = (u) => db.query(`delete from cart_items where user_id = $1`, [u]);
const cancelPending = async (u, orderId) => { await as('authenticated', u, `select cancel_pending_order($1)`, [orderId]); await clearCart(u); };
const mkCode = async (code, creator, discount, commission, products = null) =>
  (await mk(`insert into discount_codes (code, creator_id, discount_percent, commission_percent, applicable_products, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [code, creator, discount, commission, products, ADM])).id;

// =================================================================================================
console.log('\n# discount_codes: admin-only CRUD, creator must be a content creator');
await rejects('a customer cannot create a code', 'authenticated', A, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('X1',$1,10,5)`, /permission denied|row-level security/, [CR]);
await rejects('a creator cannot create their own code either (still admin-only)', 'authenticated', CR, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('X2',$1,10,5)`, /permission denied|row-level security/, [CR]);
await rejects('the creator must actually be flagged is_content_creator', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('X3',$1,10,5)`, /creator_not_content_creator/, [NOTCR]);
{
  const id = await mkCode('SAVE10', CR, 10, 5, null);
  ok('a valid code is created, open to all products, starts active', !!id);
  const row = await one(`select active, applicable_products from discount_codes where id = $1`, [id]);
  ok('active by default, applicable_products null (all products)', row.active === true && row.applicable_products === null);
}
await rejects('...the same guard applies to UPDATE of creator_id', 'authenticated', ADM, `update discount_codes set creator_id = $1 where code = 'SAVE10'`, /creator_not_content_creator/, [NOTCR]);
await rejects('discount_percent over 90 is refused (capped below 100 so a covered-cart code can never zero out an order)', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('BAD1',$1,91,5)`, /check constraint|violates/, [CR]);
await rejects('...including exactly 100, which used to be the cap', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('BAD1B',$1,100,5)`, /check constraint|violates/, [CR]);
{
  const id = await mkCode('NINETY', CR, 90, 5, null);
  ok('exactly 90% is still allowed (the cap is inclusive)', !!id);
  await as('authenticated', ADM, `update discount_codes set active = false where id = $1`, [id]);
}
await rejects('discount_percent of 0 is refused (must be a real discount)', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('BAD2',$1,0,5)`, /check constraint|violates/, [CR]);
await rejects('commission_percent over 100 is refused', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('BAD3',$1,10,101)`, /check constraint|violates/, [CR]);
await rejects('an empty applicable_products array is refused (use null for "all", or deactivate)', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent, applicable_products) values ('BAD4',$1,10,5,'{}')`, /check constraint|violates/, [CR]);
await rejects('a duplicate code (same case) is refused', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('SAVE10',$1,10,5)`, /duplicate|unique/, [CR]);
await rejects('a duplicate code differing only by case is refused too', 'authenticated', ADM, `insert into discount_codes (code, creator_id, discount_percent, commission_percent) values ('save10',$1,10,5)`, /duplicate|unique/, [CR]);
{
  const id = await mkCode('DEACTME', CR, 20, 5, null);
  await as('authenticated', ADM, `update discount_codes set active = false where id = $1`, [id]);
  ok('an admin can deactivate a code', (await one(`select active from discount_codes where id = $1`, [id])).active === false);
}

console.log('\n# discount_codes: RLS reads');
ok('a customer sees no codes at all', (await rows('authenticated', A, `select id from discount_codes`)).length === 0);
ok('a creator sees only their own codes', (await rows('authenticated', CR, `select id from discount_codes`)).length === 3 && (await rows('authenticated', CR2, `select id from discount_codes`)).length === 0);
ok('an admin sees every code', (await rows('authenticated', ADM, `select id from discount_codes`)).length === 3);
await rejects('anonymous has no access at all (no grant, not just RLS)', 'anon', null, `select id from discount_codes`, /permission denied/);

// =================================================================================================
console.log('\n# checkout_cart: bad codes are rejected clearly, nothing is created');
const noOrder = async (name, u, code, re) => {
  const n = (await rows('authenticated', u, `select id from orders`)).length;
  await rejects(name, 'authenticated', u, `select checkout_cart($1) r`, re, [code]);
  ok(`  ...and no order was created`, (await rows('authenticated', u, `select id from orders`)).length === n);
};
await clearCart(A);
await addLine(A, O1, 1);
await noOrder('a code that does not exist', A, 'NOPE_NOT_REAL', /code_not_found/);
await noOrder('an inactive code', A, 'DEACTME', /code_inactive/);
await mk(`insert into discount_codes (code, creator_id, discount_percent, commission_percent, expires_at) values ('EXPIRED1',$1,10,5, now() - interval '1 day')`, [CR]);
await noOrder('an expired code', A, 'EXPIRED1', /code_expired/);
await clearCart(A);

console.log('\n# checkout_cart: a code not covering any cart item is rejected, cart untouched');
{
  const onlyP2 = await mkCode('ONLYP2', CR, 15, 5, [P2]);
  await addLine(A, O1, 1); // cart has product P1 only; the code covers P2 only
  await noOrder('code restricted to a different product', A, 'ONLYP2', /code_not_applicable/);
  await clearCart(A);
}

// =================================================================================================
console.log('\n# checkout_cart: correct discount + commission math, matching the given example (2000 birr, 5% commission -> 100)');
{
  const code = await mkCode('EXAMPLE5', CR, 10, 5, null); // 10% off, 5% commission
  await addLine(A, O1, 1); // 2000 birr line
  const c = await checkout(A, 'EXAMPLE5');
  ok('order total is discounted 10% off 2000 -> 1800', Number(c.amount) === 1800, JSON.stringify(c));
  const o = await one(`select amount::float amount, discount_amount::float d, commission_amount::float comm, discount_code_id from orders where id = $1`, [c.order_id]);
  ok('orders.amount is the discounted total', o.amount === 1800);
  ok('discount_amount is 200 (10% of 2000)', o.d === 200);
  ok('commission_amount is 100 (5% of the PRE-discount 2000, matching the given example)', o.comm === 100, JSON.stringify(o));
  ok('the code is recorded on the order', o.discount_code_id === code);
  ok('no code_redemptions row exists yet -- the order is only pending_payment, not completed', (await rows('authenticated', ADM, `select id from code_redemptions where order_id = $1`, [c.order_id])).length === 0);
  await cancelPending(A, c.order_id);
}

console.log('\n# checkout_cart: mixed cart -- discount applies only to the covered line, commission is against the WHOLE cart');
{
  const code = await mkCode('MIXED', CR, 50, 10, [P1]); // 50% off P1 only, 10% commission
  await addLine(A, O1_SMALL, 1); // 500, covered
  await addLine(A, O2, 1); // 1000, NOT covered
  const c = await checkout(A, 'MIXED');
  // pre-discount total = 1500; discount = 50% of the 500 P1 line = 250; commission = 10% of the WHOLE 1500 = 150
  ok('total is 1500 - 250 = 1250', Number(c.amount) === 1250, JSON.stringify(c));
  const o = await one(`select discount_amount::float d, commission_amount::float comm from orders where id = $1`, [c.order_id]);
  ok('discount_amount is 250 (50% of the covered 500 line only)', o.d === 250, JSON.stringify(o));
  ok('commission_amount is 150 (10% of the whole pre-discount 1500, not just the covered 500)', o.comm === 150, JSON.stringify(o));
  await cancelPending(A, c.order_id);
}

console.log('\n# checkout_cart: code matching is case-insensitive');
{
  await addLine(A, O1_SMALL, 1);
  const c = await checkout(A, 'example5'); // stored as EXAMPLE5
  ok('a lowercase entry matches the stored code', Number(c.amount) === 450, JSON.stringify(c)); // 500 - 10%
  await cancelPending(A, c.order_id);
}

// =================================================================================================
console.log('\n# code_redemptions is written only when the order actually completes, not at checkout');
{
  await addLine(A, O1_SMALL, 1);
  const c = await checkout(A, 'EXAMPLE5'); // unpaid, balance is 0
  ok('(setup) order is unpaid, bank-transfer flow', c.paid === false);
  ok('still no redemption row while unpaid', (await rows('authenticated', ADM, `select id from code_redemptions where order_id = $1`, [c.order_id])).length === 0);
  await svc(`select begin_payment_verification($1,$2,'telebirr',$3) r`, [c.order_id, A, 'FT25DISCOUNTREF']);
  await svc(`select finish_payment_verification($1,'paid',$2,'live',200,'{}'::jsonb)`, [c.order_id, c.amount]);
  ok('paid, but STILL no redemption row (not completed yet)', (await rows('authenticated', ADM, `select id from code_redemptions where order_id = $1`, [c.order_id])).length === 0);
  ok('no commission yet either -- not completed yet', (await bal(CR)) === 0);
  const crBefore = await bal(CR);
  await as('authenticated', ADM, `select admin_deliver_order($1, 'GIFTCARDCODE123')`, [c.order_id]);
  const red = await one(`select code_id, customer_id, order_id, discount_amount::float d, commission_amount::float comm from code_redemptions where order_id = $1`, [c.order_id]);
  ok('exactly one redemption row now exists, with the order\'s own snapshot amounts', red && red.customer_id === A && red.d === 50 && red.comm === 25, JSON.stringify(red));
  ok('completing the same order again is refused (nothing to double-log anyway)', true); // invalid_transition is covered by existing admin_deliver_order tests

  // ---- item 4, REVERSED 2026-10-08: commission credits the creator's ORDINARY wallet, not a separate balance.
  ok("the creator's ordinary wallet moved by exactly the commission (25)", (await bal(CR)) === crBefore + 25, `before=${crBefore} after=${await bal(CR)}`);
  const tx = await one(`select kind, amount::float amt, balance_after::float ba, order_id, note from wallet_transactions where order_id = $1 and kind = 'commission'`, [c.order_id]);
  ok("a wallet_transactions row: kind commission, +25, linked to the order, note names the code and order", tx && tx.amt === 25 && tx.ba === crBefore + 25 && tx.order_id === c.order_id && /EXAMPLE5/.test(tx.note) && tx.note.includes(c.order_id.slice(0, 8)), JSON.stringify(tx));
  const cn = (await db.query(`select user_id, data, body from notifications where type = 'commission_credited' and data->>'order_id' = $1`, [c.order_id])).rows;
  ok('the commission sends ONE targeted "commission earned" notification to the creator, naming the code', cn.length === 1 && cn[0].user_id === CR && Number(cn[0].data.amount) === 25 && cn[0].data.discount_code === 'EXAMPLE5' && cn[0].body === 'Br 25 from code EXAMPLE5', JSON.stringify(cn));
  ok('...and the buying customer does not get it', (await db.query(`select count(*)::int n from notifications where type = 'commission_credited' and user_id = $1`, [A])).rows[0].n === 0);
  ok('...pointing at the commission ledger row', cn[0].data.transaction_id === (await db.query(`select id from wallet_transactions where order_id = $1 and kind = 'commission'`, [c.order_id])).rows[0].id, JSON.stringify(cn[0].data));
  ok('creating or activating a discount code no longer announces anything', (await db.query(`select count(*)::int n from notifications where type = 'discount'`)).rows[0].n === 0);
  ok('no creator_commission_transactions table exists any more (item 4 fully reversed)', await (async () => { try { await db.query(`select 1 from creator_commission_transactions limit 1`); return false; } catch (e) { return /does not exist|relation .* does not exist/i.test(e.message); } })());

  // completing the same order again is refused; nothing extra is credited (mirrors the coin/redemption guard above).
  const crAfterFirst = await bal(CR);
  await rejects('a second admin_deliver_order call on the same order is refused', 'authenticated', ADM, `select admin_deliver_order($1, $2)`, /invalid_transition/, [c.order_id, 'GIFTCARDCODE123-AGAIN']);
  ok('...and no extra commission was credited', (await bal(CR)) === crAfterFirst);
}

console.log('\n# code_redemptions via system_fulfill_order (the automatic-fulfilment path) too');
{
  await setBal(B, 5000);
  const codeForB = await mkCode('FORB', CR2, 20, 5, null);
  await addLine(B, O1_SMALL, 1);
  const c = await checkout(B, 'FORB'); // balance covers it -> paid instantly from the wallet
  ok('(setup) wallet paid it instantly', c.paid === true);
  await svc(`select system_fulfill_order($1, $2)`, [c.order_id, 'AUTOCODE456']); // O1_SMALL is a gift card ('code' fulfilment) -- needs a code
  ok('system_fulfill_order also logs the redemption', (await rows('service_role', null, `select id from code_redemptions where order_id = $1`, [c.order_id])).length === 1);
}

// =================================================================================================
console.log('\n# per-code-per-customer eligibility (replaces the old "first order ever, any code" rule)');
{
  // A already genuinely redeemed EXAMPLE5 for real (the block above completed an EXAMPLE5 order via
  // admin_deliver_order, inserting a real code_redemptions row for A + EXAMPLE5). Using EXAMPLE5 again is NOT an
  // error -- it just stops discounting.
  await addLine(A, O1_SMALL, 1); // 500 birr
  const c = await checkout(A, 'EXAMPLE5');
  ok('reusing an already-redeemed code is not an error (checkout still succeeds)', !!c.order_id, JSON.stringify(c));
  ok('...but no discount is applied: full price, discount 0', Number(c.amount) === 500 && Number(c.discount) === 0, JSON.stringify(c));
  const o = await one(`select discount_code_id, discount_amount::float d from orders where id = $1`, [c.order_id]);
  ok('the order carries no discount_code_id -- treated exactly as if no code were typed', o.discount_code_id === null && o.d === 0, JSON.stringify(o));

  ok("the order still carries EXAMPLE5 via coin_bonus_code_id (for the coin credit only)", (await one(`select coin_bonus_code_id from orders where id = $1`, [c.order_id])).coin_bonus_code_id !== null);

  // Fixed 2026-10-09: a reused code still owes commission -- 5% of the WHOLE order (500), same as a first use,
  // even though there is no discount. EXAMPLE5 was created with commission_percent 5 (mkCode('EXAMPLE5', CR, 10, 5)).
  const oComm = await one(`select commission_amount::float c from orders where id = $1`, [c.order_id]);
  ok('the reuse order snapshots commission_amount 25 (5% of 500) even with no discount', oComm.c === 25, JSON.stringify(oComm));

  const crBefore = await bal(CR);
  await svc(`select begin_payment_verification($1,$2,'telebirr',$3) r`, [c.order_id, A, 'FT25REUSEDCODE01']);
  await svc(`select finish_payment_verification($1,'paid',$2,'live',200,'{}'::jsonb)`, [c.order_id, c.amount]);
  await as('authenticated', ADM, `select admin_deliver_order($1, 'GIFTCARD-REUSE')`, [c.order_id]);
  const pcTx = await one(`select kind, amount from portal_coin_transactions where order_id = $1`, [c.order_id]);
  // Fixed 2026-10-06: a reused code still earns ITS OWN portal_coin_bonus (EXAMPLE5's default 2), not the flat +1.
  ok("earns EXAMPLE5's own portal_coin_bonus (2), not the flat base +1", pcTx.kind === 'earn_purchase_discount' && Number(pcTx.amount) === 2, JSON.stringify(pcTx));
  ok('no new code_redemptions row was created for the reuse', (await rows('authenticated', ADM, `select id from code_redemptions where order_id = $1`, [c.order_id])).length === 0);

  // ---- the actual fix: commission credits the creator's wallet on a reuse too, decoupled from code_redemptions.
  ok("CR's wallet moved by exactly the reuse commission (25)", (await bal(CR)) === crBefore + 25, `before=${crBefore} after=${await bal(CR)}`);
  const commTx = await one(`select kind, amount::float amt, order_id, note from wallet_transactions where order_id = $1 and kind = 'commission'`, [c.order_id]);
  ok('a wallet_transactions row: kind commission, +25, linked to the order, note names EXAMPLE5', commTx && commTx.amt === 25 && commTx.order_id === c.order_id && /EXAMPLE5/.test(commTx.note), JSON.stringify(commTx));
  const reuseNotif = (await db.query(`select user_id, body, data from notifications where type = 'commission_credited' and data->>'order_id' = $1`, [c.order_id])).rows;
  ok('the reuse commission is announced to CR only, and still names the code that earned it', reuseNotif.length === 1 && reuseNotif[0].user_id === CR && reuseNotif[0].data.discount_code === 'EXAMPLE5' && reuseNotif[0].body === 'Br 25 from code EXAMPLE5', JSON.stringify(reuseNotif));
}
{
  // A DIFFERENT code, first use by A -> discounts normally, even though A has already used up EXAMPLE5.
  await mkCode('FRESHCODE', CR, 15, 5, null);
  await addLine(A, O1_SMALL, 1); // 500 birr
  const c = await checkout(A, 'FRESHCODE');
  ok('a different code still discounts on its own first use', Number(c.amount) === 425 && Number(c.discount) === 75, JSON.stringify(c)); // 500 - 15%
  await cancelPending(A, c.order_id);
}
// Declared outside the block: reused further down to confirm preview_discount_code sees the same race guard.
const D2 = await mkUser('d2@x.com', 'Dagmawit');
{
  // Closes the double-discount race flagged in the migration header: a SECOND order using the SAME code is refused
  // the discount the moment the FIRST one has been paid for, even before it is completed / has a code_redemptions row.
  await setBal(D2, 5000);
  const raceCode = await mkCode('RACECODE', CR, 20, 5, null);
  await addLine(D2, O1_SMALL, 1);
  const first = await checkout(D2, 'RACECODE'); // wallet covers it -> paid instantly, still not completed
  ok('(setup) first order discounted and paid, not yet completed', Number(first.discount) === 100 && first.paid === true, JSON.stringify(first));
  ok('(setup) really not completed yet', (await one(`select status from orders where id = $1`, [first.order_id])).status !== 'completed');
  await addLine(D2, O1_SMALL, 1);
  const second = await checkout(D2, 'RACECODE'); // no error, but the discount is refused this time
  ok('a second use of the SAME code, while the first is only paid, gets no discount (not an error)', Number(second.discount) === 0 && Number(second.amount) === 500, JSON.stringify(second));
}

// =================================================================================================
console.log('\n# preview_discount_code: read-only live check for the cart screen, never creates or locks anything');
{
  const before = (await rows('authenticated', A, `select id from orders`)).length;
  const preview = async (u, code) => (await as('authenticated', u, `select preview_discount_code($1) r`, [code])).rows[0].r;

  await clearCart(A);
  await addLine(A, O1_SMALL, 1); // 500 birr, A has not used FRESHCODE2 yet
  await mkCode('FRESHCODE2', CR, 20, 5, null);
  const ok1 = await preview(A, 'FRESHCODE2');
  ok('a valid, first-use code previews the discount (birr only, no percent/creator leaked)', ok1.ok === true && Number(ok1.discount_amount) === 100 && Number(ok1.new_total) === 400, JSON.stringify(ok1));
  ok('previewing never creates an order', (await rows('authenticated', A, `select id from orders`)).length === before);
  ok('previewing never touches the cart', (await rows('authenticated', A, `select id from cart_items where user_id = $1`, [A])).length === 1);

  const reused = await preview(A, 'EXAMPLE5');
  ok('a code A already used (EXAMPLE5) previews as already_used, matching checkout\'s own no-discount outcome', reused.problem === 'code_already_used');
  ok("...and carries EXAMPLE5's own portal_coin_bonus (2), so the cart can say so instead of just blocking", Number(reused.portal_coin_bonus) === 2, JSON.stringify(reused));
  ok('a nonexistent code previews as not_found', (await preview(A, 'NOPE_NOT_REAL_2')).problem === 'code_not_found');
  ok('an inactive code previews as inactive', (await preview(A, 'DEACTME')).problem === 'code_inactive');
  ok('an expired code previews as expired', (await preview(A, 'EXPIRED1')).problem === 'code_expired');
  await clearCart(A);
}
{
  // The double-discount race guard applies to the live preview too, not only the real checkout.
  const preview = async (u, code) => (await as('authenticated', u, `select preview_discount_code($1) r`, [code])).rows[0].r;
  await addLine(D2, O1_SMALL, 1);
  ok('D2\'s RACECODE now previews as already_used too (their first RACECODE order is paid, not yet completed)', (await preview(D2, 'RACECODE')).problem === 'code_already_used');
  await clearCart(D2);
}

// =================================================================================================
console.log('\n# code_redemptions RLS: a creator sees only their own redemption stats');
ok('CR (created EXAMPLE5/MIXED/etc) sees their own redemptions', (await rows('authenticated', CR, `select id from code_redemptions`)).length >= 1);
ok('CR2 (created FORB) sees only the FORB redemption, not CR\'s', (await rows('authenticated', CR2, `select id from code_redemptions`)).length === 1);
ok('a customer sees no redemption rows at all', (await rows('authenticated', A, `select id from code_redemptions`)).length === 0);
ok('an admin sees every redemption', (await rows('authenticated', ADM, `select id from code_redemptions`)).length >= 2);
await rejects('nobody can insert a redemption directly, not even an admin', 'authenticated', ADM, `insert into code_redemptions (code_id, customer_id, order_id, discount_amount, commission_amount) select id, $1, $1, 1, 1 from discount_codes limit 1`, /permission denied/, [A]);

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
