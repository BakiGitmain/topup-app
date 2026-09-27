-- In-app notifications: a bell in the shop header with a live unread count.
--
-- Two tables, built so the next notification type needs no schema change:
--   notifications      one row per notification. `type` is an open string ('discount' today; 'order_delivered' or
--                      anything else later is just a new value). `user_id` null = every customer (a broadcast), set =
--                      one customer only. `data` carries the type's own details (the code, the percent...), so the
--                      app can render each type in the customer's language; `title`/`body` are the plain-text version
--                      (the fallback for a type the app doesn't know yet, and what a future push would send).
--   notification_seen  per-user read state (user, notification, when). Works the same for broadcast and targeted rows.
--
-- Expiry (3 days) needs no scheduler: this project has no pg_cron (checked live, 2026-09-27), so reads simply ignore
-- anything older than notification_ttl(), and my_notifications() deletes those rows (and, by cascade, their seen
-- rows) every time anyone opens their notifications.
--
-- Who writes: nobody directly. Only SECURITY DEFINER code inserts -- today the discount-code trigger below. Customers
-- read through RLS (the same policy Supabase Realtime applies to live inserts) and mark rows seen through
-- mark_notifications_seen().
--
-- Future push: like admin_notifications (the Telegram outbox), a notifications row is written in the same
-- transaction as the event that caused it. A push sender can later be a consumer of this table (a Database Webhook /
-- Realtime listener, or an outbox-style `pushed_at` column added then) without changing anything here.

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  -- Format only (lowercase word), not a fixed list: a new type is a new value, not a migration.
  type        text not null check (type ~ '^[a-z][a-z0-9_]{0,39}$'),
  title       text not null check (length(title) between 1 and 120),
  body        text not null check (length(body) between 1 and 500),
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  -- null = broadcast to every customer; set = only this user.
  user_id     uuid references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_created_at_idx on public.notifications (created_at desc);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc) where user_id is not null;

create table if not exists public.notification_seen (
  user_id          uuid not null references public.profiles (id) on delete cascade,
  notification_id  uuid not null references public.notifications (id) on delete cascade,
  seen_at          timestamptz not null default now(),
  primary key (user_id, notification_id)
);

alter table public.notifications enable row level security;
alter table public.notification_seen enable row level security;

revoke all on public.notifications from anon, authenticated;
revoke all on public.notification_seen from anon, authenticated;
grant select on public.notifications to authenticated;
grant select on public.notification_seen to authenticated;

-- Broadcasts plus your own targeted rows. Supabase Realtime checks this same policy before delivering an insert.
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for select to authenticated
  using (user_id is null or user_id = (select auth.uid()));

drop policy if exists notification_seen_read on public.notification_seen;
create policy notification_seen_read on public.notification_seen
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The one place the 3-day lifetime lives.
create or replace function public.notification_ttl()
returns interval
language sql
immutable
as $$ select interval '3 days' $$;

-- The caller's notifications, newest first, each with whether they've seen it. Expired rows are deleted here first
-- (opportunistic cleanup instead of a scheduled job). The limit (default 100) is more than the badge ever needs: it
-- shows "99+" beyond 99.
-- (Superseded by 20261013100000, which changes the return type. Dropped first so replaying every migration in order
-- -- as the test database does -- still works once that later version exists.)
drop function if exists public.my_notifications(integer);
create function public.my_notifications(p_limit integer default 100)
returns table (id uuid, type text, title text, body text, data jsonb, created_at timestamptz, seen boolean)
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
    select n.id, n.type, n.title, n.body, n.data, n.created_at, (s.notification_id is not null)
      from public.notifications n
      left join public.notification_seen s on s.notification_id = n.id and s.user_id = auth.uid()
     where (n.user_id is null or n.user_id = auth.uid())
       and n.created_at >= now() - public.notification_ttl()
     order by n.created_at desc, n.id
     limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

-- Marks notifications seen for the caller. Only ids the caller can actually see (and that haven't expired) count;
-- anything else is silently skipped, and marking twice is harmless. Returns how many were newly marked.
create or replace function public.mark_notifications_seen(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if coalesce(array_length(p_ids, 1), 0) > 200 then
    raise exception 'too_many_ids' using errcode = '22023';
  end if;

  insert into public.notification_seen (user_id, notification_id)
  select auth.uid(), n.id
    from public.notifications n
   where n.id = any (coalesce(p_ids, '{}'))
     and (n.user_id is null or n.user_id = auth.uid())
     and n.created_at >= now() - public.notification_ttl()
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.my_notifications(integer) from public, anon;
revoke all on function public.mark_notifications_seen(uuid[]) from public, anon;
grant execute on function public.my_notifications(integer) to authenticated;
grant execute on function public.mark_notifications_seen(uuid[]) to authenticated;

-- Trigger point #1: a discount code that becomes active (created active, or switched from off to on) is announced to
-- every customer. Switching an already-active code's other fields, or turning it off, announces nothing; so does
-- activating a code that has already expired.
create or replace function public.notify_discount_code_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.active then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.active then
    return new;
  end if;
  if new.expires_at is not null and new.expires_at <= now() then
    return new;
  end if;

  insert into public.notifications (type, title, body, data)
  values (
    'discount',
    'New discount available',
    format('Use code %s for %s%% off', new.code, trim_scale(new.discount_percent)),
    jsonb_build_object(
      'discount_code', new.code,
      'discount_percent', trim_scale(new.discount_percent),
      'discount_code_id', new.id,
      'expires_at', new.expires_at
    )
  );
  return new;
end;
$$;
revoke all on function public.notify_discount_code_active() from public, anon, authenticated;

drop trigger if exists discount_codes_notify on public.discount_codes;
create trigger discount_codes_notify
  after insert or update of active on public.discount_codes
  for each row execute function public.notify_discount_code_active();

-- Live delivery: publish inserts to Supabase Realtime (the publication exists but held no tables). Skipped where
-- there is no such publication (the in-process test database).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
     ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;
