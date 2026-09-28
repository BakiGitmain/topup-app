// Tournaments, part 3 (20261027090000): the room (ID + password, who sees it, who is told) and the end (winners,
// every reward paid out: money to wallets, packs as gifts; unused rewards and 85% of the fees to the host).
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

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

const mkUser = async (email, name) => (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
const HOST = await mkUser('host@x.com', 'Streamer'), ADM = await mkUser('admin@x.com', 'Boss'), FAN = await mkUser('fan@x.com', 'Fan');
const CA = await mkUser('ca@x.com', 'Abel'), A2 = await mkUser('a2@x.com', 'Almaz');
const CB = await mkUser('cb@x.com', 'Bruk'), B2 = await mkUser('b2@x.com', 'Betty');
const CC = await mkUser('cc@x.com', 'Chala'), C2 = await mkUser('c2@x.com', 'Chaltu');
await db.exec(`update profiles set is_content_creator = true where id = '${HOST}'; update profiles set role = 'admin' where id = '${ADM}'`);
const fund = (uid, n) => as('authenticated', ADM, `select admin_adjust_balance($1, $2, 'test funds')`, [uid, n]);
const balance = async (uid) => Number((await one(`select balance from wallets where user_id = $1`, [uid])).balance);

const P = (await one(`insert into products (slug, name, category, is_active) values ('ff','Free Fire','games',true) returning id`)).id;
const R = (await one(`insert into product_regions (product_id, code, label, is_active, id_validation, buyer_fields) values ($1,'mena','MENA',true,'supplier','[{"key":"player_id","label":"Player ID"}]'::jsonb) returning id`, [P])).id;
const PACK = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'100 Diamonds',150,true) returning id`, [P, R])).id;
const PACK2 = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'500 Diamonds',700,true) returning id`, [P, R])).id;

const soon = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
const create = (p) => rows('authenticated', HOST, `select tournament_create($1::jsonb) ->> 'id' id`, [JSON.stringify(p)]).then((r) => r[0].id);
const detail = (uid, id) => rows('authenticated', uid, `select tournament_detail($1) d`, [id]).then((r) => r[0].d);
const inbox = (uid, type) => rows('postgres', null, `select type, title, body, data from notifications where user_id = $1 and type = $2 order by created_at`, [uid, type]);
const checked = async (by, gameId) => (await one(
  `insert into id_validations (user_id, region_id, fields, player_name, expires_at) values ($1, $2, $3::jsonb, 'P' || $4, now() + interval '15 minutes') returning id`,
  [by, R, JSON.stringify({ player_id: gameId }), gameId])).id;
// A registered 2-player team (the captain pays the Br 50 fee from their wallet).
let nextId = 1000000000;
async function team(t, cap, mate, name) {
  const g1 = String(nextId++), g2 = String(nextId++);
  const v1 = await checked(cap, g1), v2 = await checked(cap, g2);
  const id = (await rows('authenticated', cap, `select tournament_team_save($1, $2::jsonb) id`, [t, JSON.stringify({ name, members: [
    { slot: 1, game_id: g1, validation_id: v1 }, { slot: 2, user_id: mate, game_id: g2, validation_id: v2 }] })]))[0].id;
  await fund(cap, 50);
  const r = (await rows('authenticated', cap, `select tournament_team_register($1) r`, [id]))[0].r;
  if (r.status !== 'registered') throw new Error('team did not register: ' + JSON.stringify(r));
  return id;
}
const moveStart = (t, sql) => db.exec(`alter table tournaments disable trigger tournaments_guard; update tournaments set starts_at = ${sql} where id = '${t}'; alter table tournaments enable trigger tournaments_guard;`);
const post = (uid, t, room, pass) => rows('authenticated', uid, `select tournament_post_room($1, $2, $3)`, [t, room, pass]);
const finish = (uid, t, p) => rows('authenticated', uid, `select tournament_finish($1, $2::jsonb) r`, [t, JSON.stringify(p)]).then((r) => r[0].r);

