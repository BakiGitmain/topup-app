// Google Sign-In support: handle_new_user() already fires for any new auth.users row regardless of provider (no
// change needed there for wallet/Portal Coin/profile creation to also cover a Google account -- proven here by
// creating a user with no display_name metadata, the exact shape a Google sign-in leaves, and checking every
// first-sign-up side effect still happens). needs_username marks only the real gap: no display_name was supplied
// at signup, so the trigger's own email-prefix fallback must not be mistaken for a chosen name.
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
async function rejects(n, role, uid, sql, re, params) {
  try { await as(role, uid, sql, params); fail++; console.log('  FAIL', n, '(no error)'); }
  catch (e) { const g = re.test(e.message + ' ' + (e.detail ?? '')); if (g) pass++; else fail++; console.log(g ? '  PASS' : '  FAIL', n, g ? '' : `-> ${e.message}`); }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

for (const m of MIGRATIONS) await db.exec(m);
for (const m of MIGRATIONS) await db.exec(m); // re-runnable

// ------------------------------------------------------------------ fixtures
const mkUserNoMeta = async (email) => (await one(`insert into auth.users (email) values ($1) returning id`, [email])).id;
const mkUserWithName = async (email, name) =>
  (await one(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ display_name: name })])).id;
const profileOf = async (id) => one(`select display_name, needs_username from profiles where id = $1`, [id]);
const walletOf = async (id) => one(`select balance from wallets where user_id = $1`, [id]);
const coinOf = async (id) => one(`select balance from portal_coin_balances where user_id = $1`, [id]);

// =================================================================================================
console.log('\n# a Google-shaped sign-up (no display_name metadata) gets every first-sign-up side effect');
{
  const u = await mkUserNoMeta('googleuser@x.com');
  const p = await profileOf(u);
  ok('profile row exists', !!p);
  ok('display_name falls back to the email prefix', p.display_name === 'googleuser', p.display_name);
  ok('needs_username is true: no real name was chosen', p.needs_username === true);
  ok('a wallet row exists (same trigger chain as email signup)', !!(await walletOf(u)));
  ok('a Portal Coin balance row exists (same trigger chain as email signup)', !!(await coinOf(u)));
}

// =================================================================================================
console.log('\n# an email sign-up (real display_name metadata, as this app\'s own form sends) is unaffected');
{
  const u = await mkUserWithName('emailuser@x.com', 'Abebe K');
  const p = await profileOf(u);
  ok('display_name is the one actually given, not the email prefix', p.display_name === 'Abebe K', p.display_name);
  ok('needs_username is false: a real name was chosen at signup', p.needs_username === false);
}

// =================================================================================================
console.log('\n# complete_username finishes the step: sets the name and clears needs_username together');
{
  const u = await mkUserNoMeta('finishme@x.com');
  ok('starts needing a username', (await profileOf(u)).needs_username === true);
  const result = await as('authenticated', u, `select * from complete_username($1)`, ['Real Name']);
  ok('returns the updated row', result.rows[0].display_name === 'Real Name');
  const p = await profileOf(u);
  ok('display_name is now the chosen one', p.display_name === 'Real Name', p.display_name);
  ok('needs_username is cleared', p.needs_username === false);
}

// =================================================================================================
console.log('\n# complete_username validates and authenticates, same rigor as the sign-up form');
{
  const u = await mkUserNoMeta('badnames@x.com');
  await rejects('a one-character name is refused', 'authenticated', u, `select complete_username($1)`, /invalid_name/, ['A']);
  await rejects('a 41-character name is refused', 'authenticated', u, `select complete_username($1)`, /invalid_name/, ['A'.repeat(41)]);
  await rejects('an unauthenticated call is refused', 'authenticated', null, `select complete_username($1)`, /not_authenticated/, ['Someone']);
  // Untouched by the two refusals above.
  ok('still needs a username after the refused attempts', (await profileOf(u)).needs_username === true);
}

// =================================================================================================
console.log('\n# an existing (pre-migration-shaped) profile is never retroactively flagged');
{
  // Simulates a profile that predates this migration: needs_username defaults to false for every row the
  // "add column ... default false" itself doesn't touch, so a plain existing profile stays exactly as it was.
  const u = await mkUserWithName('longtimeuser@x.com', 'Long Timer');
  ok('an ordinary email account is never asked to choose a username', (await profileOf(u)).needs_username === false);
}

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
