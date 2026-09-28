-- Tournaments, part 1 of 4: hosting and browsing. FORWARD-ONLY, purely additive, re-runnable.
--
-- A content creator (profiles.is_content_creator) hosts a tournament for Free Fire or PUBG Mobile:
--   register  teams sign up in the app (part 2): a fixed number of teams of a fixed size, free or with an entry fee
--             paid once per team.
--   live      nobody signs up: an announced event (time, game, stream link, rewards) people ask to be reminded of;
--             the room ID/password is posted in the app when it starts (part 3).
-- Both announce rewards per PLACE and per PLAYER SLOT (place 1: player 1 gets X, player 2 gets Y...). Nothing is paid
-- now: the host pays each reward when they pick the winners (part 4) -- money into the winner's wallet, a product as
-- a gift into their Vault.
--
-- Players = team_size x team_count, always: the host picks the team size and the number of TEAMS, so every team is
-- full and the split is always even (32 players in teams of 4 = 8 teams; 33 is not a choice).
--
-- Games and modes: tournament_modes() is the one list (mirrored in src/lib/tournamentRules.ts, parity-tested). Each
-- mode's largest team is what the game's own custom rooms allow (all four-player squads at most; Lone Wolf is 1v1 or
-- 2v2); the player cap is one room for a battle royale (Free Fire 48, PUBG Mobile 100) and a bracket for the
-- team-vs-team modes.
--
-- Access: no customer reads or writes the tables directly (no grants). Everything goes through the functions below,
-- which also keep the host's profile private (name + picture only, never the email).

-- ------------------------------------------------------------------------------------------------ games and modes

create or replace function public.tournament_modes()
returns table (game text, mode text, max_team_size integer, max_players integer)
language sql immutable set search_path = public as $$
  values ('free_fire',   'battle_royale', 4, 48),
         ('free_fire',   'clash_squad',   4, 64),
         ('free_fire',   'lone_wolf',     2, 32),
         ('pubg_mobile', 'classic',       4, 100),
         ('pubg_mobile', 'tdm',           4, 64)
$$;
revoke all on function public.tournament_modes() from public, anon;
grant execute on function public.tournament_modes() to authenticated;

-- ------------------------------------------------------------------------------------------------ tables

create table if not exists public.tournaments (
  id               uuid primary key default gen_random_uuid(),
  -- Nullable only so a finished/cancelled tournament doesn't block deleting its host's account (the guard below
  -- refuses it while one is still upcoming). Always set on insert.
  host_id          uuid references public.profiles (id) on delete set null,
  kind             text not null check (kind in ('register', 'live')),
  game             text not null check (game in ('free_fire', 'pubg_mobile')),
  mode             text not null,
  name             text not null check (char_length(name) between 3 and 60 and name = btrim(name)),
  team_size        integer not null check (team_size between 1 and 5),
  -- Register only (live: null). Players = team_size * team_count.
  team_count       integer check (team_count between 2 and 100),
  -- Per TEAM, paid once by the team's captain. 0 = free. Register only.
  entry_fee        numeric(14, 2) not null default 0 check (entry_fee >= 0 and entry_fee <= 100000),
  starts_at        timestamptz not null,
  stream_platform  text check (stream_platform in ('tiktok', 'youtube', 'twitch', 'facebook', 'instagram', 'kick', 'other')),
  stream_url       text check (stream_url ~ '^https://[^[:space:]]{3,}$' and char_length(stream_url) <= 300),
  status           text not null default 'published' check (status in ('published', 'cancelled', 'finished')),
  created_at       timestamptz not null default now(),
  cancelled_at     timestamptz,
  finished_at      timestamptz,
  constraint tournaments_kind_shape check (
    (kind = 'register' and team_count is not null)
    or (kind = 'live' and team_count is null and entry_fee = 0 and stream_url is not null)
  ),
  constraint tournaments_stream_pair check ((stream_platform is null) = (stream_url is null)),
  constraint tournaments_status_times check (
    (status = 'cancelled') = (cancelled_at is not null) and (status = 'finished') = (finished_at is not null)
  )
);
create index if not exists tournaments_open_idx on public.tournaments (starts_at) where status = 'published';
create index if not exists tournaments_host_idx on public.tournaments (host_id, starts_at desc);

create table if not exists public.tournament_rewards (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  place          integer not null check (place between 1 and 10),
  slot           integer not null check (slot between 1 and 5),
  kind           text not null check (kind in ('money', 'product')),
  amount         numeric(14, 2) check (amount > 0 and amount <= 1000000),
  -- The pack a product reward buys. SET NULL if an admin deletes the pack; the names below stay (a snapshot), so the
  -- announcement still reads right and part 4 refuses to pay a pack that no longer exists.
  option_id      uuid references public.product_options (id) on delete set null,
  product_name   text,
  option_label   text,
  region_label   text,
  unique (tournament_id, place, slot),
  constraint tournament_rewards_shape check (
    (kind = 'money' and amount is not null and product_name is null)
    or (kind = 'product' and amount is null and product_name is not null and option_label is not null)
  )
);

