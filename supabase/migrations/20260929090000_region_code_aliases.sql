-- topup: account region aliases. Part of the "ID check says ME, packs say MENA" fix. Safe to re-run.
--
-- THE BUG: a region-locked pack sells only if the account region the supplier's ID check returned is one of the pack's
-- `account_region_codes`, compared as exact text. The ID check returns short game codes (observed live for Free Fire: ME,
-- BR, ID, IND; PUBG Mobile reports none). The five live MENA packs had been saved with the code "MENA", the supplier's
-- LABEL for the region, which the ID check never returns. So "ME" never matched "MENA": every MENA pack said "Not for
-- your account's region", in the app and in the database.
--
-- THE FIX, in two parts (no purchase or checkout function is changed, so both keep comparing exact text):
--   1. A small mapping table, account_region_aliases (alias -> the code the ID check uses). It is seeded with ONE row,
--      MENA -> ME, because that is the only mapping confirmed with real accounts. No other alias is invented; an admin
--      can add more (see the end of this file).
--   2. Codes are translated through that table WHEN THEY ARE SAVED: the existing trigger that already trims, upper-cases and
--      de-duplicates a pack's codes now maps aliases too (so typing "mena", "MENA" or "ME" all store "ME"), and the same
--      happens to the region a validation record stores. Stored data therefore always speaks the ID check's vocabulary.
--   3. The existing packs are fixed by re-saving their codes once.
--
-- WHO CAN DO WHAT: any signed-in user can read the alias table (it holds nothing secret); only admins can change it.
-- NOT CHANGED: the LATAM packs, which are saved with the code NA. Nothing here proves what the ID check returns for a LATAM
-- account (BR was observed once), so it is left as it is until you say which codes it should carry.

create table if not exists public.account_region_aliases (
  alias text primary key check (alias ~ '^[A-Z0-9_-]{1,16}$'),
  code  text not null check (code ~ '^[A-Z0-9_-]{1,16}$'),
  constraint account_region_aliases_not_self check (alias <> code)
);

-- One step only: an alias may not point at another alias, and a code may not also be an alias (no chains, no loops).
create or replace function public.account_region_aliases_no_chains()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.account_region_aliases a where a.alias = new.code and a.alias <> new.alias)
     or exists (select 1 from public.account_region_aliases a where a.code = new.alias and a.alias <> new.alias) then
    raise exception 'region_alias_chain' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists account_region_aliases_no_chains on public.account_region_aliases;
create trigger account_region_aliases_no_chains
  before insert or update on public.account_region_aliases
  for each row execute function public.account_region_aliases_no_chains();

alter table public.account_region_aliases enable row level security;
drop policy if exists account_region_aliases_select on public.account_region_aliases;
create policy account_region_aliases_select on public.account_region_aliases
  for select to authenticated using (true);
drop policy if exists account_region_aliases_admin_write on public.account_region_aliases;
create policy account_region_aliases_admin_write on public.account_region_aliases
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.account_region_aliases from anon, authenticated;
grant select, insert, update, delete on public.account_region_aliases to authenticated;

-- The one confirmed mapping (see CLAUDE.md: MENA = the ME accounts).
insert into public.account_region_aliases (alias, code) values ('MENA', 'ME')
on conflict (alias) do nothing;

-- "mena " -> "ME"; "br" -> "BR"; anything without an alias just comes back trimmed and upper-cased. Null stays null.
create or replace function public.canonical_region_code(p_code text)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select a.code from public.account_region_aliases a where a.alias = upper(btrim(p_code))),
    upper(btrim(p_code))
  );
$$;

-- The existing pack-code trigger (20260923090000), now alias-aware. Still trims, upper-cases, de-duplicates and sorts.
create or replace function public.normalize_option_region_codes()
returns trigger
language plpgsql
as $$
begin
  new.account_region_codes := coalesce(
    (select array_agg(distinct public.canonical_region_code(c) order by public.canonical_region_code(c))
       from unnest(new.account_region_codes) c),
    '{}'
  );
  return new;
end;
$$;

-- A validation record stores the account's region in the same vocabulary, so both sides of the comparison agree.
create or replace function public.normalize_validation_region()
returns trigger
language plpgsql
as $$
begin
  new.account_region := public.canonical_region_code(new.account_region);
  return new;
end;
$$;

drop trigger if exists id_validations_region_normalize on public.id_validations;
create trigger id_validations_region_normalize
  before insert on public.id_validations
  for each row execute function public.normalize_validation_region();

-- Fix the packs that were saved with a label instead of a code. Re-saving the codes runs the trigger above.
update public.product_options
   set account_region_codes = account_region_codes
 where exists (
   select 1 from unnest(account_region_codes) c where public.canonical_region_code(c) is distinct from c
 );

-- To add another mapping later, once you have SEEN what the ID check returns for that region (SQL editor):
--   insert into public.account_region_aliases (alias, code) values ('<what an admin might type>', '<what the ID check returns>');
-- and then re-save the affected packs' codes.
