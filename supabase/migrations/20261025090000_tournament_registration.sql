-- Tournaments, part 2: the owner's changes after trying part 1 (2026-09-28), and team registration.
-- FORWARD-ONLY, re-runnable.
--
-- 1. A REGISTER tournament's host PAYS for the rewards when they publish: every money reward plus today's price of
--    every product reward is taken from their wallet (wallet_transactions kind 'tournament') and held on the
--    tournament (reward_hold). Winners are paid from it in part 4. Cancelling gives it all back.
-- 2. A LIVE tournament has no reward grid and costs the host nothing: just `prize_text` ("what the winner gets"),
--    the game, mode, team size, time and stream link, and a Remind me button.
-- 3. Teams (register tournaments): the captain is player 1; the other players are app accounts (found by exact email,
--    find_recipient_by_email) whose game ID the captain checked with the real checker (validate-id, against the
--    game's own checked shop region). A draft saves as you go; Register pays the entry fee (held on the team) and
--    takes a spot. The host is told about every team; every player is told they were added.
-- 4. Reminders: anyone can ask to be reminded; registered players and the host are reminded anyway. The "starting
--    soon" notification (15 minutes before) is written when that person next loads their notifications: there is no
--    scheduler in this project (no pg_cron) and no push, so this is the moment they could see it anyway.
-- 5. Cancelling (host or admin) refunds every team's fee and the host's reward hold, and tells everyone.

-- ------------------------------------------------------------------------------------------------ money kind

alter table public.wallet_transactions drop constraint if exists wallet_transactions_kind_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_kind_check
  check (kind in ('deposit', 'purchase', 'refund', 'adjustment', 'withdrawal', 'portal_coin_redemption', 'commission', 'tournament'));

-- ------------------------------------------------------------------------------------------------ columns

alter table public.tournaments add column if not exists prize_text text;
alter table public.tournaments add column if not exists reward_hold numeric(14, 2) not null default 0;
alter table public.tournaments drop constraint if exists tournaments_prize_text_check;
alter table public.tournaments add constraint tournaments_prize_text_check
  check (prize_text is null or (char_length(prize_text) between 2 and 300 and prize_text = btrim(prize_text)));
alter table public.tournaments drop constraint if exists tournaments_reward_hold_check;
alter table public.tournaments add constraint tournaments_reward_hold_check check (reward_hold >= 0);

-- What the host paid for a product reward (its shop price at publish).
alter table public.tournament_rewards add column if not exists price_paid numeric(14, 2);

-- The shape (and now the money held) stays fixed once published; prize_text may be edited on a live tournament.
create or replace function public.guard_tournament_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind is distinct from old.kind or new.game is distinct from old.game or new.mode is distinct from old.mode
     or new.team_size is distinct from old.team_size or new.team_count is distinct from old.team_count
     or new.entry_fee is distinct from old.entry_fee or new.created_at is distinct from old.created_at
     or new.reward_hold is distinct from old.reward_hold then
    raise exception 'tournament_locked' using errcode = 'P0001';
  end if;
  if new.host_id is distinct from old.host_id and new.host_id is not null then
    raise exception 'tournament_locked' using errcode = 'P0001';
  end if;
  if old.status <> 'published' and new.status is distinct from old.status then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_tournament_update() from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ teams

create table if not exists public.tournament_teams (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  -- Nullable only so deleting an account doesn't fail on an old tournament; the guard below refuses it while the
  -- team is still playing. Always set on insert.
  captain_id     uuid references public.profiles (id) on delete set null,
  name           text not null check (char_length(name) between 2 and 30 and name = btrim(name)),
  status         text not null default 'draft' check (status in ('draft', 'registered', 'cancelled')),
  -- What the captain paid (0 = free). Held until the tournament finishes; refunded if it is cancelled.
  fee_paid       numeric(14, 2) not null default 0 check (fee_paid >= 0),
  registered_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint tournament_teams_registered_shape check ((status = 'draft') = (registered_at is null))
);
-- One team per captain per tournament; team names unique in a tournament (any case).
create unique index if not exists tournament_teams_one_per_captain on public.tournament_teams (tournament_id, captain_id);
create unique index if not exists tournament_teams_name_unique on public.tournament_teams (tournament_id, lower(name));
create index if not exists tournament_teams_registered_idx on public.tournament_teams (tournament_id) where status = 'registered';

create table if not exists public.tournament_team_members (
  team_id        uuid not null references public.tournament_teams (id) on delete cascade,
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  slot           integer not null check (slot between 1 and 5),
  user_id        uuid references public.profiles (id) on delete set null,
  -- The game ID as checked, and the name the checker returned for it (a snapshot, never typed by anyone).
  game_id        text check (game_id ~ '^[A-Za-z0-9_.@-]{2,40}$'),
  player_name    text,
  validation_id  uuid references public.id_validations (id) on delete set null,
  verified_at    timestamptz,
  -- Set when the team registers: a person can play in only ONE registered team of a tournament.
  registered     boolean not null default false,
  primary key (team_id, slot),
  constraint tournament_team_members_verified_shape check ((verified_at is null) or (game_id is not null))
);
create unique index if not exists tournament_members_one_team on public.tournament_team_members (tournament_id, user_id) where registered;
create unique index if not exists tournament_members_user_once_per_team on public.tournament_team_members (team_id, user_id);

create table if not exists public.tournament_reminders (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, tournament_id)
);

