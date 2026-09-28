// Tournaments, part 1: the host form's rules (the database enforces them again, see supabase/tests/tournaments.test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  MODES,
  PLATFORM_CUT_PERCENT,
  START_MAX_LEAD_MS,
  START_MIN_LEAD_MS,
  buildCreatePayload,
  clampTeamCount,
  countdown,
  detailsProblem,
  emptyHostForm,
  fillPlace,
  gridComplete,
  hostShareOfFee,
  maxPlaces,
  maxTeams,
  modeOf,
  normalizeStreamUrl,
  parseBirr,
  phaseOf,
  resizeGrid,
  rewardTotals,
  serverErrorOf,
  setReward,
  slotVerified,
  streamPlatformOf,
  teamProblem,
  teamSavePayload,
  emptySlots,
} from './tournamentRules.ts';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const migration = () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const file = fs.readdirSync(dir).find((f) => f.endsWith('_tournaments.sql'));
  return fs.readFileSync(new URL(file, dir), 'utf8');
};
const NOW = Date.parse('2026-09-28T12:00:00Z');
const money = (amount) => ({ kind: 'money', amount });
const PACK = { kind: 'product', optionId: '11111111-2222-4333-8444-555555555555', productName: 'Free Fire', optionLabel: '100 Diamonds', regionLabel: 'MENA', price: 150 };

function goodForm(over = {}) {
  return {
    ...emptyHostForm(),
    game: 'free_fire',
    kind: 'register',
    mode: 'battle_royale',
    name: '  Friday Cup ',
    teamSize: 4,
    teamCount: 8,
    paid: true,
    fee: '50',
    startsAt: new Date(NOW + 24 * 3600_000),
    streamUrl: 'tiktok.com/@streamer',
    rewards: [[money(100), money(100), money(100), PACK]],
    ...over,
  };
}