await fund(HOST, 3000);
// Register: 2 players a team, 3 teams, Br 50 a team. Rewards: 1st = Br 200 + a pack (Br 150), 2nd = Br 50 + Br 50,
// 3rd = Br 30 + Br 30. Held at publish: Br 510.
const T = await create({
  kind: 'register', game: 'free_fire', mode: 'clash_squad', name: 'Final Cup', team_size: 2, team_count: 3, entry_fee: 50,
  starts_at: soon(24 * 60), stream_platform: null, stream_url: null,
  rewards: [
    { place: 1, slot: 1, kind: 'money', amount: 200 }, { place: 1, slot: 2, kind: 'product', option_id: PACK },
    { place: 2, slot: 1, kind: 'money', amount: 50 }, { place: 2, slot: 2, kind: 'money', amount: 50 },
    { place: 3, slot: 1, kind: 'money', amount: 30 }, { place: 3, slot: 2, kind: 'money', amount: 30 },
  ],
});
ok('setup: Br 510 held for the rewards', Number((await one(`select reward_hold from tournaments where id = $1`, [T])).reward_hold) === 510);
const TA = await team(T, CA, A2, 'Alpha'), TB = await team(T, CB, B2, 'Bravo');

console.log('\n-- the room: only the host posts it');
await rejects('a player cannot post the room', 'authenticated', CA, `select tournament_post_room($1, '123', 'x')`, /tournament_not_found/, [T]);
await rejects('signed out: no function at all', 'anon', null, `select tournament_post_room($1, '123', 'x')`, /permission denied/, [T]);
await rejects('an empty room ID', 'authenticated', HOST, `select tournament_post_room($1, '   ', 'x')`, /invalid_room/, [T]);
await rejects('a room ID longer than 40', 'authenticated', HOST, `select tournament_post_room($1, $2, 'x')`, /invalid_room/, [T, '1'.repeat(41)]);
await rejects('a password longer than 40', 'authenticated', HOST, `select tournament_post_room($1, '1', $2)`, /invalid_room/, [T, 'p'.repeat(41)]);
await rejects('a control character (line break) in the ID', 'authenticated', HOST, `select tournament_post_room($1, $2, 'x')`, /invalid_room/, [T, '12\n34']);
await rejects('customers cannot read the rooms table', 'authenticated', CA, `select * from tournament_rooms`, /permission denied/);
let d = await detail(CA, T);
ok('before it is posted: no room, room_posted false', d.room === null && d.room_posted === false);

await post(HOST, T, ' 88812345 ', ' ff-secret ');
ok('posted (spaces around it trimmed)', (await one(`select room_id, room_password from tournament_rooms where tournament_id = $1`, [T])).room_id === '88812345');
d = await detail(A2, T);
ok('a registered player sees the ID and password', d.room?.room_id === '88812345' && d.room.password === 'ff-secret' && d.room_posted === true);
ok('the host sees them too', (await detail(HOST, T)).room?.password === 'ff-secret');
d = await detail(FAN, T);
ok('someone not playing sees only that it was posted, never the ID or password', d.room === null && d.room_posted === true && !JSON.stringify(d).includes('ff-secret') && !JSON.stringify(d).includes('88812345'));
const n1 = await inbox(A2, 'tournament_room_posted');
ok('every registered player is told the room is ready', n1.length === 1 && (await inbox(CA, 'tournament_room_posted')).length === 1 && (await inbox(CB, 'tournament_room_posted')).length === 1 && (await inbox(B2, 'tournament_room_posted')).length === 1);
ok('...the notice never carries the ID or the password', !JSON.stringify(n1).includes('88812345') && !JSON.stringify(n1).includes('ff-secret') && n1[0].data.tournament_id === T);
ok('...nobody else is told (not the host, not a bystander)', (await inbox(HOST, 'tournament_room_posted')).length === 0 && (await inbox(FAN, 'tournament_room_posted')).length === 0);
await post(HOST, T, '88812345', 'ff-secret');
ok('posting the same thing again is a no-op (no second notice)', (await inbox(A2, 'tournament_room_posted')).length === 1);
await post(HOST, T, '88812346', '');
ok('a quick correction is saved (an empty password = none)', (await detail(A2, T)).room?.room_id === '88812346' && (await detail(A2, T)).room.password === null);
ok('...without pinging everyone again within the minute', (await inbox(A2, 'tournament_room_posted')).length === 1);
await db.exec(`update tournament_rooms set notified_at = now() - interval '2 minutes' where tournament_id = '${T}'`);
await post(HOST, T, '88812346', 'final-pass');
const n2 = await inbox(A2, 'tournament_room_posted');
ok('a later change tells them again, as an update', n2.length === 2 && n2[1].data.updated === true && n2[1].title === 'Room details were updated');

