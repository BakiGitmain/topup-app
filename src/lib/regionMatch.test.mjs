// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fs from 'node:fs';

import { REGION_ALIASES, judgePackage, normalizeRegionCode, packageAllowsPurchase, suggestRegion } from './regionMatch.ts';

// Free Fire launch: MENA diamonds serve ME accounts. Other locked packages serve other accounts.
const ME_PACK = { regionLocked: true, accountRegionCodes: ['ME'] };
const BR_PACK = { regionLocked: true, accountRegionCodes: ['BR'] };
const SEA_PACK = { regionLocked: true, accountRegionCodes: ['SG', 'MY', 'PH'] };
const OPEN_PACK = { regionLocked: false, accountRegionCodes: [] };
const UNCONFIGURED = { regionLocked: true, accountRegionCodes: [] };

describe('the ID check says "ME" but a pack was saved as "MENA" (the bug)', () => {
  const mena = { regionLocked: true, accountRegionCodes: ['MENA'] };
  it('an ME account matches a pack saved with the label MENA', () => {
    assert.deepEqual(judgePackage(mena, 'ME'), { status: 'match' });
    assert.equal(packageAllowsPurchase(judgePackage(mena, 'ME')), true);
    assert.deepEqual(judgePackage({ regionLocked: true, accountRegionCodes: [' mena '] }, ' me '), { status: 'match' });
  });
  it('...and other regions are still refused', () => {
    for (const other of ['BR', 'ID', 'IND', 'SG']) assert.deepEqual(judgePackage(mena, other), { status: 'mismatch', account: other });
    assert.equal(judgePackage(mena, null).status, 'unverified');
  });
  it('the region chip suggestion follows: an ME account is pointed at the MENA chip', () => {
    const regions = [{ id: 'mena', label: 'MENA', packages: [mena] }, { id: 'br', label: 'BR', packages: [{ regionLocked: true, accountRegionCodes: ['BR'] }] }];
    assert.equal(suggestRegion(regions, 'br', 'ME').kind, 'switch');
    assert.equal(suggestRegion(regions, 'mena', 'ME').kind, 'keep');
  });
  it('nothing else is guessed: LATAM, NA and unknown labels are left exactly as they are', () => {
    for (const v of ['LATAM', 'NA', 'EU', 'CIS']) assert.equal(normalizeRegionCode(v), v);
  });
  it('the alias table here is IDENTICAL to the one the migration seeds', () => {
    const sql = fs.readFileSync(new URL('../../supabase/migrations/20260929090000_region_code_aliases.sql', import.meta.url), 'utf8');
    const seeded = [...sql.matchAll(/insert into public\.account_region_aliases \(alias, code\) values \('([A-Z0-9_-]+)', '([A-Z0-9_-]+)'\)/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(Object.fromEntries(seeded), { ...REGION_ALIASES });
  });
});

describe('normalizeRegionCode', () => {
  it('trims and upper-cases', () => {
    assert.equal(normalizeRegionCode(' me '), 'ME');
    assert.equal(normalizeRegionCode('sea'), 'SEA');
  });
  it('rejects anything that is not a short plain code', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, [], 'has space', 'x'.repeat(17), 'a;b', '<script>']) {
      assert.equal(normalizeRegionCode(v), null, String(v));
    }
  });
});

describe('judgePackage', () => {
  it('a package that is not region-locked is open to every account, known or not', () => {
    for (const acc of ['ME', 'BR', null, undefined, '', 42]) assert.equal(judgePackage(OPEN_PACK, acc).status, 'open', String(acc));
  });
  it('a locked package matches an account in one of its regions', () => {
    assert.equal(judgePackage(ME_PACK, 'ME').status, 'match');
    for (const c of ['SG', 'MY', 'PH']) assert.equal(judgePackage(SEA_PACK, c).status, 'match', c);
  });
  it('matching ignores case and stray spaces from the supplier', () => {
    assert.equal(judgePackage(ME_PACK, ' me ').status, 'match');
    assert.equal(judgePackage({ regionLocked: true, accountRegionCodes: [' me'] }, 'ME').status, 'match');
  });
  it('a locked package does NOT serve an account from another region', () => {
    const v = judgePackage(BR_PACK, 'ME');
    assert.equal(v.status, 'mismatch');
    assert.equal(v.account, 'ME');
  });
  it('the same account can be right for one package and wrong for another in the SAME product', () => {
    assert.equal(judgePackage(ME_PACK, 'ME').status, 'match');
    assert.equal(judgePackage(BR_PACK, 'ME').status, 'mismatch');
    assert.equal(judgePackage(OPEN_PACK, 'ME').status, 'open');
  });
  it('never guesses: a locked package with no account region is unverified', () => {
    for (const r of [undefined, null, '', '  ', 123, {}]) {
      const v = judgePackage(ME_PACK, r);
      assert.equal(v.status, 'unverified', String(r));
      assert.equal(v.reason, 'no_account_region');
    }
  });
  it('a locked package with no codes is unavailable, even for a known account', () => {
    for (const acc of ['ME', null]) {
      const v = judgePackage(UNCONFIGURED, acc);
      assert.equal(v.status, 'unavailable');
      assert.equal(v.reason, 'no_codes');
    }
  });
  it('junk codes do not count as configured', () => {
    assert.equal(judgePackage({ regionLocked: true, accountRegionCodes: ['has space', ''] }, 'ME').status, 'unavailable');
  });
});

