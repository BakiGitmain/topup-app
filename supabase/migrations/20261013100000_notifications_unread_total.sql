-- my_notifications(): return the true unread total, and list unread before read.
--
-- Found live (2026-09-27): with more unread notifications than one list holds (the default limit is 100), the badge
-- could only count what the list returned, and after the panel marked those 100 seen the remaining older unread
-- ones were never returned again -- so they could never be seen, and the badge read 0 while they were still unread.
--   * unread_total: counted over everything visible BEFORE the limit (a window count), so the badge is right even
--     past 100 (and it shows "99+" there anyway).
--   * order: unread first (newest first within), then read (newest first). Whatever is unread is always in the list,
--     so opening the panel always reaches it.
-- The return type changes, which CREATE OR REPLACE can't do, so the old function is dropped first.

drop function if exists public.my_notifications(integer);

create function public.my_notifications(p_limit integer default 100)
returns table (id uuid, type text, title text, body text, data jsonb, created_at timestamptz, seen boolean, unread_total bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  delete from public.notifications n where n.created_at < now() - public.notification_ttl();

  return query
    select v.id, v.type, v.title, v.body, v.data, v.created_at, v.seen, v.unread_total
      from (
        select n.id, n.type, n.title, n.body, n.data, n.created_at,
               (s.notification_id is not null) as seen,
               count(*) filter (where s.notification_id is null) over () as unread_total
          from public.notifications n
          left join public.notification_seen s on s.notification_id = n.id and s.user_id = auth.uid()
         where (n.user_id is null or n.user_id = auth.uid())
           and n.created_at >= now() - public.notification_ttl()
      ) v
     order by v.seen, v.created_at desc, v.id
     limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

revoke all on function public.my_notifications(integer) from public, anon;
grant execute on function public.my_notifications(integer) to authenticated;