-- Which "starting soon" notices were already written (one per person per tournament).
create table if not exists public.tournament_notices (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  kind           text not null check (kind in ('starting')),
  created_at     timestamptz not null default now(),
  primary key (user_id, tournament_id, kind)
);

alter table public.tournament_teams enable row level security;
alter table public.tournament_team_members enable row level security;
alter table public.tournament_reminders enable row level security;
alter table public.tournament_notices enable row level security;
revoke all on public.tournament_teams from anon, authenticated;
revoke all on public.tournament_team_members from anon, authenticated;
revoke all on public.tournament_reminders from anon, authenticated;
revoke all on public.tournament_notices from anon, authenticated;

-- A registered team's fee and roster are fixed; only the functions below move its status.
create or replace function public.guard_tournament_team()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and pg_trigger_depth() = 1 then
      raise exception 'team_locked' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'cancelled' then
    raise exception 'team_locked' using errcode = 'P0001';
  end if;
  if old.status = 'registered' and (new.status not in ('registered', 'cancelled') or new.fee_paid is distinct from old.fee_paid
     or new.name is distinct from old.name or new.tournament_id is distinct from old.tournament_id) then
    raise exception 'team_locked' using errcode = 'P0001';
  end if;
  if new.tournament_id is distinct from old.tournament_id then
    raise exception 'team_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_tournament_team() from public, anon, authenticated;
drop trigger if exists tournament_teams_guard on public.tournament_teams;
create trigger tournament_teams_guard before update or delete on public.tournament_teams
  for each row execute function public.guard_tournament_team();

create or replace function public.guard_tournament_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  -- Cascades (team/tournament/profile deletion) pass; direct changes to a registered roster don't.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  select status into v_status from public.tournament_teams where id = coalesce(new.team_id, old.team_id);
  if v_status = 'registered' and tg_op <> 'INSERT'
     and (tg_op = 'DELETE' or (to_jsonb(new) - 'registered') is distinct from (to_jsonb(old) - 'registered')) then
    raise exception 'team_locked' using errcode = 'P0001';
  end if;
  if v_status = 'cancelled' then
    raise exception 'team_locked' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.guard_tournament_member() from public, anon, authenticated;
drop trigger if exists tournament_team_members_guard on public.tournament_team_members;
create trigger tournament_team_members_guard before insert or update or delete on public.tournament_team_members
  for each row execute function public.guard_tournament_member();

-- A player on a team that hasn't played yet can't delete their account.
create or replace function public.guard_player_with_upcoming_tournaments()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.tournament_team_members m
               join public.tournaments t on t.id = m.tournament_id
              where m.user_id = old.id and m.registered and t.status = 'published' and t.starts_at > now() - interval '1 day') then
    raise exception 'player_has_upcoming_tournaments' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_player_with_upcoming_tournaments() from public, anon, authenticated;
drop trigger if exists profiles_upcoming_team_guard on public.profiles;
create trigger profiles_upcoming_team_guard before delete on public.profiles
  for each row execute function public.guard_player_with_upcoming_tournaments();

-- ------------------------------------------------------------------------------------------------ helpers

-- The shop region whose supplier checks this game's player IDs (the real checker, validate-id). Found by the
-- product's name, so it keeps working when a product is re-imported. Null = no checker right now.
create or replace function public._tournament_check_region(p_game text)
returns table (region_id uuid, field_key text, field_label text)
language sql stable security definer set search_path = public as $$
  select r.id, r.buyer_fields -> 0 ->> 'key', coalesce(r.buyer_fields -> 0 ->> 'label', 'Player ID')
    from public.product_regions r
    join public.products p on p.id = r.product_id
   where p.name = case p_game when 'free_fire' then 'Free Fire' when 'pubg_mobile' then 'PUBG Mobile' end
     and r.id_validation = 'supplier'
     and jsonb_typeof(r.buyer_fields) = 'array' and jsonb_array_length(r.buyer_fields) = 1
     and coalesce(r.buyer_fields -> 0 ->> 'key', '') <> ''
   order by r.is_active desc, p.is_active desc, r.sort_order, r.label
   limit 1
$$;
revoke all on function public._tournament_check_region(text) from public, anon, authenticated;