console.log('\n-- ending it: not before the start, host only');
await rejects('not before the start', 'authenticated', HOST, `select tournament_finish($1, '{}'::jsonb)`, /not_started/, [T]);
await moveStart(T, `now() - interval '30 minutes'`);
await post(HOST, T, '99900001', 'late-pass');
ok('the room can still be posted after the start', (await detail(CA, T)).room?.room_id === '99900001');
await rejects('a player cannot end it', 'authenticated', CA, `select tournament_finish($1, '{}'::jsonb)`, /tournament_not_found/, [T]);
await rejects('signed out: no function', 'anon', null, `select tournament_finish($1, '{}'::jsonb)`, /permission denied/, [T]);
const bad = (n, p) => rejects(n, 'authenticated', HOST, `select tournament_finish($1, $2::jsonb)`, /invalid_placements/, [T, JSON.stringify(p)]);
await bad('no placements (2 teams, 3 places: 1st and 2nd must be picked)', {});
await bad('only 1st', { placements: [{ place: 1, team_id: TA }] });
await bad('the same team twice', { placements: [{ place: 1, team_id: TA }, { place: 2, team_id: TA }] });
await bad('a place twice', { placements: [{ place: 1, team_id: TA }, { place: 1, team_id: TB }] });
await bad('3rd with only 2 teams', { placements: [{ place: 1, team_id: TA }, { place: 3, team_id: TB }] });
await bad('a team that is not in this tournament', { placements: [{ place: 1, team_id: TA }, { place: 2, team_id: '00000000-0000-4000-8000-000000000000' }] });
await bad('not an id', { placements: [{ place: 1, team_id: TA }, { place: 2, team_id: 'x' }] });
await bad('placements not a list', { placements: 'x' });
// A third team's entry is still waiting on a bank transfer, and the host has an unpaid shop order of their own.
const vx = await checked(CC, '5550000001'), vy = await checked(CC, '5550000002');
await moveStart(T, `now() + interval '1 hour'`);
const TC = (await rows('authenticated', CC, `select tournament_team_save($1, $2::jsonb) id`, [T, JSON.stringify({ name: 'Charlie', members: [
  { slot: 1, game_id: '5550000001', validation_id: vx }, { slot: 2, user_id: C2, game_id: '5550000002', validation_id: vy }] })]))[0].id;
const waiting = (await rows('authenticated', CC, `select tournament_team_register($1) r`, [TC]))[0].r;
await moveStart(T, `now() - interval '30 minutes'`);
await db.query(`insert into orders (user_id, option_id, product_name, option_label, amount, status, delivery, fulfillment) values ($1, $2, 'Free Fire', '100 Diamonds', 150, 'pending_payment', '{}'::jsonb, 'topup')`, [HOST, PACK]);

