-- Does the signed-in account have a password?
--
-- The Account screen needs this to show "Change password" vs "Add a password". It cannot be read from the user's
-- identities: verified live (2026-09-26) that when a Google-only account sets a password with updateUser(), Supabase
-- stores the password but adds NO 'email' identity -- identities and app_metadata.providers stay ["google"] -- even
-- though email + password sign-in then works. The only reliable source is auth.users.encrypted_password, which the
-- client cannot read.
--
-- Returns a boolean for the CALLER's own account only (auth.uid()); it never returns or exposes the hash, and it
-- takes no argument, so it can't be pointed at anyone else. false when signed out.
--
-- plpgsql rather than sql on purpose: a sql function's body is checked against auth.users when it's created, and
-- the in-process test database's stub of auth.users has no encrypted_password column.

create or replace function public.my_account_has_password()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_has boolean;
begin
  select coalesce(u.encrypted_password, '') <> ''
    into v_has
    from auth.users u
   where u.id = auth.uid();
  return coalesce(v_has, false);
end;
$$;

revoke all on function public.my_account_has_password() from public, anon;
grant execute on function public.my_account_has_password() to authenticated;