create or replace function public._tournament_notify(p_user uuid, p_type text, p_title text, p_body text, p_data jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (type, title, body, data, user_id)
  select p_type, left(p_title, 120), left(p_body, 500), p_data, p_user where p_user is not null
$$;
revoke all on function public._tournament_notify(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ hosting (replaces part 1)

-- As in 20261024090000, with: a live tournament takes prize_text and NO rewards; a register tournament's rewards are
-- paid for now (wallet 'tournament', held on the tournament). Extra error: invalid_prize, insufficient_balance.
create or replace function public.tournament_create(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_kind    text := p ->> 'kind';
  v_game    text := p ->> 'game';
  v_mode    text := p ->> 'mode';
  v_name    text := btrim(coalesce(p ->> 'name', ''));
  v_size    integer := public._tj_int(p -> 'team_size');
  v_count   integer := public._tj_int(p -> 'team_count');
  v_fee     numeric := coalesce(public._tj_money(p -> 'entry_fee'), case when p -> 'entry_fee' is null or p -> 'entry_fee' = 'null'::jsonb then 0 end);
  v_starts  timestamptz;
  v_plat    text := nullif(btrim(coalesce(p ->> 'stream_platform', '')), '');
  v_url     text := nullif(btrim(coalesce(p ->> 'stream_url', '')), '');
  v_prize   text := nullif(btrim(coalesce(p ->> 'prize_text', '')), '');
  v_limits  record;
  v_rewards jsonb := p -> 'rewards';
  v_places  integer;
  v_r       jsonb;
  v_pack    record;
  v_hold    numeric(14, 2) := 0;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not coalesce((select is_content_creator from public.profiles where id = v_uid), false) then
    raise exception 'not_a_creator' using errcode = '42501';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  if v_kind is null or v_kind not in ('register', 'live') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  select * into v_limits from public.tournament_modes() m where m.game = v_game and m.mode = v_mode;
  if not found then
    raise exception 'invalid_game_mode' using errcode = '22023';
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 60 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if v_size is null or v_size < 1 or v_size > v_limits.max_team_size then
    raise exception 'invalid_team_size' using errcode = '22023';
  end if;

  if v_kind = 'register' then
    if v_count is null or v_count < 2 or v_count * v_size > v_limits.max_players then
      raise exception 'invalid_team_count' using errcode = '22023';
    end if;
    if v_fee is null or v_fee < 0 or v_fee > 100000 then
      raise exception 'invalid_entry_fee' using errcode = '22023';
    end if;
    if v_prize is not null then
      raise exception 'invalid_prize' using errcode = '22023';
    end if;
  else
    if p -> 'team_count' is not null and p -> 'team_count' <> 'null'::jsonb then
      raise exception 'invalid_team_count' using errcode = '22023';
    end if;
    if v_fee is distinct from 0 then
      raise exception 'invalid_entry_fee' using errcode = '22023';
    end if;
    if v_prize is null or char_length(v_prize) < 2 or char_length(v_prize) > 300 then
      raise exception 'invalid_prize' using errcode = '22023';
    end if;
    -- A live tournament announces its prize as text; it has no reward grid to fund.
    if v_rewards is not null and v_rewards <> 'null'::jsonb and v_rewards <> '[]'::jsonb then
      raise exception 'invalid_rewards' using errcode = '22023';
    end if;
    v_count := null;
  end if;

  v_starts := public._tj_time(p ->> 'starts_at');
  perform public._tournament_check_start(v_starts);
  perform public._tournament_check_stream(v_plat, v_url, v_kind = 'live');

  if v_kind = 'register' then
    if jsonb_typeof(v_rewards) is distinct from 'array' or jsonb_array_length(v_rewards) = 0
       or jsonb_array_length(v_rewards) > 10 * v_size then
      raise exception 'invalid_rewards' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_rewards) e where jsonb_typeof(e) <> 'object') then
      raise exception 'invalid_rewards' using errcode = '22023';
    end if;
    select max(public._tj_int(e -> 'place')) into v_places from jsonb_array_elements(v_rewards) e;
    if v_places is null or v_places > 10 or v_places > v_count
       or jsonb_array_length(v_rewards) <> v_places * v_size
       or exists (select 1 from jsonb_array_elements(v_rewards) e
                   where public._tj_int(e -> 'place') is null or public._tj_int(e -> 'place') < 1
                      or public._tj_int(e -> 'slot') is null or public._tj_int(e -> 'slot') < 1
                      or public._tj_int(e -> 'slot') > v_size)
       or (select count(distinct (public._tj_int(e -> 'place'), public._tj_int(e -> 'slot')))
             from jsonb_array_elements(v_rewards) e) <> v_places * v_size then
      raise exception 'invalid_rewards' using errcode = '22023';
    end if;
  end if;

  -- First pass: check every reward and work out what it costs (money as given; a pack at today's shop price).
  if v_kind = 'register' then
    for v_r in select e from jsonb_array_elements(v_rewards) e loop
      if v_r ->> 'kind' = 'money' then
        if public._tj_money(v_r -> 'amount') is null or public._tj_money(v_r -> 'amount') <= 0
           or public._tj_money(v_r -> 'amount') > 1000000 or v_r ? 'option_id' then
          raise exception 'invalid_rewards' using errcode = '22023';
        end if;
        v_hold := v_hold + public._tj_money(v_r -> 'amount');
      elsif v_r ->> 'kind' = 'product' then
        if v_r ? 'amount' or coalesce(v_r ->> 'option_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'invalid_rewards' using errcode = '22023';
        end if;
        select o.price into v_pack
          from public.product_options o
          join public.products pr on pr.id = o.product_id
          left join public.product_regions r on r.id = o.region_id
         where o.id = (v_r ->> 'option_id')::uuid
           and o.is_active and pr.is_active and (o.region_id is null or r.is_active);
        if not found then
          raise exception 'reward_pack_unavailable' using errcode = 'P0001';
        end if;
        v_hold := v_hold + v_pack.price;
      else
        raise exception 'invalid_rewards' using errcode = '22023';
      end if;
    end loop;
  end if;

  perform pg_advisory_xact_lock(hashtext('tournament_host'), hashtext(v_uid::text));
  if (select count(*) from public.tournaments where host_id = v_uid and status = 'published' and starts_at > now()) >= 10 then
    raise exception 'too_many_tournaments' using errcode = 'P0001';
  end if;

  insert into public.tournaments (host_id, kind, game, mode, name, team_size, team_count, entry_fee, starts_at,
                                  stream_platform, stream_url, prize_text, reward_hold)
  values (v_uid, v_kind, v_game, v_mode, v_name, v_size, v_count, round(v_fee, 2), v_starts, v_plat, v_url, v_prize, v_hold)
  returning id into v_id;

  if v_kind = 'register' then
    -- Second pass: the rows (each pack with its name snapshot and the price paid).
    insert into public.tournament_rewards (tournament_id, place, slot, kind, amount, option_id, product_name, option_label, region_label, price_paid)
    select v_id, public._tj_int(e -> 'place'), public._tj_int(e -> 'slot'), e ->> 'kind',
           case when e ->> 'kind' = 'money' then public._tj_money(e -> 'amount') end,
           o.id, pr.name, o.label, r.label, o.price
      from jsonb_array_elements(v_rewards) e
      left join public.product_options o on e ->> 'kind' = 'product' and o.id = (e ->> 'option_id')::uuid
      left join public.products pr on pr.id = o.product_id
      left join public.product_regions r on r.id = o.region_id;

    -- Pay for the rewards now; the tournament holds it. Short = the whole publish is refused (nothing is created).
    perform public.wallet_apply(v_uid, -v_hold, 'tournament', left('Tournament rewards held: ' || v_name, 200));
  end if;

  return v_id;
end;
$$;
revoke all on function public.tournament_create(jsonb) from public, anon;
grant execute on function public.tournament_create(jsonb) to authenticated;

-- As in 20261024090000, plus prize_text (a live tournament only; required there).
create or replace function public.tournament_update(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t      public.tournaments;
  v_name   text;
  v_starts timestamptz;
  v_plat   text;
  v_url    text;
  v_prize  text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_id for update;
  if not found or v_t.host_id is distinct from auth.uid() then
    raise exception 'tournament_not_found' using errcode = 'P0002';
  end if;
  if v_t.status <> 'published' or v_t.starts_at <= now() then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  v_name := case when p ? 'name' then btrim(coalesce(p ->> 'name', '')) else v_t.name end;
  if char_length(v_name) < 3 or char_length(v_name) > 60 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p ? 'starts_at' then
    v_starts := public._tj_time(p ->> 'starts_at');
    perform public._tournament_check_start(v_starts);
  else
    v_starts := v_t.starts_at;
  end if;
  if p ? 'stream_platform' or p ? 'stream_url' then
    v_plat := nullif(btrim(coalesce(p ->> 'stream_platform', '')), '');
    v_url := nullif(btrim(coalesce(p ->> 'stream_url', '')), '');
    perform public._tournament_check_stream(v_plat, v_url, v_t.kind = 'live');
  else
    v_plat := v_t.stream_platform;
    v_url := v_t.stream_url;
  end if;
  if p ? 'prize_text' then
    v_prize := nullif(btrim(coalesce(p ->> 'prize_text', '')), '');
    if v_t.kind <> 'live' or v_prize is null or char_length(v_prize) < 2 or char_length(v_prize) > 300 then
      raise exception 'invalid_prize' using errcode = '22023';
    end if;
  else
    v_prize := v_t.prize_text;
  end if;

  update public.tournaments
     set name = v_name, starts_at = v_starts, stream_platform = v_plat, stream_url = v_url, prize_text = v_prize
   where id = p_id;
  -- A moved start gets a fresh "starting soon" notice.
  if v_starts is distinct from v_t.starts_at then
    delete from public.tournament_notices where tournament_id = p_id;
  end if;
end;
$$;
revoke all on function public.tournament_update(uuid, jsonb) from public, anon;
grant execute on function public.tournament_update(uuid, jsonb) to authenticated;

-- Cancels a published tournament (its host, or an admin): every registered team gets its fee back, the host gets the
-- reward money back, drafts are dropped, and every player and everyone waiting for a reminder is told.
create or replace function public.tournament_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t    public.tournaments;
  v_team record;
  v_who  uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_id for update;
  if not found or (v_t.host_id is distinct from auth.uid() and not public.is_admin()) then
    raise exception 'tournament_not_found' using errcode = 'P0002';
  end if;
  if v_t.status <> 'published' then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;

  update public.tournaments set status = 'cancelled', cancelled_at = now() where id = p_id;

  for v_team in select * from public.tournament_teams where tournament_id = p_id and status = 'registered' for update loop
    if v_team.fee_paid > 0 and v_team.captain_id is not null then
      perform public.wallet_apply(v_team.captain_id, v_team.fee_paid, 'tournament',
                                  left('Entry fee refunded: ' || v_t.name || ' (tournament cancelled)', 200));
    end if;
    update public.tournament_teams set status = 'cancelled', updated_at = now() where id = v_team.id;
  end loop;
  delete from public.tournament_teams where tournament_id = p_id and status = 'draft';

  if v_t.reward_hold > 0 and v_t.host_id is not null then
    perform public.wallet_apply(v_t.host_id, v_t.reward_hold, 'tournament',
                                left('Tournament rewards returned: ' || v_t.name || ' (cancelled)', 200));
  end if;

  for v_who in
    select distinct u from (
      select m.user_id as u from public.tournament_team_members m
        join public.tournament_teams tt on tt.id = m.team_id
       where m.tournament_id = p_id and tt.status = 'cancelled'
      union
      select r.user_id from public.tournament_reminders r where r.tournament_id = p_id
    ) x where u is not null and u is distinct from v_t.host_id
  loop
    perform public._tournament_notify(v_who, 'tournament_cancelled', 'Tournament cancelled',
      format('%s was cancelled.%s', v_t.name,
             case when exists (select 1 from public.tournament_teams where tournament_id = p_id and captain_id = v_who and fee_paid > 0)
                  then ' Your entry fee is back in your wallet.' else '' end),
      jsonb_build_object('tournament_id', p_id, 'tournament_name', v_t.name));
  end loop;
end;
$$;
revoke all on function public.tournament_cancel(uuid) from public, anon;
grant execute on function public.tournament_cancel(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------ teams

-- Saves the caller's team for a register tournament as a draft (creates it the first time). Slot 1 is always the
-- captain. p: {name, members: [{slot, user_id, game_id, validation_id}]} -- a slot may be left out (not filled yet).
-- A filled slot needs an account (found by email in the app) and a game ID the CALLER just checked with validate-id
-- against this game's checked region: the name comes from that check, never from the app.
-- Errors: tournament_not_found, tournament_closed, not_register, host_cannot_join, invalid_team_name, team_name_taken,
--   invalid_members, member_not_found, duplicate_member, duplicate_game_id, id_check_unavailable, id_not_verified,
--   already_in_team, team_locked.
create or replace function public.tournament_team_save(p_tournament uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_t       public.tournaments;
  v_team    public.tournament_teams;
  v_name    text := btrim(coalesce(p ->> 'name', ''));
  v_check   record;
  v_m       jsonb;
  v_slot    integer;
  v_user    uuid;
  v_game    text;
  v_val     public.id_validations;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_tournament;
  if not found then
    raise exception 'tournament_not_found' using errcode = 'P0002';
  end if;
  if v_t.kind <> 'register' then
    raise exception 'not_register' using errcode = 'P0001';
  end if;
  if v_t.status <> 'published' or v_t.starts_at <= now() then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  if v_t.host_id = v_uid then
    raise exception 'host_cannot_join' using errcode = 'P0001';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 30 then
    raise exception 'invalid_team_name' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'members') is distinct from 'array' or jsonb_array_length(p -> 'members') > v_t.team_size
     or exists (select 1 from jsonb_array_elements(p -> 'members') e
                 where jsonb_typeof(e) <> 'object' or public._tj_int(e -> 'slot') is null
                    or public._tj_int(e -> 'slot') < 1 or public._tj_int(e -> 'slot') > v_t.team_size)
     or (select count(distinct public._tj_int(e -> 'slot')) from jsonb_array_elements(p -> 'members') e) <> jsonb_array_length(p -> 'members') then
    raise exception 'invalid_members' using errcode = '22023';
  end if;

  select * into v_team from public.tournament_teams where tournament_id = p_tournament and captain_id = v_uid for update;
  if found and v_team.status <> 'draft' then
    raise exception 'team_locked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.tournament_teams where tournament_id = p_tournament and lower(name) = lower(v_name)
               and id is distinct from v_team.id and status <> 'cancelled') then
    raise exception 'team_name_taken' using errcode = 'P0001';
  end if;
  -- The captain can't be in someone else's registered team of this tournament.
  if exists (select 1 from public.tournament_team_members where tournament_id = p_tournament and user_id = v_uid and registered) then
    raise exception 'already_in_team' using errcode = 'P0001';
  end if;

  if v_team.id is null then
    insert into public.tournament_teams (tournament_id, captain_id, name) values (p_tournament, v_uid, v_name)
    returning * into v_team;
  else
    update public.tournament_teams set name = v_name, updated_at = now() where id = v_team.id;
  end if;

  select * into v_check from public._tournament_check_region(v_t.game);

  -- Rewrite the roster: slot 1 = the captain; the rest as sent.
  delete from public.tournament_team_members where team_id = v_team.id;
  insert into public.tournament_team_members (team_id, tournament_id, slot, user_id)
  values (v_team.id, p_tournament, 1, v_uid);

  for v_m in select e from jsonb_array_elements(p -> 'members') e order by public._tj_int(e -> 'slot') loop
    v_slot := public._tj_int(v_m -> 'slot');
    v_user := case when coalesce(v_m ->> 'user_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then (v_m ->> 'user_id')::uuid end;
    v_game := nullif(btrim(coalesce(v_m ->> 'game_id', '')), '');
    if v_slot = 1 then
      v_user := v_uid;
    elsif v_user is null then
      continue; -- not filled yet
    end if;
    if v_user <> v_uid and not exists (select 1 from public.profiles where id = v_user) then
      raise exception 'member_not_found' using errcode = 'P0002';
    end if;
    if v_user = v_t.host_id then
      raise exception 'host_cannot_join' using errcode = 'P0001';
    end if;
    if v_slot > 1 and exists (select 1 from public.tournament_team_members where team_id = v_team.id and user_id = v_user) then
      raise exception 'duplicate_member' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.tournament_team_members where tournament_id = p_tournament and user_id = v_user and registered) then
      raise exception 'already_in_team' using errcode = 'P0001';
    end if;

    v_val := null;
    if v_game is not null then
      if v_game !~ '^[A-Za-z0-9_.@-]{2,40}$' then
        raise exception 'invalid_members' using errcode = '22023';
      end if;
      if v_check.region_id is null then
        raise exception 'id_check_unavailable' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.tournament_team_members where team_id = v_team.id and game_id = v_game) then
        raise exception 'duplicate_game_id' using errcode = 'P0001';
      end if;
      -- Kept from an earlier save (same person, same ID): no need to check again.
      if coalesce(v_m ->> 'validation_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select * into v_val from public.id_validations
         where id = (v_m ->> 'validation_id')::uuid and user_id = v_uid and region_id = v_check.region_id
           and fields ->> v_check.field_key = v_game and created_at > now() - interval '24 hours';
      end if;
      if v_val.id is null then
        raise exception 'id_not_verified' using errcode = 'P0001', detail = v_slot::text;
      end if;
    end if;

    if v_slot = 1 then
      update public.tournament_team_members
         set game_id = v_game, player_name = v_val.player_name, validation_id = v_val.id,
             verified_at = case when v_val.id is not null then v_val.created_at end
       where team_id = v_team.id and slot = 1;
    else
      insert into public.tournament_team_members (team_id, tournament_id, slot, user_id, game_id, player_name, validation_id, verified_at)
      values (v_team.id, p_tournament, v_slot, v_user, v_game, v_val.player_name, v_val.id,
              case when v_val.id is not null then v_val.created_at end);
    end if;
  end loop;

  return v_team.id;
end;
$$;
revoke all on function public.tournament_team_save(uuid, jsonb) from public, anon;
grant execute on function public.tournament_team_save(uuid, jsonb) to authenticated;

-- Registers the caller's saved draft: every slot filled and checked, a spot free, the fee paid from the wallet (held).
-- Errors: team_not_found, tournament_closed, team_incomplete, tournament_full, already_in_team, insufficient_balance.
create or replace function public.tournament_team_register(p_team uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_team  public.tournament_teams;
  v_t     public.tournaments;
  v_count integer;
  v_m     record;
  v_host  text;
  v_cap   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_team from public.tournament_teams where id = p_team and captain_id = v_uid;
  if not found then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
  -- One registration at a time per tournament: the spot count can't be raced past.
  select * into v_t from public.tournaments where id = v_team.tournament_id for update;
  select * into v_team from public.tournament_teams where id = p_team for update;
  if v_team.status = 'registered' then
    return jsonb_build_object('team_id', v_team.id, 'status', 'registered', 'already', true);
  end if;
  if v_team.status <> 'draft' or v_t.status <> 'published' or v_t.starts_at <= now() then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  if v_t.host_id = v_uid then
    raise exception 'host_cannot_join' using errcode = 'P0001';
  end if;
  if (select count(*) from public.tournament_team_members
       where team_id = p_team and user_id is not null and game_id is not null and verified_at is not null) <> v_t.team_size then
    raise exception 'team_incomplete' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.tournament_teams where tournament_id = v_t.id and status = 'registered';
  if v_count >= v_t.team_count then
    raise exception 'tournament_full' using errcode = 'P0001';
  end if;

  begin
    update public.tournament_team_members set registered = true where team_id = p_team;
  exception when unique_violation then
    raise exception 'already_in_team' using errcode = 'P0001';
  end;

  if v_t.entry_fee > 0 then
    perform public.wallet_apply(v_uid, -v_t.entry_fee, 'tournament',
                                left('Entry fee: ' || v_t.name || ' (team ' || v_team.name || ')', 200));
  end if;
  update public.tournament_teams
     set status = 'registered', registered_at = now(), fee_paid = v_t.entry_fee, updated_at = now()
   where id = p_team;

  v_cap := public._gift_person_name(v_uid);
  perform public._tournament_notify(v_t.host_id, 'tournament_team_registered', 'New team registered',
    format('%s registered for %s (%s of %s teams).', v_team.name, v_t.name, v_count + 1, v_t.team_count),
    jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'team_name', v_team.name,
                       'teams', v_count + 1, 'team_count', v_t.team_count));
  for v_m in select user_id from public.tournament_team_members where team_id = p_team and user_id <> v_uid loop
    perform public._tournament_notify(v_m.user_id, 'tournament_joined', 'You''re in a tournament team',
      format('%s added you to team %s for %s.', v_cap, v_team.name, v_t.name),
      jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'team_name', v_team.name, 'captain_name', v_cap));
  end loop;

  return jsonb_build_object('team_id', p_team, 'status', 'registered', 'fee_paid', v_t.entry_fee,
                            'balance', (select balance from public.wallets where user_id = v_uid));
end;
$$;
revoke all on function public.tournament_team_register(uuid) from public, anon;
grant execute on function public.tournament_team_register(uuid) to authenticated;

-- Throws away the caller's draft (a registered team can't be deleted; nothing was paid for a draft).
create or replace function public.tournament_team_discard(p_team uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.tournament_teams where id = p_team and captain_id = auth.uid() and status = 'draft';
  if not found then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.tournament_team_discard(uuid) from public, anon;
grant execute on function public.tournament_team_discard(uuid) to authenticated;

-- One team as the app shows it. Game IDs only to the captain, the team's own players and the host.
create or replace function public._tournament_team_json(p_team uuid, p_private boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', tt.id, 'name', tt.name, 'status', tt.status, 'fee_paid', tt.fee_paid, 'registered_at', tt.registered_at,
    'is_captain', tt.captain_id = auth.uid(),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slot', m.slot,
               'user_id', case when p_private then m.user_id end,
               'name', case when m.user_id is null then null else public._gift_person_name(m.user_id) end,
               'avatar_url', (select avatar_url from public.profiles where id = m.user_id),
               'game_id', case when p_private then m.game_id end,
               'player_name', m.player_name,
               'validation_id', case when p_private and tt.captain_id = auth.uid() then m.validation_id end,
               'verified', m.verified_at is not null) order by m.slot)
        from public.tournament_team_members m where m.team_id = tt.id), '[]'::jsonb))
  from public.tournament_teams tt where tt.id = p_team