const bal0 = { HOST: await balance(HOST), CA: await balance(CA), A2: await balance(A2), CB: await balance(CB), B2: await balance(B2) };
const res = await finish(HOST, T, { placements: [{ place: 2, team_id: TB }, { place: 1, team_id: TA }] });
ok('finished (placements in any order)', res.status === 'finished' && (await one(`select status, finished_at from tournaments where id = $1`, [T])).finished_at !== null);
ok('1st place, slot 1: Br 200 into Abel\'s wallet', (await balance(CA)) === bal0.CA + 200);
ok('2nd place: Br 50 each', (await balance(CB)) === bal0.CB + 50 && (await balance(B2)) === bal0.B2 + 50);
const gift = await one(`select g.status, g.sender_id, g.recipient_user_id, g.option_id, o.status os, o.tournament_purpose, o.amount, o.user_id
                        from gifts g join orders o on o.id = g.order_id where g.recipient_user_id = $1`, [A2]);
ok('1st place, slot 2: the pack is a gift in Almaz\'s Vault, from the host, waiting to be claimed with her ID', gift?.status === 'pending' && gift.sender_id === HOST && gift.option_id === PACK && gift.os === 'paid' && gift.tournament_purpose === 'prize');
ok('...backed by what the host paid at publish (Br 150), no new money taken from anyone', Number(gift.amount) === 150 && (await balance(A2)) === bal0.A2);
ok('...even though the host had an unpaid order of their own open', gift.user_id === HOST);
ok('...and she is told she received a gift', (await inbox(A2, 'gift_received')).length === 1);
ok('3rd place had no team: its Br 60 goes back to the host, plus 85% of the Br 100 fees (Br 85)', (await balance(HOST)) === bal0.HOST + 60 + 85, `${await balance(HOST)} vs ${bal0.HOST}`);
ok('the reply adds up', Number(res.paid_to_players) === 300 && res.gifts === 1 && Number(res.fees_to_host) === 85 && Number(res.returned_to_host) === 60);
ok('every birr of the Br 510 hold is accounted for', Number(res.paid_to_players) + 150 + Number(res.returned_to_host) === 510);
ok('the unpaid entry of a team that never registered is cancelled', (await one(`select status from orders where id = $1`, [waiting.order_id])).status === 'cancelled');
const notes = await one(`select note from wallet_transactions where user_id = $1 order by created_at desc limit 1`, [CA]);
ok('the wallet line says what it is for', notes.note === 'Prize: Final Cup (1st place)', notes.note);
const won = await inbox(A2, 'tournament_won');
ok('winners are told their place', won.length === 1 && won[0].data.place === 1 && (await inbox(CB, 'tournament_won'))[0]?.data.place === 2);
d = await detail(B2, T);
ok('the results are public, by place', JSON.stringify((await detail(FAN, T)).results) === JSON.stringify([{ place: 1, team_name: 'Alpha' }, { place: 2, team_name: 'Bravo' }]));
ok('each player sees their own place', d.my_place === 2 && (await detail(CA, T)).my_place === 1 && (await detail(FAN, T)).my_place === null);
ok('the list says finished', (await detail(FAN, T)).status === 'finished');
await rejects('ending it twice pays nothing twice', 'authenticated', HOST, `select tournament_finish($1, $2::jsonb)`, /tournament_closed/, [T, JSON.stringify({ placements: [{ place: 1, team_id: TA }, { place: 2, team_id: TB }] })]);
ok('...balances unchanged', (await balance(CA)) === bal0.CA + 200);
await rejects('no room posting after the end', 'authenticated', HOST, `select tournament_post_room($1, '1', '1')`, /tournament_closed/, [T]);
await rejects('nor a cancel (and its refunds) after the end', 'authenticated', HOST, `select tournament_cancel($1)`, /tournament_closed/, [T]);
await rejects('the prize gift order is frozen like every gift order', 'authenticated', ADM, `select admin_set_order_status($1, 'refunded')`, /locked|invalid_transition/, [gift ? (await one(`select order_id from gifts where recipient_user_id = $1`, [A2])).order_id : null]);
await db.exec(`update orders set status = 'cancelled' where user_id = '${HOST}' and status = 'pending_payment'`);
await rejects('customers cannot touch the results table', 'authenticated', CA, `select * from tournament_results`, /permission denied/);