describe('packageAllowsPurchase: the guard against the wrong region', () => {
  it('open and match are allowed', () => {
    assert.equal(packageAllowsPurchase(judgePackage(OPEN_PACK, 'ME')), true);
    assert.equal(packageAllowsPurchase(judgePackage(OPEN_PACK, null)), true);
    assert.equal(packageAllowsPurchase(judgePackage(ME_PACK, 'ME')), true);
  });
  it('a locked package is NOT sold when the account region is unknown (the database refuses it too)', () => {
    assert.equal(packageAllowsPurchase(judgePackage(ME_PACK, null)), false);
    assert.equal(packageAllowsPurchase(judgePackage(ME_PACK, '')), false);
  });
  it('mismatch and unavailable are NOT allowed', () => {
    assert.equal(packageAllowsPurchase(judgePackage(BR_PACK, 'ME')), false);
    assert.equal(packageAllowsPurchase(judgePackage(UNCONFIGURED, 'ME')), false);
    assert.equal(packageAllowsPurchase(judgePackage(UNCONFIGURED, null)), false);
  });
  it('every package x account combination gets a decision', () => {
    for (const p of [ME_PACK, BR_PACK, SEA_PACK, OPEN_PACK, UNCONFIGURED]) {
      for (const acc of [null, 'ME', 'BR', 'SG', 'TR', ' me', 42]) {
        const v = judgePackage(p, acc);
        assert.ok(['open', 'match', 'mismatch', 'unverified', 'unavailable'].includes(v.status));
        assert.equal(typeof packageAllowsPurchase(v), 'boolean');
      }
    }
  });
});

describe('suggestRegion (which chip fits this account)', () => {
  const MENA = { id: 'r-mena', label: 'MENA', packages: [ME_PACK, ME_PACK] };
  const BRAZIL = { id: 'r-br', label: 'Brazil', packages: [BR_PACK] };
  const SEA = { id: 'r-sea', label: 'SEA', packages: [SEA_PACK] };
  const ALL = [MENA, BRAZIL, SEA];

  it('unknown account region -> no suggestion', () => {
    for (const r of [null, undefined, '', '  ', 5]) assert.equal(suggestRegion(ALL, 'r-br', r).kind, 'unknown');
  });
  it('the launch case: a single MENA region with an ME account keeps it', () => {
    assert.equal(suggestRegion([MENA], 'r-mena', 'ME').kind, 'keep');
    assert.equal(suggestRegion([MENA], null, 'ME').kind, 'switch');
  });
  it('selected region already serves the account -> keep', () => {
    assert.equal(suggestRegion(ALL, 'r-mena', 'ME').kind, 'keep');
  });
  it('a different region is selected -> switch to the one that serves it', () => {
    const s = suggestRegion(ALL, 'r-br', 'ME');
    assert.equal(s.kind, 'switch');
    assert.equal(s.region.id, 'r-mena');
  });
  it('nothing selected yet -> switch (so the UI can auto-select the chip)', () => {
    assert.equal(suggestRegion(ALL, null, 'MY').region.id, 'r-sea');
  });
  it('an account from a region no package serves -> not_carried', () => {
    const s = suggestRegion(ALL, 'r-mena', 'TR');
    assert.equal(s.kind, 'not_carried');
    assert.equal(s.account, 'TR');
  });
  it('two regions serve the account and the selection is neither -> the customer chooses, no guess', () => {
    const also = { id: 'r-me2', label: 'ME2', packages: [ME_PACK] };
    const s = suggestRegion([MENA, also, BRAZIL], 'r-br', 'ME');
    assert.equal(s.kind, 'choose');
    assert.deepEqual(s.regions.map((r) => r.id), ['r-mena', 'r-me2']);
  });
  it('two regions serve it and one is selected -> keep', () => {
    const also = { id: 'r-me2', label: 'ME2', packages: [ME_PACK] };
    assert.equal(suggestRegion([MENA, also], 'r-me2', 'ME').kind, 'keep');
  });
  it('a region that only has open packages is not "for" the account', () => {
    const global = { id: 'r-glob', label: 'Global', packages: [OPEN_PACK] };
    assert.equal(suggestRegion([global, MENA], null, 'ME').region.id, 'r-mena');
  });
  it('a product with no locked packages gives no region guidance', () => {
    assert.equal(suggestRegion([{ id: 'g', label: 'G', packages: [OPEN_PACK] }], 'g', 'ME').kind, 'unknown');
  });
  it('unconfigured locked packages never make a region "fit"', () => {
    const bare = { id: 'r-bare', label: 'Bare', packages: [UNCONFIGURED] };
    assert.equal(suggestRegion([bare], 'r-bare', 'ME').kind, 'not_carried');
  });
});