$$;
revoke all on function public._tournament_team_json(uuid, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ reminders

create or replace function public.tournament_set_reminder(p_id uuid, p_on boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.tournaments where id = p_id and status = 'published') then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  if p_on then
    insert into public.tournament_reminders (user_id, tournament_id) values (auth.uid(), p_id) on conflict do nothing;
  else
    delete from public.tournament_reminders where user_id = auth.uid() and tournament_id = p_id;
  end if;
  return p_on;
end;
$$;
revoke all on function public.tournament_set_reminder(uuid, boolean) from public, anon;
grant execute on function public.tournament_set_reminder(uuid, boolean) to authenticated;

-- The one place the notice lead time lives.
create or replace function public.tournament_notice_lead()
returns interval language sql immutable as $$ select interval '15 minutes' $$;
revoke all on function public.tournament_notice_lead() from public, anon, authenticated;

-- Writes this person's due "starting soon" notices (once each): tournaments starting within the lead time (or that
-- started in the last 30 minutes) that they asked to be reminded of, play in, or host.
create or replace function public._deliver_tournament_notices(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t record;
begin
  if p_user is null then
    return;
  end if;
  for v_t in
    select t.id, t.name, t.starts_at, t.kind
      from public.tournaments t
     where t.status = 'published'
       and t.starts_at <= now() + public.tournament_notice_lead()
       and t.starts_at > now() - interval '30 minutes'
       and (t.host_id = p_user
            or exists (select 1 from public.tournament_reminders r where r.tournament_id = t.id and r.user_id = p_user)
            or exists (select 1 from public.tournament_team_members m where m.tournament_id = t.id and m.user_id = p_user and m.registered))
       and not exists (select 1 from public.tournament_notices n where n.tournament_id = t.id and n.user_id = p_user and n.kind = 'starting')
  loop
    insert into public.tournament_notices (user_id, tournament_id, kind) values (p_user, v_t.id, 'starting')
    on conflict do nothing;
    if found then
      perform public._tournament_notify(p_user, 'tournament_starting', 'Tournament starting soon',
        format('%s starts at %s.', v_t.name, to_char(v_t.starts_at at time zone 'Africa/Addis_Ababa', 'HH24:MI')),
        jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'starts_at', v_t.starts_at, 'kind', v_t.kind));
    end if;
  end loop;
