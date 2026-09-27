// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { AVATAR_BUCKET, AVATAR_MAX_SIDE, staleAvatarPaths } from './avatarPaths.ts';

const U = '5f0c3b2e-1111-4222-8333-444455556666';

describe('staleAvatarPaths: nothing orphans when a picture is replaced', () => {
  it('removes every other file in the user folder, keeps the new one', () => {
    assert.deepEqual(staleAvatarPaths(U, ['old-a.jpg', 'new.jpg', 'old-b.jpg'], `${U}/new.jpg`), [`${U}/old-a.jpg`, `${U}/old-b.jpg`]);
  });
  it('first upload: nothing to remove', () => {
    assert.deepEqual(staleAvatarPaths(U, ['new.jpg'], `${U}/new.jpg`), []);
  });
  it('never produces a path outside the user folder, and skips storage placeholders and nested names', () => {
    const out = staleAvatarPaths(U, ['../other/x.jpg', 'sub/y.jpg', '.emptyFolderPlaceholder', '', 'z.jpg'], `${U}/new.jpg`);
    assert.deepEqual(out, [`${U}/z.jpg`]);
  });
  it('no user id -> nothing', () => {
    assert.deepEqual(staleAvatarPaths('', ['a.jpg'], 'a.jpg'), []);
  });
});

describe('avatars reuse the artwork upload path (never a from-scratch one)', () => {
  const root = new URL('../../', import.meta.url);
  const avatar = fs.readFileSync(new URL('src/lib/avatar.ts', root), 'utf8');
  it('goes through prepareArtwork and uploadArtwork', () => {
    assert.match(avatar, /prepareArtwork\(picked, AVATAR_MAX_SIDE\)/);
    assert.match(avatar, /uploadArtwork\(art, AVATAR_BUCKET, userId\)/);
  });
  it('never reads the picked image back from a file (the "File not found" bug)', () => {
    assert.ok(!/fetch\(/.test(avatar), 'no fetch() of a file uri');
    assert.ok(!/readAsStringAsync|FileSystem/.test(avatar), 'no file-system read');
  });
  it('points the profile at the new file BEFORE removing old ones', () => {
    assert.ok(avatar.indexOf("update({ avatar_url: url })") < avatar.indexOf('staleAvatarPaths('));
  });
  it('small, JPEG-only bucket settings match the migration', () => {
    assert.equal(AVATAR_BUCKET, 'avatars');
    assert.equal(AVATAR_MAX_SIDE, 512);
    const sql = fs.readFileSync(new URL('supabase/migrations/20261011090000_avatars_bucket.sql', root), 'utf8');
    assert.match(sql, /'avatars', 'avatars', true, 2097152, array\['image\/jpeg'\]/);
    for (const op of ['insert', 'update', 'delete']) {
      assert.match(sql, new RegExp(`avatars_own_${op}[\\s\\S]*?\\(storage\\.foldername\\(name\\)\\)\\[1\\] = \\(select auth\\.uid\\(\\)\\)::text`), op);
    }
  });
});
