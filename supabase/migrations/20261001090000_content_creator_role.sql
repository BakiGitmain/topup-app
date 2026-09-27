-- topup: content creators. Part 1 of the discount-code/Portal-Coin/creator-commission feature set.
--
-- A content creator is orthogonal to role ('user'/'admin'), not a replacement for it: a creator keeps shopping
-- normally (their own wallet, untouched) and is not an admin. A plain boolean on profiles, not a third role value,
-- so nothing that already reads `role` needs to change.

alter table public.profiles add column if not exists is_content_creator boolean not null default false;

create index if not exists profiles_content_creator_idx on public.profiles (id) where is_content_creator;

create or replace function public.admin_set_content_creator(
  p_user_id uuid,
  p_value   boolean
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_value is null then
    raise exception 'invalid_value' using errcode = '22023';
  end if;

  update public.profiles set is_content_creator = p_value where id = p_user_id
  returning * into v_profile;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  return v_profile;
end;
$$;

revoke all on function public.admin_set_content_creator(uuid, boolean) from public, anon;
grant execute on function public.admin_set_content_creator(uuid, boolean) to authenticated;