alter table public.tournaments enable row level security;
alter table public.tournament_rewards enable row level security;
revoke all on public.tournaments from anon, authenticated;
revoke all on public.tournament_rewards from anon, authenticated;

-- Once published, the shape of a tournament is fixed: what people signed up (or paid) for can't change under them.
-- Only the name, the start time and the stream link can be edited (tournament_update), and only the status moves.
create or replace function public.guard_tournament_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind is distinct from old.kind or new.game is distinct from old.game or new.mode is distinct from old.mode
     or new.team_size is distinct from old.team_size or new.team_count is distinct from old.team_count
     or new.entry_fee is distinct from old.entry_fee or new.created_at is distinct from old.created_at then
    raise exception 'tournament_locked' using errcode = 'P0001';
  end if;
  -- host_id may only be cleared by the profile's deletion (ON DELETE SET NULL), never changed.
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
drop trigger if exists tournaments_guard on public.tournaments;
create trigger tournaments_guard before update on public.tournaments
  for each row execute function public.guard_tournament_update();

-- Rewards are written once, with the tournament, and never edited (a player may have joined for them).
create or replace function public.guard_tournament_rewards()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- The only change allowed: the pack link cleared by the pack's deletion.
    if new.option_id is null and old.option_id is not null
       and (to_jsonb(new) - 'option_id') = (to_jsonb(old) - 'option_id') then
      return new;
    end if;
    raise exception 'tournament_locked' using errcode = 'P0001';
  end if;
  -- DELETE: only as part of deleting the tournament itself (cascade).
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'tournament_locked' using errcode = 'P0001';
end;
$$;
revoke all on function public.guard_tournament_rewards() from public, anon, authenticated;
drop trigger if exists tournament_rewards_guard on public.tournament_rewards;
create trigger tournament_rewards_guard before update or delete on public.tournament_rewards
  for each row execute function public.guard_tournament_rewards();

-- A host can't delete their account while they have a tournament that hasn't happened yet.
create or replace function public.guard_host_with_upcoming_tournaments()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.tournaments
              where host_id = old.id and status = 'published' and starts_at > now() - interval '1 day') then
    raise exception 'host_has_upcoming_tournaments' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_host_with_upcoming_tournaments() from public, anon, authenticated;
drop trigger if exists profiles_upcoming_tournaments_guard on public.profiles;
create trigger profiles_upcoming_tournaments_guard before delete on public.profiles
  for each row execute function public.guard_host_with_upcoming_tournaments();

-- ------------------------------------------------------------------------------------------------ small helpers

