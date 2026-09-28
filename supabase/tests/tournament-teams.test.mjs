// Tournaments, part 2 (20261025090000): the host pays for register rewards at publish; live = prize text only;
// teams (drafts, checked game IDs, entry fee held, spots); cancel refunds everyone; reminders and notices.
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
const HOST = await mkUser('host@x.com', 'Streamer'), ADM = await mkUser('admin@x.com', 'Boss');
const CAP = await mkUser('cap.private@x.com', 'Abel'), P2 = await mkUser('p2@x.com', 'Bruk'), P3 = await mkUser('p3@x.com', 'Chala');
const CAP2 = await mkUser('cap2@x.com', 'Dawit'), Q2 = await mkUser('q2@x.com', 'Eyob'), FAN = await mkUser('fan@x.com', 'Fan');
await db.exec(`update profiles set is_content_creator = true where id = '${HOST}'; update profiles set role = 'admin' where id = '${ADM}'`);
const fund = (uid, n) => as('authenticated', ADM, `select admin_adjust_balance($1, $2, 'test funds')`, [uid, n]);
const balance = async (uid) => Number((await one(`select balance from wallets where user_id = $1`, [uid])).balance);

// The game's checked shop region (what validate-id checks Free Fire IDs against) and a pack to give as a reward.
const P = (await one(`insert into products (slug, name, category, is_active) values ('ff','Free Fire','games',true) returning id`)).id;
const R = (await one(`insert into product_regions (product_id, code, label, is_active, id_validation, buyer_fields) values ($1,'mena','MENA',true,'supplier','[{"key":"player_id","label":"Player ID"}]'::jsonb) returning id`, [P])).id;
const PACK = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'100 Diamonds',150,true) returning id`, [P, R])).id;

const soon = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
const create = (p) => rows('authenticated', HOST, `select tournament_create($1::jsonb) id`, [JSON.stringify(p)]).then((r) => r[0].id);
const reg = (over = {}) => ({
  kind: 'register', game: 'free_fire', mode: 'clash_squad', name: 'Squad Cup', team_size: 3, team_count: 2, entry_fee: 40,
  starts_at: soon(24 * 60), stream_platform: null, stream_url: null,
  rewards: [
    { place: 1, slot: 1, kind: 'money', amount: 100 }, { place: 1, slot: 2, kind: 'money', amount: 100 }, { place: 1, slot: 3, kind: 'product', option_id: PACK },
  ],
  ...over,
});
// What validate-id writes after a successful check (by the captain, for one game ID).
const checked = async (by, gameId, name, ago = '1 minute') => (await one(
  `insert into id_validations (user_id, region_id, fields, player_name, created_at, expires_at) values ($1, $2, $3::jsonb, $4, now() - $5::interval, now() + interval '15 minutes') returning id`,
  [by, R, JSON.stringify({ player_id: gameId }), name, ago])).id;
const save = (uid, t, p) => rows('authenticated', uid, `select tournament_team_save($1, $2::jsonb) id`, [t, JSON.stringify(p)]).then((r) => r[0].id);
const saveBad = (n, uid, t, p, re) => rejects(n, 'authenticated', uid, `select tournament_team_save($1, $2::jsonb)`, re, [t, JSON.stringify(p)]);
const inbox = (uid, type) => rows('postgres', null, `select type, title, body, data from notifications where user_id = $1 and type = $2 order by created_at`, [uid, type]);

console.log('\n-- the host pays for register rewards when publishing');
await rejects('with an empty wallet, publishing is refused (and nothing is created)', 'authenticated', HOST, `select tournament_create($1::jsonb)`, /insufficient_balance/, [JSON.stringify(reg())]);
ok('...really nothing', Number((await one(`select count(*) n from tournaments`)).n) === 0);
await fund(HOST, 1000);
const T = await create(reg());
ok('published: Br 100 + 100 + the pack\'s Br 150 = Br 350 taken from the host', (await balance(HOST)) === 650);
ok('...held on the tournament', Number((await one(`select reward_hold from tournaments where id = $1`, [T])).reward_hold) === 350);
const tx = await one(`select kind, amount from wallet_transactions where user_id = $1 order by created_at desc limit 1`, [HOST]);
ok('...as one wallet line, kind tournament', tx.kind === 'tournament' && Number(tx.amount) === -350);
ok('the pack reward remembers what was paid for it', Number((await one(`select price_paid from tournament_rewards where tournament_id = $1 and kind = 'product'`, [T])).price_paid) === 150);
await rejects('the hold can never be changed afterwards', 'postgres', null, `update tournaments set reward_hold = 0 where id = '${T}'`, /tournament_locked/);

console.log('\n-- live: prize text, no reward grid, nothing paid');
const liveBase = { kind: 'live', game: 'pubg_mobile', mode: 'tdm', name: 'Live TDM', team_size: 4, starts_at: soon(60), stream_platform: 'tiktok', stream_url: 'https://tiktok.com/@s', prize_text: '600 UC to the winners' };
const before = await balance(HOST);
const L = await create(liveBase);
ok('a live tournament costs the host nothing', (await balance(HOST)) === before);
ok('...and stores what the winner gets as text', (await one(`select prize_text, reward_hold from tournaments where id = $1`, [L])).prize_text === '600 UC to the winners');
await rejects('live without a prize text', 'authenticated', HOST, `select tournament_create($1::jsonb)`, /invalid_prize/, [JSON.stringify({ ...liveBase, prize_text: '' })]);
await rejects('live with a reward grid', 'authenticated', HOST, `select tournament_create($1::jsonb)`, /invalid_rewards/, [JSON.stringify({ ...liveBase, rewards: [{ place: 1, slot: 1, kind: 'money', amount: 5 }] })]);
await rejects('a register tournament with a prize text (its prizes are the paid rewards)', 'authenticated', HOST, `select tournament_create($1::jsonb)`, /invalid_prize/, [JSON.stringify(reg({ prize_text: 'x y' }))]);
await rows('authenticated', HOST, `select tournament_update($1, '{"prize_text":"800 UC"}'::jsonb)`, [L]);
ok('the host can reword a live prize', (await one(`select prize_text from tournaments where id = $1`, [L])).prize_text === '800 UC');
await rejects('...but a register tournament has no prize text to edit', 'authenticated', HOST, `select tournament_update($1, '{"prize_text":"more"}'::jsonb)`, /invalid_prize/, [T]);
await saveBad('nobody registers a team for a live tournament', CAP, L, { name: 'Wolves', members: [] }, /not_register/);

console.log('\n-- a team draft');
const detail = (uid, id) => rows('authenticated', uid, `select tournament_detail($1) d`, [id]).then((r) => r[0].d);
const d0 = await detail(CAP, T);
ok('the detail says where game IDs are checked (the checked Free Fire region, its field)', d0.id_check?.region_id === R && d0.id_check.field_key === 'player_id');
ok('...and no team of mine yet', d0.my_team === null && d0.teams_registered === 0);
const vCap = await checked(CAP, '1111111111', 'AbelFF');
const TEAM = await save(CAP, T, { name: 'Wolves', members: [{ slot: 1, game_id: '1111111111', validation_id: vCap }] });
ok('the captain saves a draft with just themself: they are player 1', (await one(`select user_id, player_name from tournament_team_members where team_id = $1 and slot = 1`, [TEAM])).player_name === 'AbelFF');
ok('...a draft reserves no spot', (await detail(FAN, T)).teams_registered === 0);
const v2 = await checked(CAP, '2222222222', 'BrukFF');
await save(CAP, T, { name: 'Wolves', members: [{ slot: 1, game_id: '1111111111', validation_id: vCap }, { slot: 2, user_id: P2, game_id: '2222222222', validation_id: v2 }] });
const m2 = await one(`select user_id, player_name from tournament_team_members where team_id = $1 and slot = 2`, [TEAM]);
ok('player 2 added: their account and the name the checker returned', m2.user_id === P2 && m2.player_name === 'BrukFF');
ok('saving again edits the same draft (one team per captain)', Number((await one(`select count(*) n from tournament_teams where captain_id = $1`, [CAP])).n) === 1);

console.log('\n-- only checked IDs, only real people');
await saveBad('a game ID nobody checked', CAP, T, { name: 'Wolves', members: [{ slot: 2, user_id: P2, game_id: '9999999999' }] }, /id_not_verified/);
const vOther = await checked(P3, '3333333333', 'ChalaFF');
await saveBad('a check someone ELSE ran does not count for the captain', CAP, T, { name: 'Wolves', members: [{ slot: 3, user_id: P3, game_id: '3333333333', validation_id: vOther }] }, /id_not_verified/);
const vWrongId = await checked(CAP, '4444444444', 'Someone');
await saveBad('a check for a different ID does not count', CAP, T, { name: 'Wolves', members: [{ slot: 3, user_id: P3, game_id: '3333333333', validation_id: vWrongId }] }, /id_not_verified/);
const vOld = await checked(CAP, '3333333333', 'Stale', '2 days');
await saveBad('a check older than a day does not count', CAP, T, { name: 'Wolves', members: [{ slot: 3, user_id: P3, game_id: '3333333333', validation_id: vOld }] }, /id_not_verified/);
await saveBad('an account that does not exist', CAP, T, { name: 'Wolves', members: [{ slot: 2, user_id: '00000000-0000-4000-8000-000000000000' }] }, /member_not_found/);
await saveBad('the same person twice', CAP, T, { name: 'Wolves', members: [{ slot: 2, user_id: P2 }, { slot: 3, user_id: P2 }] }, /duplicate_member/);
await saveBad('the captain again in another slot', CAP, T, { name: 'Wolves', members: [{ slot: 2, user_id: CAP }] }, /duplicate_member/);
await saveBad('the same game ID twice', CAP, T, { name: 'Wolves', members: [{ slot: 1, game_id: '2222222222', validation_id: v2 }, { slot: 2, user_id: P2, game_id: '2222222222', validation_id: v2 }] }, /duplicate_game_id/);
await saveBad('the host cannot play in their own tournament', CAP, T, { name: 'Wolves', members: [{ slot: 2, user_id: HOST }] }, /host_cannot_join/);
await saveBad('...nor register a team in it', HOST, T, { name: 'Hosts', members: [] }, /host_cannot_join/);
await saveBad('a slot beyond the team size', CAP, T, { name: 'Wolves', members: [{ slot: 4, user_id: P3 }] }, /invalid_members/);
await saveBad('a one-letter team name', CAP, T, { name: 'W', members: [] }, /invalid_team_name/);
await saveBad('a game ID with spaces', CAP, T, { name: 'Wolves', members: [{ slot: 1, game_id: '11 11' }] }, /invalid_members/);
await rejects('customers cannot touch the team tables directly', 'authenticated', CAP, `select * from tournament_team_members`, /permission denied/);

console.log('\n-- registering');
await rejects('an incomplete team cannot register', 'authenticated', CAP, `select tournament_team_register($1)`, /team_incomplete/, [TEAM]);
const v3 = await checked(CAP, '3333333333', 'ChalaFF');
const full = { name: 'Wolves', members: [{ slot: 1, game_id: '1111111111', validation_id: vCap }, { slot: 2, user_id: P2, game_id: '2222222222', validation_id: v2 }, { slot: 3, user_id: P3, game_id: '3333333333', validation_id: v3 }] };
await save(CAP, T, full);
await rejects('someone else cannot register my team', 'authenticated', P2, `select tournament_team_register($1)`, /team_not_found/, [TEAM]);
await rejects('without Br 40 for the entry fee: refused, nothing registered', 'authenticated', CAP, `select tournament_team_register($1)`, /insufficient_balance/, [TEAM]);
ok('...still a draft', (await one(`select status from tournament_teams where id = $1`, [TEAM])).status === 'draft');
await fund(CAP, 100);
const r1 = (await rows('authenticated', CAP, `select tournament_team_register($1) r`, [TEAM]))[0].r;
ok('registered: the fee (Br 40) is taken once, from the captain only', r1.status === 'registered' && (await balance(CAP)) === 60 && (await balance(P2)) === 0);
ok('...and held on the team', Number((await one(`select fee_paid from tournament_teams where id = $1`, [TEAM])).fee_paid) === 40);
const again = (await rows('authenticated', CAP, `select tournament_team_register($1) r`, [TEAM]))[0].r;
ok('a double tap registers once and charges once', again.already === true && (await balance(CAP)) === 60);
await rejects('a registered roster is fixed', 'authenticated', CAP, `select tournament_team_save($1, $2::jsonb)`, /team_locked/, [T, JSON.stringify(full)]);
await rejects('...even for the database owner', 'postgres', null, `update tournament_team_members set game_id = '5555555555' where team_id = '${TEAM}' and slot = 2`, /team_locked/);
await rejects('...and a registered team cannot be thrown away', 'authenticated', CAP, `select tournament_team_discard($1)`, /team_not_found/, [TEAM]);

const hostNote = await inbox(HOST, 'tournament_team_registered');
ok('the host is told: team name, 1 of 2 teams', hostNote.length === 1 && hostNote[0].data.team_name === 'Wolves' && hostNote[0].data.teams === 1 && hostNote[0].data.team_count === 2);
const joined = await inbox(P2, 'tournament_joined');
ok('each player is told they were added (by name, never email)', joined.length === 1 && joined[0].data.captain_name === 'Abel' && (await inbox(P3, 'tournament_joined')).length === 1 && !JSON.stringify(joined).includes('cap.private'));
ok('the captain is not told about their own team', (await inbox(CAP, 'tournament_joined')).length === 0);

const pub = await detail(FAN, T);
ok('everyone sees 1 team registered, by name', pub.teams_registered === 1 && pub.teams[0].name === 'Wolves');
ok('...but not the players\' game IDs', pub.teams[0].members.every((m) => m.game_id === null && m.user_id === null));
const forHost = await detail(HOST, T);
ok('the host sees every player\'s game ID and checked name (to run the match)', forHost.teams[0].members.map((m) => `${m.game_id}:${m.player_name}`).join(' ') === '1111111111:AbelFF 2222222222:BrukFF 3333333333:ChalaFF');
const mine = (await rows('authenticated', P2, `select tournament_my_team($1) t`, [T]))[0].t;
ok('a player sees their own team, with their IDs', mine.name === 'Wolves' && mine.members[1].game_id === '2222222222' && mine.is_captain === false);
ok('...and it is in their "mine" list', (await rows('authenticated', P2, `select tournament_list('mine') l`))[0].l.some((x) => x.id === T));

console.log('\n-- one team per person, spots run out');
const vQ = await checked(CAP2, '6666666666', 'DawitFF');
const vQ2 = await checked(CAP2, '7777777777', 'EyobFF');
const vP2 = await checked(CAP2, '2222222222', 'BrukFF');
await saveBad('someone already registered in another team cannot be added', CAP2, T, { name: 'Lions', members: [{ slot: 1, game_id: '6666666666', validation_id: vQ }, { slot: 2, user_id: P2, game_id: '2222222222', validation_id: vP2 }] }, /already_in_team/);
await saveBad('a team name already taken (any case)', CAP2, T, { name: 'WOLVES', members: [] }, /team_name_taken/);
const vF = await checked(CAP2, '8888888888', 'FanFF');
const TEAM2 = await save(CAP2, T, { name: 'Lions', members: [{ slot: 1, game_id: '6666666666', validation_id: vQ }, { slot: 2, user_id: Q2, game_id: '7777777777', validation_id: vQ2 }, { slot: 3, user_id: FAN, game_id: '8888888888', validation_id: vF }] });
await fund(CAP2, 40);
await rows('authenticated', CAP2, `select tournament_team_register($1)`, [TEAM2]);
ok('the second (last) team registers', (await detail(FAN, T)).teams_registered === 2);
const P4 = await mkUser('p4@x.com', 'G'), P5 = await mkUser('p5@x.com', 'H'), P6 = await mkUser('p6@x.com', 'I');
const w1 = await checked(P4, '1212121212', 'x'), w2 = await checked(P4, '1313131313', 'y'), w3 = await checked(P4, '1414141414', 'z');
const TEAM3 = await save(P4, T, { name: 'Late', members: [{ slot: 1, game_id: '1212121212', validation_id: w1 }, { slot: 2, user_id: P5, game_id: '1313131313', validation_id: w2 }, { slot: 3, user_id: P6, game_id: '1414141414', validation_id: w3 }] });
await fund(P4, 40);
await rejects('a third team: the tournament is full (2 teams)', 'authenticated', P4, `select tournament_team_register($1)`, /tournament_full/, [TEAM3]);
ok('...and was charged nothing', (await balance(P4)) === 40);
await rows('authenticated', P4, `select tournament_team_discard($1)`, [TEAM3]);
ok('a draft can be thrown away', Number((await one(`select count(*) n from tournament_teams where id = $1`, [TEAM3])).n) === 0);
await rejects('a registered player cannot delete their account before it is played', 'postgres', null, `delete from profiles where id = '${P2}'`, /player_has_upcoming_tournaments/);

console.log('\n-- reminders and "starting soon"');
await rows('authenticated', FAN, `select tournament_set_reminder($1, true)`, [L]);
ok('Remind me is remembered', (await detail(FAN, L)).reminded === true);
await rows('authenticated', FAN, `select tournament_set_reminder($1, true)`, [L]);
ok('...tapping twice is harmless', Number((await one(`select count(*) n from tournament_reminders where user_id = $1`, [FAN])).n) === 1);
const notes = async (uid) => (await rows('authenticated', uid, `select type, data from my_notifications(200)`)).filter((n) => n.type === 'tournament_starting');
ok('an hour before: no notice yet', (await notes(FAN)).length === 0);
await db.exec(`alter table tournaments disable trigger tournaments_guard; update tournaments set starts_at = now() + interval '10 minutes' where id = '${L}'; alter table tournaments enable trigger tournaments_guard;`);
const n1 = await notes(FAN);
ok('10 minutes before: the reminded person gets "starting soon" when they load notifications', n1.length === 1 && n1[0].data.tournament_id === L);
ok('...only once', (await notes(FAN)).length === 1);
ok('the host is reminded of their own tournament too', (await notes(HOST)).length === 1);
ok('someone who asked for nothing gets nothing', (await notes(P3)).length === 0);
await db.exec(`alter table tournaments disable trigger tournaments_guard; update tournaments set starts_at = now() + interval '5 minutes' where id = '${T}'; alter table tournaments enable trigger tournaments_guard;`);
ok('registered players are reminded without asking', (await notes(P3)).length === 1 && (await notes(P2)).length === 1);
await rows('authenticated', FAN, `select tournament_set_reminder($1, false)`, [L]);
ok('Remind me can be turned off', (await detail(FAN, L)).reminded === false);

console.log('\n-- cancel gives everything back');
const T2 = await create(reg({ name: 'Doomed Cup', team_count: 3 }));
const hostBefore = await balance(HOST);
const vA = await checked(CAP, '1111111111', 'AbelFF'), vB = await checked(CAP, '2020202020', 'Z1'), vC = await checked(CAP, '3030303030', 'Z2');
const P7 = await mkUser('p7@x.com', 'J'), P8 = await mkUser('p8@x.com', 'K');
const DT = await save(CAP, T2, { name: 'Wolves', members: [{ slot: 1, game_id: '1111111111', validation_id: vA }, { slot: 2, user_id: P7, game_id: '2020202020', validation_id: vB }, { slot: 3, user_id: P8, game_id: '3030303030', validation_id: vC }] });
await rows('authenticated', CAP, `select tournament_team_register($1)`, [DT]);
const DRAFT = await save(CAP2, T2, { name: 'Maybe', members: [] });
const capBefore = await balance(CAP);
await rows('authenticated', FAN, `select tournament_set_reminder($1, true)`, [T2]);
await rejects('a player cannot cancel it', 'authenticated', CAP, `select tournament_cancel($1)`, /tournament_not_found/, [T2]);
await rows('authenticated', HOST, `select tournament_cancel($1)`, [T2]);
ok('the captain gets the whole fee back', (await balance(CAP)) === capBefore + 40);
ok('the host gets the reward money back', (await balance(HOST)) === hostBefore + 350);
ok('the team reads cancelled; the draft is gone', (await one(`select status from tournament_teams where id = $1`, [DT])).status === 'cancelled' && Number((await one(`select count(*) n from tournament_teams where id = $1`, [DRAFT])).n) === 0);
const cn = await inbox(P7, 'tournament_cancelled');
ok('every player is told', cn.length === 1 && (await inbox(P8, 'tournament_cancelled')).length === 1);
ok('...the captain is told the fee is back', (await inbox(CAP, 'tournament_cancelled'))[0]?.body.includes('entry fee is back'));
ok('...and so is everyone who asked for a reminder', (await inbox(FAN, 'tournament_cancelled')).length === 1);
await rejects('cancelling twice refunds nothing more', 'authenticated', HOST, `select tournament_cancel($1)`, /tournament_closed/, [T2]);
ok('...balances unchanged', (await balance(CAP)) === capBefore + 40);
ok('the cancelled players are free to delete their accounts again', (await db.query(`delete from profiles where id = '${P8}' returning id`)).rows.length === 1);

console.log('\n-- closed tournaments take no teams');
await db.exec(`alter table tournaments disable trigger tournaments_guard; update tournaments set starts_at = now() - interval '1 minute' where id = '${T}'; alter table tournaments enable trigger tournaments_guard;`);
await saveBad('after the start, no new drafts', P4, T, { name: 'Too late', members: [] }, /tournament_closed/);

console.log('\n-- the functions are locked down');
for (const fn of [`_tournament_check_region('free_fire')`, `_tournament_notify(null, 'x', 'x', 'x', '{}'::jsonb)`, `_deliver_tournament_notices(null)`, `_tournament_team_json(gen_random_uuid(), true)`, `tournament_notice_lead()`]) {
  await rejects(`${fn.split('(')[0]} is internal`, 'authenticated', CAP, `select ${fn}`, /permission denied/);
}
for (const fn of [`tournament_team_save(gen_random_uuid(), '{}'::jsonb)`, `tournament_team_register(gen_random_uuid())`, `tournament_set_reminder(gen_random_uuid(), true)`, `tournament_my_team(gen_random_uuid())`]) {
  await rejects(`signed out: ${fn.split('(')[0]}`, 'anon', null, `select ${fn}`, /permission denied/);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
