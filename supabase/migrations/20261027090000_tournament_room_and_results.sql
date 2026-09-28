-- Tournaments, part 3: the room (ID + password) and the end (winners, payouts). Owner's request 2026-09-28.
-- FORWARD-ONLY, re-runnable.
--
-- ROOM: the host types the custom room's ID and password and posts them (and can correct them). Who sees them:
--   live      everyone signed in (it is a public, streamed event);
--   register  the host and the players of registered teams only.
-- Posting tells the people who can see them (live: whoever asked to be reminded; register: every registered player)
-- that the room is ready -- the notification never carries the ID or the password, the app shows them.
-- (A custom-room password is a one-match game lobby code the host shares on purpose, not anyone's account password.)
--
-- END: the host ends the event once it has started.
--   live      just marked finished (its prize is the host's own business).
--   register  the host picks the winning team of each rewarded place, and everything is paid in ONE transaction:
--               * each player of a winning team gets THEIR slot's reward: money straight into their wallet, a pack as a
--                 gift in their Vault (claimed with their own ID, the normal gift flow) -- backed by the money the host
--                 already paid at publish (reward_hold), so no wallet line is taken twice;
--               * a pack that no longer exists pays its price to the player instead (never lost);
--               * a reward nobody can receive (a place with no team: fewer teams than places; a deleted account)
--                 goes back to the host;
--               * the host gets 85% of the entry fees (tournament_host_share(); the platform keeps the rest).
--             Every birr of reward_hold is accounted for: paid out, turned into gifts, or returned.
-- Every player is told how it ended; winners are told their place.

-- ------------------------------------------------------------------------------------------------ room

create table if not exists public.tournament_rooms (
  tournament_id  uuid primary key references public.tournaments (id) on delete cascade,
  room_id        text not null check (char_length(room_id) between 1 and 40 and room_id !~ '[[:cntrl:]]'),
  room_password  text check (room_password is null or (char_length(room_password) between 1 and 40 and room_password !~ '[[:cntrl:]]')),
  posted_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  notified_at    timestamptz
);
alter table public.tournament_rooms enable row level security;
revoke all on public.tournament_rooms from anon, authenticated;

-- Whether this person may see the room of this tournament.
create or replace function public._tournament_room_visible(p_t public.tournaments, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and (
    p_t.host_id = p_user
    or (p_t.kind = 'live' and p_t.status in ('published', 'finished'))
    or exists (select 1 from public.tournament_team_members m
                 join public.tournament_teams tt on tt.id = m.team_id
                where m.tournament_id = p_t.id and m.user_id = p_user and m.registered and tt.status = 'registered'))
$$;
revoke all on function public._tournament_room_visible(public.tournaments, uuid) from public, anon, authenticated;

-- Posts (or corrects) the room. Host only, while the tournament is on. Empty password = the room has none.
-- Errors: tournament_not_found, tournament_closed, invalid_room.
create or replace function public.tournament_post_room(p_id uuid, p_room_id text, p_password text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t     public.tournaments;
  v_room  text := btrim(coalesce(p_room_id, ''));
  v_pass  text := nullif(btrim(coalesce(p_password, '')), '');
  v_old   public.tournament_rooms;
  v_who   uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_id for update;
  if not found or v_t.host_id is distinct from auth.uid() then
    raise exception 'tournament_not_found' using errcode = 'P0002';
  end if;
  if v_t.status <> 'published' then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  if char_length(v_room) < 1 or char_length(v_room) > 40 or v_room ~ '[[:cntrl:]]'
     or (v_pass is not null and (char_length(v_pass) > 40 or v_pass ~ '[[:cntrl:]]')) then
    raise exception 'invalid_room' using errcode = '22023';
  end if;

  select * into v_old from public.tournament_rooms where tournament_id = p_id;
  if found and v_old.room_id = v_room and v_old.room_password is not distinct from v_pass then
    return; -- nothing changed
  end if;
  insert into public.tournament_rooms (tournament_id, room_id, room_password)
  values (p_id, v_room, v_pass)
  on conflict (tournament_id) do update set room_id = excluded.room_id, room_password = excluded.room_password, updated_at = now();

  -- Tell whoever can see it. Not more than once a minute (a host fixing a typo twice doesn't ping everyone twice).
  if v_old.notified_at is null or v_old.notified_at < now() - interval '1 minute' then
    for v_who in
      select distinct u from (
        select m.user_id as u from public.tournament_team_members m
          join public.tournament_teams tt on tt.id = m.team_id
         where m.tournament_id = p_id and m.registered and tt.status = 'registered'
        union
        select r.user_id from public.tournament_reminders r where r.tournament_id = p_id and v_t.kind = 'live'
      ) x where u is not null and u is distinct from v_t.host_id
    loop
      perform public._tournament_notify(v_who, 'tournament_room_posted',
        case when v_old.tournament_id is null then 'Room details are ready' else 'Room details were updated' end,
        format('Open %s to see the room ID and password.', v_t.name),
        jsonb_build_object('tournament_id', p_id, 'tournament_name', v_t.name, 'updated', v_old.tournament_id is not null));
    end loop;
    update public.tournament_rooms set notified_at = now() where tournament_id = p_id;
  end if;
end;
$$;
revoke all on function public.tournament_post_room(uuid, text, text) from public, anon;
grant execute on function public.tournament_post_room(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------------------------------------ results

create table if not exists public.tournament_results (
  tournament_id  uuid not null references public.tournaments (id) on delete cascade,
  place          integer not null check (place between 1 and 10),
  team_id        uuid references public.tournament_teams (id) on delete set null,
  team_name      text not null,
  primary key (tournament_id, place)
);
create unique index if not exists tournament_results_team_once on public.tournament_results (tournament_id, team_id) where team_id is not null;
alter table public.tournament_results enable row level security;
revoke all on public.tournament_results from anon, authenticated;

-- A prize pack is a gift from the host, backed by the money they already paid at publish (not taken again).
alter table public.orders drop constraint if exists orders_tournament_purpose_check;
alter table public.orders add constraint orders_tournament_purpose_check
  check (tournament_purpose is null or tournament_purpose in ('entry', 'rewards', 'prize'));
alter table public.orders drop constraint if exists orders_tournament_not_gift_check;
alter table public.orders add constraint orders_tournament_not_gift_check
  check (tournament_purpose is null or (gift_kind is null) = (tournament_purpose <> 'prize'));

-- The host's share of the entry fees (the platform keeps the rest). The one place the 85% lives.
create or replace function public.tournament_host_share()
returns numeric language sql immutable as $$ select 0.85::numeric $$;
revoke all on function public.tournament_host_share() from public, anon, authenticated;

-- Ends a tournament. Host only, once it has started.
--   live:     p is ignored ({}).
--   register: p = {placements: [{place, team_id}]} -- every rewarded place that CAN have a team must get one: places
--             1..min(places, registered teams), each a different registered team of this tournament.
-- Returns {status:'finished', paid_to_players, gifts, fees_to_host, returned_to_host}.
-- Errors: tournament_not_found, tournament_closed, not_started, invalid_placements.
create or replace function public.tournament_finish(p_id uuid, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_t        public.tournaments;
  v_places   integer;
  v_teams    integer;
  v_need     integer;
  v_pl       jsonb;
  v_place    integer;
  v_team     public.tournament_teams;
  v_r        record;
  v_member   record;
  v_order    uuid;
  v_paid     numeric(14, 2) := 0;
  v_gifts    integer := 0;
  v_back     numeric(14, 2) := 0;
  v_fees     numeric(14, 2) := 0;
  v_share    numeric(14, 2) := 0;
  v_place_label text;
  v_who      uuid;
  v_pack     record;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_id for update;
  if not found or v_t.host_id is distinct from auth.uid() then
    raise exception 'tournament_not_found' using errcode = 'P0002';
  end if;
  if v_t.status <> 'published' then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  if v_t.starts_at > now() then
    raise exception 'not_started' using errcode = 'P0001';
  end if;

  if v_t.kind = 'live' then
    update public.tournaments set status = 'finished', finished_at = now() where id = p_id;
    return jsonb_build_object('status', 'finished');
  end if;

  -- No new registrations or payments can land while this runs (they lock the tournament row too).
  update public.orders
     set status = 'cancelled', payment_provider = null, payment_reference = null, verifying_since = null
   where tournament_id = p_id and tournament_purpose = 'entry' and status = 'pending_payment'
     and (verifying_since is null or verifying_since < now() - interval '90 seconds');

  select count(distinct place) into v_places from public.tournament_rewards where tournament_id = p_id;
  select count(*) into v_teams from public.tournament_teams where tournament_id = p_id and status = 'registered';
  v_need := least(v_places, v_teams);

  -- The placements: exactly places 1..v_need, each a different registered team of this tournament.
  if jsonb_typeof(coalesce(p -> 'placements', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p -> 'placements', '[]'::jsonb)) <> v_need
     or exists (select 1 from jsonb_array_elements(coalesce(p -> 'placements', '[]'::jsonb)) e
                 where jsonb_typeof(e) <> 'object' or public._tj_int(e -> 'place') is null
                    or public._tj_int(e -> 'place') < 1 or public._tj_int(e -> 'place') > v_need
                    or coalesce(e ->> 'team_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or not exists (select 1 from public.tournament_teams tt
                                    where tt.id = (e ->> 'team_id')::uuid and tt.tournament_id = p_id and tt.status = 'registered'))
     or (select count(distinct public._tj_int(e -> 'place')) from jsonb_array_elements(coalesce(p -> 'placements', '[]'::jsonb)) e) <> v_need
     or (select count(distinct e ->> 'team_id') from jsonb_array_elements(coalesce(p -> 'placements', '[]'::jsonb)) e) <> v_need then
    raise exception 'invalid_placements' using errcode = '22023';
  end if;

  for v_pl in select e from jsonb_array_elements(coalesce(p -> 'placements', '[]'::jsonb)) e order by public._tj_int(e -> 'place') loop
    v_place := public._tj_int(v_pl -> 'place');
    select * into v_team from public.tournament_teams where id = (v_pl ->> 'team_id')::uuid;
    insert into public.tournament_results (tournament_id, place, team_id, team_name) values (p_id, v_place, v_team.id, v_team.name);
    v_place_label := case v_place when 1 then '1st' when 2 then '2nd' when 3 then '3rd' else v_place || 'th' end;

    for v_r in select * from public.tournament_rewards where tournament_id = p_id and place = v_place order by slot loop
      select m.user_id into v_member from public.tournament_team_members m where m.team_id = v_team.id and m.slot = v_r.slot;
      if v_member.user_id is null or not exists (select 1 from public.profiles where id = v_member.user_id) then
        -- Nobody to receive it (the account is gone): the host gets it back.
        v_back := v_back + coalesce(v_r.amount, v_r.price_paid, 0);
        continue;
      end if;

      if v_r.kind = 'money' then
        perform public.wallet_apply(v_member.user_id, v_r.amount, 'tournament',
          left('Prize: ' || v_t.name || ' (' || v_place_label || ' place)', 200));
        v_paid := v_paid + v_r.amount;
      else
        select o.id, o.label, o.product_id, p.name as product_name, p.category, r.label as region_label into v_pack
          from public.product_options o
          join public.products p on p.id = o.product_id
          left join public.product_regions r on r.id = o.region_id
         where o.id = v_r.option_id and o.is_active and p.is_active and (o.region_id is null or r.is_active);
        if not found then
          -- The pack is gone or no longer sold (a gift of it could never be claimed): its price, as paid by the host,
          -- goes to the player instead.
          perform public.wallet_apply(v_member.user_id, v_r.price_paid, 'tournament',
            left('Prize: ' || v_t.name || ' (' || v_place_label || ' place, ' || v_r.product_name || ' ' || v_r.option_label || ' no longer sold)', 200));
          v_paid := v_paid + v_r.price_paid;
        else
          -- A gift from the host, backed by the reward money already held: the order is born settled (nobody is charged
          -- again, and it never counts as the host's one open payment) and the gift row is written right here, exactly as
          -- gift_on_paid would. The player claims it from their Vault with their own ID.
          insert into public.orders (user_id, option_id, product_name, option_label, amount, status, delivery, fulfillment,
                                     region_label, gift_kind, gift_recipient_id, gift_fields, tournament_purpose, tournament_id,
                                     paid_at, payment_provider, payment_mode, payment_verified_amount)
          values (v_t.host_id, v_pack.id, v_pack.product_name, v_pack.label, v_r.price_paid, 'paid', '{}'::jsonb,
                  case when v_pack.category in ('games', 'airtime', 'subscriptions') then 'topup' else 'code' end,
                  v_pack.region_label, 'gift', v_member.user_id, '{}'::jsonb, 'prize', p_id,
                  now(), 'wallet', 'wallet', v_r.price_paid)
          returning id into v_order;
          insert into public.gifts (order_id, product_id, option_id, sender_id, recipient_user_id, expires_at)
          values (v_order, v_pack.product_id, v_pack.id, v_t.host_id, v_member.user_id, now() + public.gift_ttl());
          v_gifts := v_gifts + 1;
        end if;
      end if;
    end loop;

    for v_member in select m.user_id from public.tournament_team_members m where m.team_id = v_team.id and m.user_id is not null loop
      perform public._tournament_notify(v_member.user_id, 'tournament_won', 'You won a prize!',
        format('Your team %s finished %s in %s. Your prize is in your wallet or Vault.', v_team.name, v_place_label, v_t.name),
        jsonb_build_object('tournament_id', p_id, 'tournament_name', v_t.name, 'team_name', v_team.name, 'place', v_place));
    end loop;
  end loop;

  -- Rewards of places no team could take (fewer teams than places) go back to the host.
  select v_back + coalesce(sum(coalesce(amount, price_paid)), 0) into v_back
    from public.tournament_rewards
   where tournament_id = p_id and place > v_need;
  if v_back > 0 then
    perform public.wallet_apply(v_t.host_id, v_back, 'tournament', left('Unused prizes returned: ' || v_t.name, 200));
  end if;

  -- The host's share of the entry fees.
  select coalesce(sum(fee_paid), 0) into v_fees from public.tournament_teams where tournament_id = p_id and status = 'registered';
  v_share := floor(v_fees * public.tournament_host_share() * 100) / 100;
  if v_share > 0 then
    perform public.wallet_apply(v_t.host_id, v_share, 'tournament',
      left('Entry fees (' || (public.tournament_host_share() * 100)::integer || '%): ' || v_t.name, 200));
  end if;

  update public.tournaments set status = 'finished', finished_at = now() where id = p_id;

  -- Everyone else who played is told it's over.
  for v_who in
    select distinct m.user_id from public.tournament_team_members m
      join public.tournament_teams tt on tt.id = m.team_id
     where m.tournament_id = p_id and m.registered and tt.status = 'registered' and m.user_id is not null
       and not exists (select 1 from public.tournament_results r where r.tournament_id = p_id and r.team_id = tt.id)
  loop
    perform public._tournament_notify(v_who, 'tournament_finished', 'Tournament finished',
      format('%s is over. See the results.', v_t.name),
      jsonb_build_object('tournament_id', p_id, 'tournament_name', v_t.name));
  end loop;

  return jsonb_build_object('status', 'finished', 'paid_to_players', v_paid, 'gifts', v_gifts,
                            'fees_to_host', v_share, 'returned_to_host', v_back);
end;
$$;
revoke all on function public.tournament_finish(uuid, jsonb) from public, anon;
grant execute on function public.tournament_finish(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------ reading

-- As in 20261026090000, plus: `room` (only for who may see it; `room_posted` tells everyone else whether it exists),
-- `results` (place + team name, once finished) and `my_place` (the caller's team's place, if it placed).
create or replace function public._tournament_json(t public.tournaments, p_rewards boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'game', t.game, 'mode', t.mode, 'name', t.name,
    'team_size', t.team_size, 'team_count', t.team_count, 'entry_fee', t.entry_fee,
    'starts_at', t.starts_at, 'stream_platform', t.stream_platform, 'stream_url', t.stream_url,
    'prize_text', t.prize_text, 'rewards_funded', t.reward_hold > 0 and t.status <> 'pending_payment',
    'status', t.status, 'created_at', t.created_at, 'finished_at', t.finished_at,
    'is_host', t.host_id is not null and t.host_id = auth.uid(),
    'payment_order_id', case when t.host_id = auth.uid() and t.status = 'pending_payment' then
        (select o.id from public.orders o where o.tournament_id = t.id and o.tournament_purpose = 'rewards'
            and o.status in ('pending_payment', 'payment_mismatch')) end,
    'host', jsonb_build_object(
      'name', case when t.host_id is null then 'Portal user' else public._gift_person_name(t.host_id) end,
      'avatar_url', (select avatar_url from public.profiles where id = t.host_id)),
    'first_place', (select jsonb_build_object('money', coalesce(sum(amount), 0), 'products', count(*) filter (where kind = 'product'))
                      from public.tournament_rewards where tournament_id = t.id and place = 1),
    'places', (select count(distinct place) from public.tournament_rewards where tournament_id = t.id),
    'teams_registered', (select count(*) from public.tournament_teams where tournament_id = t.id and status = 'registered'),
    'reminded', exists (select 1 from public.tournament_reminders where tournament_id = t.id and user_id = auth.uid()),
    'room_posted', exists (select 1 from public.tournament_rooms where tournament_id = t.id),
    'my_place', (select r.place from public.tournament_results r
                   join public.tournament_team_members m on m.team_id = r.team_id and m.user_id = auth.uid()
                  where r.tournament_id = t.id limit 1),
    'my_team', (select jsonb_build_object('id', tt.id, 'name', tt.name, 'status', tt.status, 'is_captain', tt.captain_id = auth.uid(),
                                          'payment_order_id', case when tt.captain_id = auth.uid() then
                                            (select o.id from public.orders o where o.tournament_team_id = tt.id and o.tournament_purpose = 'entry'
                                                and o.status in ('pending_payment', 'payment_mismatch')) end)
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
         'teams', coalesce((
           select jsonb_agg(public._tournament_team_json(tt.id, t.host_id = auth.uid()) order by tt.registered_at, tt.id)
             from public.tournament_teams tt where tt.tournament_id = t.id and tt.status = 'registered'), '[]'::jsonb),
         'id_check', (select jsonb_build_object('region_id', c.region_id, 'field_key', c.field_key, 'field_label', c.field_label)
                        from public._tournament_check_region(t.game) c where c.region_id is not null),
         'room', (select jsonb_build_object('room_id', ro.room_id, 'password', ro.room_password, 'updated_at', ro.updated_at)
                    from public.tournament_rooms ro
                   where ro.tournament_id = t.id and public._tournament_room_visible(t, auth.uid())),
         'results', coalesce((
           select jsonb_agg(jsonb_build_object('place', r.place, 'team_name', r.team_name) order by r.place)
             from public.tournament_results r where r.tournament_id = t.id), '[]'::jsonb))
       else '{}'::jsonb end
$$;
revoke all on function public._tournament_json(public.tournaments, boolean) from public, anon, authenticated;
