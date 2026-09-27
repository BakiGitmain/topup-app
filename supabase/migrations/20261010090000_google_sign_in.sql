-- Google Sign-In: handle_new_user() already fires for ANY new auth.users row (after insert, no provider check),
-- so the wallet/Portal Coin/profile creation this app already does on first sign-up needs no change to run for a
-- Google account too -- confirmed by reading the trigger, not assumed. The one real gap: a Google sign-in never
-- runs this app's own signup form, so raw_user_meta_data has no 'display_name' key, and handle_new_user() already
-- falls back to the email's local part so display_name is never blank -- but that auto-derived name must not be
-- mistaken for one the customer actually chose. needs_username marks exactly that distinction, provider-agnostic:
-- true only when no real display_name was supplied at signup, whatever the provider.
--
-- Not backfilled for existing profiles (default false covers every current row): flagging an existing, happily-
-- using account for "choose a username" on its next login would be a real, unwanted behavior change for people
-- who never asked for it. This only ever applies to accounts created from this migration forward.

alter table public.profiles add column if not exists needs_username boolean not null default false;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_name text := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
begin
  insert into public.profiles (id, display_name, email, needs_username)
  values (
    new.id,
    coalesce(v_display_name, split_part(coalesce(new.email, ''), '@', 1)),
    new.email,
    v_display_name is null
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Finishes the "choose a username" step: sets a real display_name and clears needs_username in one validated
-- call, same length rule (2-40 chars) the sign-up form already enforces client-side -- enforced here too, since a
-- Google account never goes through that form. The existing `grant update (display_name, ...)` to `authenticated`
-- already lets a customer edit their own name from Profile; this is a separate, narrower path only for finishing
-- the one-time step (it also clears needs_username, which that broader grant does not cover).
create or replace function public.complete_username(p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := trim(coalesce(p_display_name, ''));
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if length(v_name) < 2 or length(v_name) > 40 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  update public.profiles
     set display_name = v_name,
         needs_username = false
   where id = auth.uid()
  returning * into v_profile;

  if not found then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  return v_profile;
end;
$$;

revoke all on function public.complete_username(text) from public, anon;
grant execute on function public.complete_username(text) to authenticated;
