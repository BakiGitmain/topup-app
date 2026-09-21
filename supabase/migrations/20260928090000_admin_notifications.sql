-- topup: wallet + Telegram. Part 1 of 7: the admin notification OUTBOX.
-- Run AFTER 20260927110000_checkout_functions.sql. Safe to re-run. Creates one table and three functions; changes nothing that exists.
--
-- WHY AN OUTBOX (and not a call from SQL): this project has no pg_net (checked), so a database function cannot make an
-- HTTP call. Instead the function that does the real work (a deposit request, a withdrawal request, a verified deposit)
-- writes the message text INTO THIS TABLE in the same transaction. So a notification exists if and only if the action
-- happened: it can't be lost by a crash and can't be sent for something that rolled back. The `telegram-notify` Edge
-- Function then reads the unsent rows and sends them to Telegram (server-side only, called by the other functions, never
-- by the app). If Telegram is down or not configured, rows simply stay unsent and are retried; the reason is kept in
-- `last_error`, so a broken setup is visible with:  select kind, attempts, last_error from admin_notifications where sent_at is null;
--
-- WHO CAN DO WHAT: admins can read the table (to see what was sent). Nobody else can read or write it. Only the
-- service role can claim and mark rows (that is the Edge Function). The enqueue function is internal: only other
-- SECURITY DEFINER functions call it.

create table if not exists public.admin_notifications (
  id            uuid primary key default gen_random_uuid(),
  -- deposit_requested | deposit_paid | deposit_mismatch | withdrawal_requested
  kind          text not null,
  -- The finished plain-text message. Built in SQL from database values; the app can never supply or alter it.
  message       text not null check (length(message) between 1 and 3500),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  attempts      integer not null default 0,
  -- While a sender holds a row it is invisible to others (a crash frees it after 60 s).
  claimed_until timestamptz,
  -- A short category of the last failure ("not_configured", "http_401", "network"). Never a token or message text.
  last_error    text
);

create index if not exists admin_notifications_unsent_idx
  on public.admin_notifications (created_at) where sent_at is null;

alter table public.admin_notifications enable row level security;
drop policy if exists admin_notifications_admin_select on public.admin_notifications;
create policy admin_notifications_admin_select on public.admin_notifications
  for select to authenticated
  using ((select public.is_admin()));
revoke all on public.admin_notifications from anon, authenticated;
grant select on public.admin_notifications to authenticated;
grant all on public.admin_notifications to service_role;

------------------------------------------------------------------------------
-- Internal helpers (only other SECURITY DEFINER functions may call these)
------------------------------------------------------------------------------

create or replace function public.enqueue_admin_notification(p_kind text, p_message text)
returns uuid
language sql
security definer
set search_path = public
as $$
  insert into public.admin_notifications (kind, message)
  values (p_kind, left(p_message, 3500))
  returning id;
$$;

-- "Br 1,250" / "Br 1,250.50": how amounts read in a message.
create or replace function public.birr_text(p_amount numeric)
returns text
language sql
immutable
set search_path = public
as $$
  select 'Br ' || case when p_amount = trunc(p_amount)
                       then to_char(p_amount, 'FM999,999,999,990')
                       else to_char(p_amount, 'FM999,999,999,990.00') end;
$$;

-- "Name <email>": who a message is about.
create or replace function public.customer_label(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(p.display_name), ''), 'Customer')
         || case when p.email is not null then ' <' || p.email || '>' else '' end
    from public.profiles p where p.id = p_user;
$$;

revoke all on function public.enqueue_admin_notification(text, text) from public, anon, authenticated, service_role;
revoke all on function public.customer_label(uuid) from public, anon, authenticated, service_role;

------------------------------------------------------------------------------
-- For the Edge Function (service role only)
------------------------------------------------------------------------------

-- Takes up to p_limit unsent rows, hides them from other senders for 60 s, and counts the attempt. Rows that have failed
-- 8 times are left alone (visible in the table) until someone looks.
create or replace function public.claim_admin_notifications(p_limit integer default 10)
returns table (notification_id uuid, body text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select n.id
      from public.admin_notifications n
     where n.sent_at is null
       and n.attempts < 8
       and (n.claimed_until is null or n.claimed_until < now())
     order by n.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 20))
     for update skip locked
  )
  update public.admin_notifications n
     set attempts = n.attempts + 1, claimed_until = now() + interval '60 seconds'
    from picked
   where n.id = picked.id
  returning n.id, n.message;
end;
$$;

-- A failure counts as an attempt (8 and the row is left alone), EXCEPT 'not_configured': while the Telegram secrets are missing
-- nothing can be sent, so waiting must not use up the attempts. The rows just stay queued, last_error says why, and they go out
-- as soon as the secrets are set.
create or replace function public.mark_admin_notification(p_id uuid, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.admin_notifications
     set sent_at = case when p_ok then now() else null end,
         claimed_until = null,
         attempts = case when not p_ok and p_error = 'not_configured' then greatest(attempts - 1, 0) else attempts end,
         last_error = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'failed'), 60) end
   where id = p_id;
$$;

revoke all on function public.claim_admin_notifications(integer) from public, anon, authenticated;
revoke all on function public.mark_admin_notification(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_admin_notifications(integer) to service_role;
grant execute on function public.mark_admin_notification(uuid, boolean, text) to service_role;