end;
$$;
revoke all on function public._deliver_tournament_notices(uuid) from public, anon, authenticated;

-- As in 20261013100000, with the due tournament notices written first.
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
  perform public._deliver_tournament_notices(auth.uid());

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

-- ------------------------------------------------------------------------------------------------ reading (replaces part 1)

create or replace function public._tournament_json(t public.tournaments, p_rewards boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'game', t.game, 'mode', t.mode, 'name', t.name,
    'team_size', t.team_size, 'team_count', t.team_count, 'entry_fee', t.entry_fee,
    'starts_at', t.starts_at, 'stream_platform', t.stream_platform, 'stream_url', t.stream_url,
    'prize_text', t.prize_text, 'rewards_funded', t.reward_hold > 0,
    'status', t.status, 'created_at', t.created_at,
    'is_host', t.host_id is not null and t.host_id = auth.uid(),
    'host', jsonb_build_object(
      'name', case when t.host_id is null then 'Portal user' else public._gift_person_name(t.host_id) end,
      'avatar_url', (select avatar_url from public.profiles where id = t.host_id)),
    'first_place', (select jsonb_build_object('money', coalesce(sum(amount), 0), 'products', count(*) filter (where kind = 'product'))
                      from public.tournament_rewards where tournament_id = t.id and place = 1),
    'places', (select count(distinct place) from public.tournament_rewards where tournament_id = t.id),
    'teams_registered', (select count(*) from public.tournament_teams where tournament_id = t.id and status = 'registered'),
    'reminded', exists (select 1 from public.tournament_reminders where tournament_id = t.id and user_id = auth.uid()),
    -- The caller's own team here (as captain or player), if any.
    'my_team', (select jsonb_build_object('id', tt.id, 'name', tt.name, 'status', tt.status, 'is_captain', tt.captain_id = auth.uid())
                  from public.tournament_teams tt
                 where tt.tournament_id = t.id
                   and (tt.captain_id = auth.uid()
                        or exists (select 1 from public.tournament_team_members m where m.team_id = tt.id and m.user_id = auth.uid() and m.registered))
                 order by (tt.status = 'registered') desc limit 1)
  ) || case when p_rewards then jsonb_build_object(
         'rewards', coalesce((
           select jsonb_agg(jsonb_build_object('place', r.place, 'slot', r.slot, 'kind', r.kind, 'amount', r.amount,
                                               'product_name', r.product_name, 'option_label', r.option_label,
                                               'region_label', r.region_label) order by r.place, r.slot)
             from public.tournament_rewards r where r.tournament_id = t.id), '[]'::jsonb),
         -- Registered teams: names for everyone; the host also sees each player's game ID and checked name.
         'teams', coalesce((
           select jsonb_agg(public._tournament_team_json(tt.id, t.host_id = auth.uid()) order by tt.registered_at, tt.id)
             from public.tournament_teams tt where tt.tournament_id = t.id and tt.status = 'registered'), '[]'::jsonb),
         -- Where the app checks a player's game ID for this game (validate-id), if anywhere.
         'id_check', (select jsonb_build_object('region_id', c.region_id, 'field_key', c.field_key, 'field_label', c.field_label)
                        from public._tournament_check_region(t.game) c where c.region_id is not null))
       else '{}'::jsonb end