describe('modes: the app and the database agree', () => {
  it('tournament_modes() in the migration lists exactly MODES', () => {
    const body = migration().match(/function public\.tournament_modes\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/)[1];
    const rows = [...body.matchAll(/\('(\w+)',\s*'(\w+)',\s*(\d+),\s*(\d+)\)/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
    assert.deepEqual(rows, MODES.map((m) => `${m.game}:${m.id}:${m.maxTeamSize}:${m.maxPlayers}`));
  });
  it('the start window and the platform cut are the numbers the database uses', () => {
    assert.match(migration(), /interval '15 minutes', interval '90 days'/);
    assert.equal(START_MIN_LEAD_MS, 15 * 60_000);
    assert.equal(START_MAX_LEAD_MS, 90 * 86_400_000);
    assert.equal(PLATFORM_CUT_PERCENT, 15);
  });
});

describe('the player count always divides evenly', () => {
  const br = modeOf('free_fire', 'battle_royale');
  it('max teams = the room divided by the team size', () => {
    assert.equal(maxTeams(br, 4), 12); // 48 / 4
    assert.equal(maxTeams(br, 3), 16);
    assert.equal(maxTeams(modeOf('pubg_mobile', 'classic'), 4), 25);
  });
  it('a team count is kept between 2 and the max', () => {
    assert.equal(clampTeamCount(1, br, 4), 2);
    assert.equal(clampTeamCount(40, br, 4), 12);
    assert.equal(clampTeamCount(8, br, 4), 8);
  });
  it('places: never more than teams, never more than 10', () => {
    assert.equal(maxPlaces('register', 4), 4);
    assert.equal(maxPlaces('register', 25), 10);
    assert.equal(maxPlaces('live', 2), 10);
  });
});

describe('money and links as typed', () => {
  it('birr: digits with up to 2 decimals, commas allowed', () => {
    assert.equal(parseBirr('50'), 50);
    assert.equal(parseBirr('1,500.50'), 1500.5);
    assert.equal(parseBirr('0'), null);
    assert.equal(parseBirr('0', { allowZero: true }), 0);
    assert.equal(parseBirr('10.555'), null);
    assert.equal(parseBirr('-5'), null);
    assert.equal(parseBirr('abc'), null);
    assert.equal(parseBirr('2000000'), null);
  });
  it('a stream link gets https:// when typed bare; http and junk are refused', () => {
    assert.equal(normalizeStreamUrl('tiktok.com/@me'), 'https://tiktok.com/@me');
    assert.equal(normalizeStreamUrl('  HTTPS://youtube.com/@me '), 'https://youtube.com/@me');
    assert.equal(normalizeStreamUrl('http://tiktok.com/@me'), null);
    assert.equal(normalizeStreamUrl('my channel'), null);
    assert.equal(normalizeStreamUrl('localhost'), null);
    assert.equal(normalizeStreamUrl(''), null);
  });
  it('the platform is read from the address', () => {
    assert.equal(streamPlatformOf('https://www.tiktok.com/@me'), 'tiktok');
    assert.equal(streamPlatformOf('https://vm.tiktok.com/abc'), 'tiktok');
    assert.equal(streamPlatformOf('https://youtu.be/abc'), 'youtube');
    assert.equal(streamPlatformOf('https://m.youtube.com/@me'), 'youtube');
    assert.equal(streamPlatformOf('https://twitch.tv/me'), 'twitch');
    assert.equal(streamPlatformOf('https://notyoutube.com/x'), 'other');
  });
  it('the host sees 85% of a fee', () => {
    assert.equal(hostShareOfFee(50), 42.5);
    assert.equal(hostShareOfFee(100), 85);
  });
});

describe('the reward grid', () => {
  it('resizing keeps what fits and adds empty slots', () => {
    const g = resizeGrid([[money(1), money(2)]], 2, 3);
    assert.deepEqual(g, [[money(1), money(2), null], [null, null, null]]);
    assert.deepEqual(resizeGrid(g, 1, 1), [[money(1)]]);
  });
  it('complete only when every slot of every place is chosen', () => {
    assert.equal(gridComplete([[money(1), null]]), false);
    assert.equal(gridComplete([[money(1), PACK]]), true);
    assert.equal(gridComplete([]), false);
  });
  it('same reward for a whole place; one slot at a time', () => {
    const g = fillPlace([[null, null], [null, null]], 2, money(5));
    assert.deepEqual(g, [[null, null], [money(5), money(5)]]);
    assert.deepEqual(setReward(g, 1, 2, PACK)[0], [null, PACK]);
  });
  it('totals: money summed, products counted at today\'s price', () => {
    assert.deepEqual(rewardTotals([[money(100.5), PACK], [money(50), null]]), { money: 150.5, products: 1, productsPrice: 150 });
  });
});

describe('the form', () => {
  it('a good form builds the exact payload the server takes', () => {
    const built = buildCreatePayload(goodForm(), NOW);
    assert.equal(built.ok, true);
    assert.deepEqual(built.payload, {
      kind: 'register',
      game: 'free_fire',
      mode: 'battle_royale',
      name: 'Friday Cup',
      team_size: 4,
      team_count: 8,
      entry_fee: 50,
      starts_at: new Date(NOW + 24 * 3600_000).toISOString(),
      stream_platform: 'tiktok',
      stream_url: 'https://tiktok.com/@streamer',
      prize_text: null,
      rewards: [
        { place: 1, slot: 1, kind: 'money', amount: 100 },
        { place: 1, slot: 2, kind: 'money', amount: 100 },
        { place: 1, slot: 3, kind: 'money', amount: 100 },
        { place: 1, slot: 4, kind: 'product', option_id: PACK.optionId },
      ],
    });
  });
  it('free = fee 0 whatever was typed; live = no team count, no fee', () => {
    assert.equal(buildCreatePayload(goodForm({ paid: false, fee: 'junk' }), NOW).payload.entry_fee, 0);
    const live = buildCreatePayload(goodForm({ kind: 'live', paid: true, fee: '50', prize: ' 600 UC ' }), NOW).payload;
    assert.equal(live.team_count, null);
    assert.equal(live.entry_fee, 0);
    // A live tournament's prize is text; it has no reward grid and nothing is paid for it.
    assert.equal(live.prize_text, '600 UC');
    assert.deepEqual(live.rewards, []);
  });
  it('each problem is named', () => {
    const p = (over) => detailsProblem(goodForm(over), NOW);
    assert.equal(p({ game: null }), 'game');
    assert.equal(p({ kind: null }), 'kind');
    assert.equal(p({ mode: 'clash_squad', game: 'pubg_mobile' }), 'mode');
    assert.equal(p({ name: 'ab' }), 'name');
    assert.equal(p({ mode: 'lone_wolf', teamSize: 3 }), 'teamSize');
    assert.equal(p({ teamCount: 13 }), 'teamCount');
    assert.equal(p({ fee: '' }), 'fee');
    assert.equal(p({ startsAt: null }), 'startMissing');
    assert.equal(p({ startsAt: new Date(NOW + 5 * 60_000) }), 'startTooSoon');
    assert.equal(p({ startsAt: new Date(NOW + 91 * 86_400_000) }), 'startTooFar');
    assert.equal(p({ streamUrl: 'http://x.com' }), 'streamInvalid');
    assert.equal(p({ kind: 'live', streamUrl: '' }), 'streamRequired');
    assert.equal(p({ kind: 'live', prize: ' x ' }), 'prize');
    assert.equal(p({ kind: 'live', prize: 'Winner gets 500 diamonds' }), null);
    assert.equal(buildCreatePayload(goodForm({ kind: 'live', prize: 'ok prize', rewards: [[null]] }), NOW).ok, true);
    assert.equal(p({ streamUrl: '' }), null);
    assert.equal(buildCreatePayload(goodForm({ rewards: [[money(1), null, null, null]] }), NOW).problem, 'rewards');
    assert.equal(buildCreatePayload(goodForm({ rewards: [[money(1)]] }), NOW).problem, 'rewards');
    assert.equal(buildCreatePayload(goodForm({ teamCount: 2, rewards: [[PACK, PACK, PACK, PACK], [PACK, PACK, PACK, PACK], [PACK, PACK, PACK, PACK]] }), NOW).problem, 'rewards');
  });
});

describe('reading', () => {
  it('phase: cancelled / finished win, else by the clock', () => {
    const later = new Date(NOW + 60_000).toISOString();
    const earlier = new Date(NOW - 60_000).toISOString();
    assert.equal(phaseOf('published', later, NOW), 'upcoming');
    assert.equal(phaseOf('published', earlier, NOW), 'started');
    assert.equal(phaseOf('cancelled', later, NOW), 'cancelled');
    assert.equal(phaseOf('finished', earlier, NOW), 'finished');
  });
  it('countdown in minutes, hours (under 2 days), then days', () => {
    const at = (ms) => new Date(NOW + ms).toISOString();
    assert.deepEqual(countdown(at(90_000), NOW), { unit: 'min', n: 2 });
    assert.deepEqual(countdown(at(5 * 3600_000), NOW), { unit: 'hour', n: 5 });
    assert.deepEqual(countdown(at(47 * 3600_000), NOW), { unit: 'hour', n: 47 });
    assert.deepEqual(countdown(at(3 * 86_400_000), NOW), { unit: 'day', n: 3 });
    assert.equal(countdown(at(-1), NOW), null);
  });
  it('server refusals are recognised from the error message', () => {
    assert.equal(serverErrorOf({ message: 'too_many_tournaments' }), 'too_many_tournaments');
    assert.equal(serverErrorOf({ message: 'something else' }), null);
    assert.equal(serverErrorOf(null), null);
  });
});

describe('teams', () => {
  const CAP = { id: 'c1', name: 'Abel', avatarUrl: null };
  const done = (slot, userId, gameId) => ({ slot, userId, name: 'x', avatarUrl: null, gameId, validationId: `v${slot}`, checkedGameId: gameId, playerName: 'P' });
  it('slot 1 is the captain; the rest start empty', () => {
    const s = emptySlots(3, CAP);
    assert.equal(s.length, 3);
    assert.equal(s[0].userId, 'c1');
    assert.equal(s[1].userId, null);
  });
  it('a slot counts as checked only while the typed ID is the one that was checked', () => {
    assert.equal(slotVerified(done(2, 'u2', '123')), true);
    assert.equal(slotVerified({ ...done(2, 'u2', '123'), gameId: '124' }), false);
    assert.equal(slotVerified({ ...done(2, null, '123') }), false);
  });
  it('the draft sends only people and checked IDs (never an unchecked ID)', () => {
    const slots = [done(1, 'c1', '111'), { ...done(2, 'u2', '222'), gameId: '999' }, { ...emptySlots(3, CAP)[2] }];
    assert.deepEqual(teamSavePayload('  Wolves ', slots), {
      name: 'Wolves',
      members: [
        { slot: 1, user_id: null, game_id: '111', validation_id: 'v1' },
        { slot: 2, user_id: 'u2', game_id: null, validation_id: null },
      ],
    });
  });
  it('Register is possible only with a name, every player and every ID checked, no repeats', () => {
    const full = [done(1, 'c1', '111'), done(2, 'u2', '222')];
    assert.equal(teamProblem('Wolves', full), null);
    assert.equal(teamProblem('W', full), 'teamName');
    assert.equal(teamProblem('Wolves', [full[0], { ...full[1], gameId: '' }]), 'teamIncomplete');
    assert.equal(teamProblem('Wolves', [full[0], done(2, 'c1', '222')]), 'duplicatePlayer');
    assert.equal(teamProblem('Wolves', [full[0], done(2, 'u2', '111')]), 'duplicateGameId');
  });
});

describe('source guards', () => {
  it('only content creators see the host button, and the host screen sends others away', () => {
    assert.match(src('../app/tournaments.tsx'), /isContentCreator && \(/);
    assert.match(src('../app/tournament/host.tsx'), /!isContentCreator\) return <Redirect href="\/tournaments" \/>/);
  });
  it('publishing asks first and cannot be sent twice', () => {
    const host = src('../app/tournament/host.tsx');
    assert.match(host, /confirmDestructive\(\s*t\('tournament.host.publishTitle'\)/);
    assert.match(host, /if \(publishingRef.current\) return;/);
  });
  it('registering a team asks first, cannot be sent twice, and only sends checked IDs', () => {
    const team = src('../app/tournament/team/[id].tsx');
    assert.match(team, /confirmDestructive\(\s*t\('tournament.team.confirmTitle'\)/);
    assert.match(team, /if \(working.current\) return;/);
    assert.match(team, /teamSavePayload\(name, slots\)/);
    assert.match(team, /validateId\(check.regionId/);
  });
  it('the app never reads the tournament tables directly (functions only)', () => {
    const lib = src('./tournaments.ts');
    assert.doesNotMatch(lib, /from\('tournament/);
  });
});