-- Strict readers for jsonb input: the value as written, or null if it isn't exactly that shape (never a cast error).
create or replace function public._tj_int(p jsonb)
returns integer language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p) = 'number' and p::text ~ '^[0-9]{1,6}$' then p::text::integer end
$$;
create or replace function public._tj_money(p jsonb)
returns numeric language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p) = 'number' and p::text ~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' then p::text::numeric end
$$;
revoke all on function public._tj_int(jsonb) from public, anon, authenticated;
-- An ISO 8601 time WITH its offset, as the app sends it (never Postgres' own words like 'tomorrow' or 'now').
create or replace function public._tj_time(p text)
returns timestamptz language plpgsql stable set search_path = public as $$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
    return null;
  end if;
  return p::timestamptz;
exception when others then
  return null;
end;
$$;
revoke all on function public._tj_time(text) from public, anon, authenticated;

revoke all on function public._tj_money(jsonb) from public, anon, authenticated;

-- The one place the time rules live: how soon and how far ahead a tournament may start.
create or replace function public.tournament_start_window()
returns table (min_lead interval, max_lead interval)
language sql immutable set search_path = public as $$ select interval '15 minutes', interval '90 days' $$;
revoke all on function public.tournament_start_window() from public, anon, authenticated;

create or replace function public._tournament_check_start(p_starts timestamptz)
returns void language plpgsql stable set search_path = public as $$
declare
  w record;
begin
  select * into w from public.tournament_start_window();
  if p_starts is null or p_starts < now() + w.min_lead or p_starts > now() + w.max_lead then
    raise exception 'invalid_start' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public._tournament_check_start(timestamptz) from public, anon, authenticated;

-- Platform + https link, both or neither (p_required: a live tournament must have one).
create or replace function public._tournament_check_stream(p_platform text, p_url text, p_required boolean)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_platform is null and p_url is null then
    if p_required then
      raise exception 'invalid_stream' using errcode = '22023';
    end if;
    return;
  end if;
  if p_platform is null or p_url is null
     or p_platform not in ('tiktok', 'youtube', 'twitch', 'facebook', 'instagram', 'kick', 'other')
     or p_url !~ '^https://[^[:space:]]{3,}$' or char_length(p_url) > 300 then
    raise exception 'invalid_stream' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public._tournament_check_stream(text, text, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ hosting

-- Creates and publishes a tournament with its rewards, in one go. Only a content creator. Returns the new id.
-- p: {kind, game, mode, name, team_size, team_count?, entry_fee?, starts_at, stream_platform?, stream_url?,
--     rewards: [{place, slot, kind: 'money', amount} | {place, slot, kind: 'product', option_id}]}
-- Errors: not_authenticated, not_a_creator, invalid_kind, invalid_game_mode, invalid_name, invalid_team_size,
--   invalid_team_count, invalid_entry_fee, invalid_start, invalid_stream, invalid_rewards, reward_pack_unavailable,
--   too_many_tournaments.
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
  v_limits  record;
  v_rewards jsonb := p -> 'rewards';
  v_places  integer;
  v_r       jsonb;
  v_pack    record;
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
  else
    -- A live tournament has no sign-up: no team count, no fee.
    if p -> 'team_count' is not null and p -> 'team_count' <> 'null'::jsonb then
      raise exception 'invalid_team_count' using errcode = '22023';
    end if;
    if v_fee is distinct from 0 then
      raise exception 'invalid_entry_fee' using errcode = '22023';
    end if;
    v_count := null;
  end if;

  v_starts := public._tj_time(p ->> 'starts_at');
  perform public._tournament_check_start(v_starts);
  perform public._tournament_check_stream(v_plat, v_url, v_kind = 'live');

  -- Rewards: places 1..N with no gaps (N at most 10, and never more places than teams), every place giving a
  -- reward to EVERY player slot 1..team_size, each either money or a pack that is on sale right now.
  if jsonb_typeof(v_rewards) is distinct from 'array' or jsonb_array_length(v_rewards) = 0
     or jsonb_array_length(v_rewards) > 10 * v_size then
    raise exception 'invalid_rewards' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_rewards) e where jsonb_typeof(e) <> 'object') then
    raise exception 'invalid_rewards' using errcode = '22023';
  end if;
  select max(public._tj_int(e -> 'place')) into v_places from jsonb_array_elements(v_rewards) e;
  if v_places is null or v_places > 10 or (v_count is not null and v_places > v_count)
     or jsonb_array_length(v_rewards) <> v_places * v_size
     or exists (select 1 from jsonb_array_elements(v_rewards) e
                 where public._tj_int(e -> 'place') is null or public._tj_int(e -> 'place') < 1
                    or public._tj_int(e -> 'slot') is null or public._tj_int(e -> 'slot') < 1
                    or public._tj_int(e -> 'slot') > v_size)
     or (select count(distinct (public._tj_int(e -> 'place'), public._tj_int(e -> 'slot')))
           from jsonb_array_elements(v_rewards) e) <> v_places * v_size then
    raise exception 'invalid_rewards' using errcode = '22023';
  end if;

  -- One host can't flood the list: at most 10 upcoming tournaments at a time.
  perform pg_advisory_xact_lock(hashtext('tournament_host'), hashtext(v_uid::text));
  if (select count(*) from public.tournaments where host_id = v_uid and status = 'published' and starts_at > now()) >= 10 then
    raise exception 'too_many_tournaments' using errcode = 'P0001';
  end if;

  insert into public.tournaments (host_id, kind, game, mode, name, team_size, team_count, entry_fee, starts_at,
                                  stream_platform, stream_url)
  values (v_uid, v_kind, v_game, v_mode, v_name, v_size, v_count, round(v_fee, 2), v_starts, v_plat, v_url)
  returning id into v_id;

  for v_r in select e from jsonb_array_elements(v_rewards) e loop
    if v_r ->> 'kind' = 'money' then
      if public._tj_money(v_r -> 'amount') is null or public._tj_money(v_r -> 'amount') <= 0
         or public._tj_money(v_r -> 'amount') > 1000000 or v_r ? 'option_id' then
        raise exception 'invalid_rewards' using errcode = '22023';
      end if;
      insert into public.tournament_rewards (tournament_id, place, slot, kind, amount)
      values (v_id, public._tj_int(v_r -> 'place'), public._tj_int(v_r -> 'slot'), 'money', public._tj_money(v_r -> 'amount'));
    elsif v_r ->> 'kind' = 'product' then
      if v_r ? 'amount' or coalesce(v_r ->> 'option_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalid_rewards' using errcode = '22023';
      end if;
      select o.label, pr.name as product_name, r.label as region_label into v_pack
        from public.product_options o
        join public.products pr on pr.id = o.product_id
        left join public.product_regions r on r.id = o.region_id
       where o.id = (v_r ->> 'option_id')::uuid
         and o.is_active and pr.is_active and (o.region_id is null or r.is_active);
      if not found then
        raise exception 'reward_pack_unavailable' using errcode = 'P0001';
      end if;
      insert into public.tournament_rewards (tournament_id, place, slot, kind, option_id, product_name, option_label, region_label)
      values (v_id, public._tj_int(v_r -> 'place'), public._tj_int(v_r -> 'slot'), 'product', (v_r ->> 'option_id')::uuid,
              v_pack.product_name, v_pack.label, v_pack.region_label);
    else
      raise exception 'invalid_rewards' using errcode = '22023';
    end if;
  end loop;

  return v_id;
end;
$$;
revoke all on function public.tournament_create(jsonb) from public, anon;
grant execute on function public.tournament_create(jsonb) to authenticated;

-- The host fixes a typo, moves the start, or changes the stream link -- nothing else, and only before it starts.
-- p: {name?, starts_at?, stream_platform?, stream_url?} (a key left out keeps its value; stream '' clears it).
create or replace function public.tournament_update(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t      public.tournaments;
  v_name   text;
  v_starts timestamptz;
  v_plat   text;
  v_url    text;
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

  update public.tournaments
     set name = v_name, starts_at = v_starts, stream_platform = v_plat, stream_url = v_url
   where id = p_id;
end;
$$;
revoke all on function public.tournament_update(uuid, jsonb) from public, anon;
grant execute on function public.tournament_update(uuid, jsonb) to authenticated;

-- Cancels a published tournament (its host, or an admin). Part 2 adds refunding every paid team here.
create or replace function public.tournament_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t public.tournaments;
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
end;
$$;
revoke all on function public.tournament_cancel(uuid) from public, anon;
grant execute on function public.tournament_cancel(uuid) to authenticated;

-- ------------------------------------------------------------------------------------------------ reading

-- One tournament as the app shows it (a list row or the detail screen). The host is name + picture only.
create or replace function public._tournament_json(t public.tournaments, p_rewards boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'game', t.game, 'mode', t.mode, 'name', t.name,
    'team_size', t.team_size, 'team_count', t.team_count, 'entry_fee', t.entry_fee,
    'starts_at', t.starts_at, 'stream_platform', t.stream_platform, 'stream_url', t.stream_url,
    'status', t.status, 'created_at', t.created_at,
    'is_host', t.host_id is not null and t.host_id = auth.uid(),
    'host', jsonb_build_object(
      'name', case when t.host_id is null then 'Portal user' else public._gift_person_name(t.host_id) end,
      'avatar_url', (select avatar_url from public.profiles where id = t.host_id)),
    -- What first place wins in total (the list's headline): money summed, products counted.
    'first_place', (select jsonb_build_object('money', coalesce(sum(amount), 0), 'products', count(*) filter (where kind = 'product'))
                      from public.tournament_rewards where tournament_id = t.id and place = 1),
    'places', (select count(distinct place) from public.tournament_rewards where tournament_id = t.id)
  ) || case when p_rewards then jsonb_build_object('rewards', coalesce((
         select jsonb_agg(jsonb_build_object('place', r.place, 'slot', r.slot, 'kind', r.kind, 'amount', r.amount,
                                             'product_name', r.product_name, 'option_label', r.option_label,
                                             'region_label', r.region_label) order by r.place, r.slot)
           from public.tournament_rewards r where r.tournament_id = t.id), '[]'::jsonb))
       else '{}'::jsonb end
$$;
revoke all on function public._tournament_json(public.tournaments, boolean) from public, anon, authenticated;

-- p_scope: 'open' = published and not long started (soonest first); 'hosting' = the caller's own, every status
-- (newest first). p_game: null = both games.
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
  end if;
  raise exception 'invalid_scope' using errcode = '22023';
end;
$$;
revoke all on function public.tournament_list(text, text) from public, anon;
grant execute on function public.tournament_list(text, text) to authenticated;

create or replace function public.tournament_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_t public.tournaments;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_id;
  if not found then
    return null;
  end if;
  return public._tournament_json(v_t, true);
end;
$$;
revoke all on function public.tournament_detail(uuid) from public, anon;
grant execute on function public.tournament_detail(uuid) to authenticated;