console.log('\n-- more teams than places, a pack no longer sold, a player whose account is gone');
const X1 = await mkUser('x1@x.com', 'X1'), X2 = await mkUser('x2@x.com', 'X2'), Y1 = await mkUser('y1@x.com', 'Y1'), Y2 = await mkUser('y2@x.com', 'Y2'), Z1 = await mkUser('z1@x.com', 'Z1'), Z2 = await mkUser('z2@x.com', 'Z2');
const T2 = await create({
  kind: 'register', game: 'free_fire', mode: 'clash_squad', name: 'Second Cup', team_size: 2, team_count: 3, entry_fee: 50,
  starts_at: soon(24 * 60), stream_platform: null, stream_url: null,
  rewards: [{ place: 1, slot: 1, kind: 'product', option_id: PACK2 }, { place: 1, slot: 2, kind: 'money', amount: 100 }],
});
const TX = await team(T2, X1, X2, 'Xray'), TY = await team(T2, Y1, Y2, 'Yankee'); await team(T2, Z1, Z2, 'Zulu');
await moveStart(T2, `now() - interval '2 days'`);
await db.exec(`update product_options set is_active = false where id = '${PACK2}'`);
await db.exec(`delete from profiles where id = '${X2}'`);
const h2 = await balance(HOST), x1 = await balance(X1);
await rejects('with 3 teams and 1 rewarded place, only 1st may be picked', 'authenticated', HOST, `select tournament_finish($1, $2::jsonb)`, /invalid_placements/, [T2, JSON.stringify({ placements: [{ place: 1, team_id: TX }, { place: 2, team_id: TY }] })]);
const r2 = await finish(HOST, T2, { placements: [{ place: 1, team_id: TX }] });
ok('a pack no longer sold pays its price (Br 700) to the player instead of a gift nobody could claim', (await balance(X1)) === x1 + 700 && r2.gifts === 0);
ok('a reward whose player deleted their account goes back to the host (+ 85% of Br 150 fees = Br 127.50)', (await balance(HOST)) === h2 + 100 + 127.5, `${await balance(HOST)} vs ${h2}`);
ok('the teams that did not place are told it is over', (await inbox(Y1, 'tournament_finished')).length === 1 && (await inbox(Z2, 'tournament_finished')).length === 1 && (await inbox(X1, 'tournament_finished')).length === 0);

console.log('\n-- live: the room for everyone, and ending it');
const L = await create({ kind: 'live', game: 'pubg_mobile', mode: 'tdm', name: 'Live TDM', team_size: 4, starts_at: soon(60), stream_platform: 'tiktok', stream_url: 'https://tiktok.com/@s', prize_text: '600 UC' });
await rows('authenticated', FAN, `select tournament_set_reminder($1, true)`, [L]);
await post(HOST, L, '4455', 'pubg1');
ok('whoever asked to be reminded is told the room is ready', (await inbox(FAN, 'tournament_room_posted')).some((n) => n.data.tournament_id === L));
ok('any signed-in person can see a live room (it is a public event)', (await detail(CC, L)).room?.password === 'pubg1');
await rejects('a live event cannot end before it starts', 'authenticated', HOST, `select tournament_finish($1, '{}'::jsonb)`, /not_started/, [L]);
await moveStart(L, `now() - interval '5 minutes'`);
ok('the host ends it after the start', (await finish(HOST, L, {})).status === 'finished' && (await detail(FAN, L)).status === 'finished');

console.log('\n-- the functions are locked down');
for (const fn of [`_tournament_room_visible(null::tournaments, null)`, `tournament_host_share()`]) {
  await rejects(`${fn.split('(')[0]} is internal`, 'authenticated', CA, `select ${fn}`, /permission denied/);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
