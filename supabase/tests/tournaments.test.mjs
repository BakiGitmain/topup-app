// Tournaments, part 1 (20261024090000): hosting (create / update / cancel) and reading (list / detail).
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
const HOST = await mkUser('host.private@x.com', 'Streamer'), FAN = await mkUser('fan@x.com', 'Fan'), ADM = await mkUser('admin@x.com', 'Boss');
await db.exec(`update profiles set is_content_creator = true where id = '${HOST}'; update profiles set role = 'admin' where id = '${ADM}'`);
// A register tournament's rewards are paid for at publish (20261025090000): give the host plenty.
await as('authenticated', ADM, `select admin_adjust_balance($1, 900000, 'test funds')`, [HOST]);

const P = (await one(`insert into products (slug, name, category, is_active) values ('ff','Free Fire','games',true) returning id`)).id;
const R = (await one(`insert into product_regions (product_id, code, label, is_active) values ($1,'mena','MENA',true) returning id`, [P])).id;
const PACK = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'100 Diamonds',150,true) returning id`, [P, R])).id;
const OFF = (await one(`insert into product_options (product_id, region_id, label, price, is_active) values ($1,$2,'Hidden',150,false) returning id`, [P, R])).id;

const soon = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
const moneyRewards = (places, size, amount = 100) =>
  Array.from({ length: places }, (_, i) => Array.from({ length: size }, (_, j) => ({ place: i + 1, slot: j + 1, kind: 'money', amount }))).flat();
const base = (over = {}) => ({
  kind: 'register', game: 'free_fire', mode: 'battle_royale', name: 'Friday Cup', team_size: 4, team_count: 8,
  entry_fee: 50, starts_at: soon(24 * 60), stream_platform: 'tiktok', stream_url: 'https://www.tiktok.com/@streamer',
  rewards: moneyRewards(3, 4), ...over,
});
const create = (uid, p) => rows('authenticated', uid, `select tournament_create($1::jsonb) ->> 'id' id`, [JSON.stringify(p)]).then((r) => r[0].id);
const bad = (n, p, re, uid = HOST) => rejects(n, 'authenticated', uid, `select tournament_create($1::jsonb)`, re, [JSON.stringify(p)]);

console.log('\n-- games and modes');
const modes = await rows('authenticated', FAN, `select * from tournament_modes() order by game, mode`);
ok('five modes: Free Fire BR / Clash Squad / Lone Wolf, PUBG Mobile Classic / TDM', modes.map((m) => `${m.game}:${m.mode}:${m.max_team_size}:${m.max_players}`).join(' ') ===
  'free_fire:battle_royale:4:48 free_fire:clash_squad:4:64 free_fire:lone_wolf:2:32 pubg_mobile:classic:4:100 pubg_mobile:tdm:4:64', JSON.stringify(modes));

console.log('\n-- who can host');
await bad('a customer who is not a content creator is refused', base(), /not_a_creator/, FAN);
await rejects('signed out: no access at all', 'anon', null, `select tournament_create('{}'::jsonb)`, /permission denied/);
const T1 = await create(HOST, base());
ok('a creator publishes a register tournament', typeof T1 === 'string');
const t1 = await one(`select * from tournaments where id = $1`, [T1]);
ok('...stored as asked: 8 teams of 4 = 32 players, Br 50 per team, published', t1.team_size === 4 && t1.team_count === 8 && Number(t1.entry_fee) === 50 && t1.status === 'published' && t1.host_id === HOST);
ok('...with 3 places x 4 players = 12 rewards', Number((await one(`select count(*) n from tournament_rewards where tournament_id = $1`, [T1])).n) === 12);

console.log('\n-- the numbers always divide evenly');
await bad('more players than the mode allows (13 teams of 4 = 52 > 48 in a Free Fire room)', base({ team_count: 13 }), /invalid_team_count/);
ok('...12 teams of 4 = 48 is fine', typeof (await create(HOST, base({ team_count: 12, name: 'Full room' }))) === 'string');
await bad('one team is not a tournament', base({ team_count: 1, rewards: moneyRewards(1, 4) }), /invalid_team_count/);
await bad('a team bigger than the mode allows (Lone Wolf is 1 or 2)', base({ mode: 'lone_wolf', team_size: 3, rewards: moneyRewards(3, 3) }), /invalid_team_size/);
await bad('a team of 0', base({ team_size: 0 }), /invalid_team_size/);
await bad('a fractional team size', base({ team_size: 2.5 }), /invalid_team_size/);
await bad('a team count sent as text', base({ team_count: '8' }), /invalid_team_count/);
await bad('an unknown mode', base({ mode: 'ranked' }), /invalid_game_mode/);
await bad('a mode from the other game', base({ game: 'pubg_mobile', mode: 'clash_squad' }), /invalid_game_mode/);
await bad('an unknown game', base({ game: 'fortnite' }), /invalid_game_mode/);
ok('PUBG Mobile Classic: 25 squads = 100 players', typeof (await create(HOST, base({ game: 'pubg_mobile', mode: 'classic', team_count: 25, name: 'PUBG 100' }))) === 'string');

console.log('\n-- fee, name, start, stream');
ok('free (entry_fee 0)', typeof (await create(HOST, base({ entry_fee: 0, name: 'Free one' }))) === 'string');
await bad('a negative fee', base({ entry_fee: -5 }), /invalid_entry_fee/);
await bad('a fee with 3 decimals', base({ entry_fee: 10.555 }), /invalid_entry_fee/);
await bad('a fee as text', base({ entry_fee: '50' }), /invalid_entry_fee/);
await bad('a 2-letter name', base({ name: ' ab ' }), /invalid_name/);
await bad('a 61-letter name', base({ name: 'x'.repeat(61) }), /invalid_name/);
await bad('starting in 5 minutes (at least 15)', base({ starts_at: soon(5) }), /invalid_start/);
await bad('starting in the past', base({ starts_at: soon(-60) }), /invalid_start/);
await bad('starting more than 90 days out', base({ starts_at: soon(91 * 24 * 60) }), /invalid_start/);
await bad('an unreadable start', base({ starts_at: 'tomorrow' }), /invalid_start/);
await bad('a stream link that is not https', base({ stream_url: 'http://tiktok.com/@x' }), /invalid_stream/);
await bad('a stream link with spaces', base({ stream_url: 'https://tiktok.com/@x y' }), /invalid_stream/);
await bad('a platform with no link', base({ stream_url: '' }), /invalid_stream/);
await bad('an unknown platform', base({ stream_platform: 'myspace' }), /invalid_stream/);
ok('a register tournament may have no stream', typeof (await create(HOST, base({ stream_platform: null, stream_url: null, name: 'No stream' }))) === 'string');

console.log('\n-- rewards: every place, every player');
await bad('no rewards', base({ rewards: [] }), /invalid_rewards/);
await bad('a place missing a player (4 per team, only 3 rewarded)', base({ rewards: moneyRewards(1, 4).slice(0, 3) }), /invalid_rewards/);
await bad('a gap in the places (1 and 3, no 2)', base({ rewards: [...moneyRewards(1, 4), ...moneyRewards(3, 4).slice(8)] }), /invalid_rewards/);
await bad('a slot beyond the team size', base({ team_size: 2, rewards: [{ place: 1, slot: 1, kind: 'money', amount: 5 }, { place: 1, slot: 3, kind: 'money', amount: 5 }] }), /invalid_rewards/);
await bad('the same slot twice', base({ team_size: 2, rewards: [{ place: 1, slot: 1, kind: 'money', amount: 5 }, { place: 1, slot: 1, kind: 'money', amount: 5 }] }), /invalid_rewards/);
await bad('more places than teams (3 places, 2 teams)', base({ team_count: 2, rewards: moneyRewards(3, 4) }), /invalid_rewards/);
await bad('more than 10 places', base({ team_size: 1, team_count: 40, rewards: moneyRewards(11, 1) }), /invalid_rewards/);
await bad('money of 0', base({ rewards: moneyRewards(1, 4, 0) }), /invalid_rewards/);
await bad('money over the cap', base({ rewards: moneyRewards(1, 4, 1000001) }), /invalid_rewards/);
await bad('an unknown reward kind', base({ team_size: 1, rewards: [{ place: 1, slot: 1, kind: 'hug' }] }), /invalid_rewards/);
await bad('a product that is not on sale', base({ team_size: 1, rewards: [{ place: 1, slot: 1, kind: 'product', option_id: OFF }] }), /reward_pack_unavailable/);
await bad('a product with a malformed id', base({ team_size: 1, rewards: [{ place: 1, slot: 1, kind: 'product', option_id: 'nope' }] }), /invalid_rewards/);
await bad('money AND a product in one reward', base({ team_size: 1, rewards: [{ place: 1, slot: 1, kind: 'money', amount: 5, option_id: PACK }] }), /invalid_rewards/);
const T2 = await create(HOST, base({ name: 'Mixed', team_size: 2, rewards: [{ place: 1, slot: 1, kind: 'money', amount: 500 }, { place: 1, slot: 2, kind: 'product', option_id: PACK }] }));
const prod = await one(`select * from tournament_rewards where tournament_id = $1 and kind = 'product'`, [T2]);
ok('a product reward keeps a snapshot of the pack (name, pack, region)', prod.product_name === 'Free Fire' && prod.option_label === '100 Diamonds' && prod.region_label === 'MENA' && prod.option_id === PACK);

console.log('\n-- live tournaments');
const live = { kind: 'live', game: 'pubg_mobile', mode: 'tdm', name: 'Live TDM', team_size: 4, starts_at: soon(60), stream_platform: 'youtube', stream_url: 'https://youtube.com/@s', prize_text: '1,000 diamonds to the winning squad' };
const L1 = await create(HOST, live);
const l1 = await one(`select * from tournaments where id = $1`, [L1]);
ok('a live tournament: no team count, no fee', l1.kind === 'live' && l1.team_count === null && Number(l1.entry_fee) === 0);
await bad('live with a team count', { ...live, team_count: 4 }, /invalid_team_count/);
await bad('live with a fee', { ...live, entry_fee: 10 }, /invalid_entry_fee/);
await bad('live without a stream link (it is where people watch)', { ...live, stream_platform: null, stream_url: null }, /invalid_stream/);

console.log('\n-- a published tournament is fixed');
await rejects('its shape cannot change (even by the database owner)', 'postgres', null, `update tournaments set team_count = 9 where id = '${T1}'`, /tournament_locked/);
await rejects('...nor its fee', 'postgres', null, `update tournaments set entry_fee = 1 where id = '${T1}'`, /tournament_locked/);
await rejects('...nor its host', 'postgres', null, `update tournaments set host_id = '${FAN}' where id = '${T1}'`, /tournament_locked/);
await rejects('its rewards cannot be edited', 'postgres', null, `update tournament_rewards set amount = 1 where tournament_id = '${T1}'`, /tournament_locked/);
await rejects('...or removed', 'postgres', null, `delete from tournament_rewards where tournament_id = '${T1}'`, /tournament_locked/);
await rejects('customers cannot touch the tables directly', 'authenticated', HOST, `update tournaments set name = 'x' where id = '${T1}'`, /permission denied/);
await rejects('...or read them directly', 'authenticated', HOST, `select * from tournament_rewards`, /permission denied/);

console.log('\n-- update: name, time, stream only, host only');
const upd = (uid, id, p) => rows('authenticated', uid, `select tournament_update($1, $2::jsonb)`, [id, JSON.stringify(p)]);
await upd(HOST, T1, { name: 'Friday Cup Final', starts_at: soon(48 * 60) });
const u1 = await one(`select name, starts_at from tournaments where id = $1`, [T1]);
ok('the host renames it and moves the start', u1.name === 'Friday Cup Final' && new Date(u1.starts_at) > new Date(Date.now() + 47 * 3600_000));
await upd(HOST, T1, { stream_platform: '', stream_url: '' });
ok('...and can clear a register tournament\'s stream', (await one(`select stream_url from tournaments where id = $1`, [T1])).stream_url === null);
await rejects('a live tournament cannot lose its stream', 'authenticated', HOST, `select tournament_update($1, '{"stream_url":"","stream_platform":""}'::jsonb)`, /invalid_stream/, [L1]);
await rejects('someone else cannot edit it (reads as not found)', 'authenticated', FAN, `select tournament_update($1, '{"name":"mine now"}'::jsonb)`, /tournament_not_found/, [T1]);
await rejects('a start in the past is refused', 'authenticated', HOST, `select tournament_update($1, $2::jsonb)`, /invalid_start/, [T1, JSON.stringify({ starts_at: soon(-5) })]);
await db.exec(`alter table tournaments disable trigger tournaments_guard; update tournaments set starts_at = now() - interval '1 minute' where id = '${T2}'; alter table tournaments enable trigger tournaments_guard;`);
await rejects('once started, nothing can be edited', 'authenticated', HOST, `select tournament_update($1, '{"name":"late"}'::jsonb)`, /tournament_closed/, [T2]);

console.log('\n-- cancel');
await rejects('a customer cannot cancel someone else\'s', 'authenticated', FAN, `select tournament_cancel($1)`, /tournament_not_found/, [T1]);
await rows('authenticated', HOST, `select tournament_cancel($1)`, [T1]);
ok('the host cancels it', (await one(`select status, cancelled_at from tournaments where id = $1`, [T1])).status === 'cancelled');
await rejects('cancelled is final', 'authenticated', HOST, `select tournament_cancel($1)`, /tournament_closed/, [T1]);
await rejects('...and cannot be edited', 'authenticated', HOST, `select tournament_update($1, '{"name":"back"}'::jsonb)`, /tournament_closed/, [T1]);
await rejects('...nor reopened directly', 'postgres', null, `update tournaments set status = 'published', cancelled_at = null where id = '${T1}'`, /tournament_closed/);
await rows('authenticated', ADM, `select tournament_cancel($1)`, [L1]);
ok('an admin can cancel any tournament (moderation)', (await one(`select status from tournaments where id = $1`, [L1])).status === 'cancelled');

console.log('\n-- reading');
const open = (await rows('authenticated', FAN, `select tournament_list('open') l`))[0].l;
ok('the open list shows published, upcoming ones only (not cancelled)', open.length > 0 && open.every((t) => t.status === 'published') && !open.some((t) => t.id === T1 || t.id === L1));
ok('...soonest first', open.every((t, i) => i === 0 || new Date(open[i - 1].starts_at) <= new Date(t.starts_at)));
ok('...with the host as name + picture, never the email', open[0].host.name === 'Streamer' && !JSON.stringify(open).includes('host.private') && !JSON.stringify(open).includes(HOST));
ok('...and is_host false for a customer', open.every((t) => t.is_host === false));
const pubgOnly = (await rows('authenticated', FAN, `select tournament_list('open', 'pubg_mobile') l`))[0].l;
ok('filter by game', pubgOnly.length === 1 && pubgOnly[0].game === 'pubg_mobile');
const hosting = (await rows('authenticated', HOST, `select tournament_list('hosting') l`))[0].l;
ok('hosting: every one of the host\'s own, cancelled included', hosting.some((t) => t.id === T1 && t.status === 'cancelled') && hosting.every((t) => t.is_host));
ok('...and nobody else sees another host\'s list as theirs', (await rows('authenticated', FAN, `select tournament_list('hosting') l`))[0].l.length === 0);
const detail = (await rows('authenticated', FAN, `select tournament_detail($1) d`, [T2]))[0].d;
ok('detail has every reward in order, place then player', detail.rewards.length === 2 && detail.rewards[0].slot === 1 && detail.rewards[1].kind === 'product' && detail.rewards[1].product_name === 'Free Fire');
ok('...and the first-place headline (Br 500 + 1 product)', Number(detail.first_place.money) === 500 && Number(detail.first_place.products) === 1);
ok('...and never the pack id or its cost', !('option_id' in detail.rewards[1]));
ok('an unknown id reads as nothing', (await rows('authenticated', FAN, `select tournament_detail(gen_random_uuid()) d`))[0].d === null);
await rejects('an unknown scope', 'authenticated', FAN, `select tournament_list('everything')`, /invalid_scope/);
await rejects('signed out cannot list', 'anon', null, `select tournament_list('open')`, /permission denied/);

console.log('\n-- limits and deletion');
for (let i = 0; ; i++) {
  const n = Number((await one(`select count(*) n from tournaments where host_id = $1 and status = 'published' and starts_at > now()`, [HOST])).n);
  if (n >= 10) break;
  await create(HOST, base({ name: `Filler ${i}` }));
}
await bad('at most 10 upcoming tournaments per host', base({ name: 'Eleventh' }), /too_many_tournaments/);
await rejects('a host with an upcoming tournament cannot delete their account', 'postgres', null, `delete from profiles where id = '${HOST}'`, /host_has_upcoming_tournaments/);
await db.exec(`update products set is_active = true where id = '${P}'`);
await db.exec(`delete from product_options where id = '${PACK}'`);
const after = await one(`select option_id, product_name from tournament_rewards where tournament_id = $1 and kind = 'product'`, [T2]);
ok('deleting a rewarded pack keeps the announcement (snapshot) and clears the link', after.option_id === null && after.product_name === 'Free Fire');

console.log('\n-- internal helpers are not callable');
for (const fn of [`_tj_int('1'::jsonb)`, `_tj_time('x')`, `_tj_money('1'::jsonb)`, `_tournament_check_start(now())`, `_tournament_check_stream(null, null, false)`, `tournament_start_window()`]) {
  await rejects(`${fn.split('(')[0]} is internal`, 'authenticated', HOST, `select ${fn}`, /permission denied/);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