$$;
revoke all on function public._tournament_json(public.tournaments, boolean) from public, anon, authenticated;

-- p_scope: 'open' | 'hosting' (as before) | 'mine' = tournaments the caller has a team in (draft or registered) or
-- asked to be reminded of.
create or replace function public.tournament_list(p_scope text, p_game text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_scope = 'open' then
    return coalesce((
      select jsonb_agg(public._tournament_json(t, false) order by t.starts_at, t.id)
        from public.tournaments t
       where t.id in (select id from public.tournaments
                       where status = 'published' and starts_at > now() - interval '6 hours'
                         and (p_game is null or game = p_game)
                       order by starts_at, id limit 100)), '[]'::jsonb);
  elsif p_scope = 'hosting' then
    return coalesce((
      select jsonb_agg(public._tournament_json(t, false) order by t.starts_at desc, t.id)
        from public.tournaments t
       where t.id in (select id from public.tournaments
                       where host_id = auth.uid() and (p_game is null or game = p_game)
                       order by starts_at desc, id limit 100)), '[]'::jsonb);
  elsif p_scope = 'mine' then
    return coalesce((
      select jsonb_agg(public._tournament_json(t, false) order by t.starts_at desc, t.id)
        from public.tournaments t
       where t.id in (select x.id from public.tournaments x
                       where (p_game is null or x.game = p_game)
                         and (exists (select 1 from public.tournament_teams tt where tt.tournament_id = x.id and tt.captain_id = auth.uid() and tt.status <> 'cancelled')
                              or exists (select 1 from public.tournament_team_members m where m.tournament_id = x.id and m.user_id = auth.uid() and m.registered)
                              or exists (select 1 from public.tournament_reminders r where r.tournament_id = x.id and r.user_id = auth.uid()))
                       order by x.starts_at desc, x.id limit 100)), '[]'::jsonb);
  end if;
  raise exception 'invalid_scope' using errcode = '22023';
end;
$$;
revoke all on function public.tournament_list(text, text) from public, anon;
grant execute on function public.tournament_list(text, text) to authenticated;

-- The caller's own team in a tournament (captain: everything, incl. the draft; a player: the registered roster).
create or replace function public.tournament_my_team(p_tournament uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select tt.id into v_id from public.tournament_teams tt
   where tt.tournament_id = p_tournament
     and (tt.captain_id = auth.uid()
          or exists (select 1 from public.tournament_team_members m where m.team_id = tt.id and m.user_id = auth.uid() and m.registered))
   order by (tt.status = 'registered') desc limit 1;
  if v_id is null then
    return null;
  end if;
  return public._tournament_team_json(v_id, true);
end;
$$;
revoke all on function public.tournament_my_team(uuid) from public, anon;
grant execute on function public.tournament_my_team(uuid) to authenticated;
