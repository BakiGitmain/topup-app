-- Tournaments: pay the entry fee (captain) or the rewards (host) with Telebirr / CBE, not only from the wallet.
-- Owner's request 2026-09-28. FORWARD-ONLY, re-runnable.
--
-- HOW: a tournament payment is an ORDINARY ORDER, marked `tournament_purpose` ('entry' | 'rewards'). So it goes
-- through exactly the machinery every shop order already uses and that is already tested live:
--   * the wallet pays it at once when the balance covers it (pay_order_with_wallet), otherwise
--   * the app opens the normal /pay/[id] screen: Telebirr or CBE, the transfer reference, then the verify-payment
--     Edge Function asks ShegerPay (begin/finish_payment_verification). A test key's payment is recorded as
--     payment_mode 'test' exactly like a shop order; switching to real money is ONLY switching the SHEGER_PAY_KEY
--     secret to a live key -- nothing here or in the app changes.
-- The moment such an order becomes 'paid' (whichever way), a trigger settles it in the same transaction:
--   entry   -> the team is registered (every rule re-checked); if it can't be any more (full, closed, a player joined
--              another team meanwhile) the money goes to the captain's WALLET at once and the order reads 'refunded'.
--   rewards -> the host's tournament (waiting as 'pending_payment') is published; if its start is already too close,
--              the money goes back to the host's wallet and the tournament is cancelled.
-- A settled tournament order is then 'completed' (or 'refunded') and frozen: the admin can't fail or refund it again,
-- and delivery (attemptFulfillment) only acts on 'paid'/'pending' orders, so it never sees one.
-- Cancelling the unpaid order (the pay screen's Cancel) cancels a waiting tournament; a team simply stays a draft.

-- ------------------------------------------------------------------------------------------------ order marker

alter table public.orders add column if not exists tournament_purpose text;
alter table public.orders add column if not exists tournament_id uuid references public.tournaments (id) on delete set null;
alter table public.orders add column if not exists tournament_team_id uuid references public.tournament_teams (id) on delete set null;
alter table public.orders drop constraint if exists orders_tournament_purpose_check;
alter table public.orders add constraint orders_tournament_purpose_check
  check (tournament_purpose is null or tournament_purpose in ('entry', 'rewards'));
alter table public.orders drop constraint if exists orders_tournament_not_gift_check;
alter table public.orders add constraint orders_tournament_not_gift_check
  check (tournament_purpose is null or gift_kind is null);
create index if not exists orders_tournament_idx on public.orders (tournament_id) where tournament_id is not null;
-- One open payment per team, and one rewards order per tournament.
create unique index if not exists orders_one_open_entry_per_team
  on public.orders (tournament_team_id) where tournament_purpose = 'entry' and status in ('pending_payment', 'payment_mismatch');
create unique index if not exists orders_one_rewards_order_per_tournament
  on public.orders (tournament_id) where tournament_purpose = 'rewards';

-- Which order paid a team's fee (its payment mode decides how a refund is labelled).
alter table public.tournament_teams add column if not exists fee_order_id uuid references public.orders (id) on delete set null;

-- A tournament whose rewards are waiting for a bank transfer.
alter table public.tournaments drop constraint if exists tournaments_status_check;
alter table public.tournaments add constraint tournaments_status_check
  check (status in ('pending_payment', 'published', 'cancelled', 'finished'));

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
  -- published -> cancelled | finished; pending_payment -> published | cancelled; nothing else moves.
  if new.status is distinct from old.status and not (
       (old.status = 'published' and new.status in ('cancelled', 'finished'))
       or (old.status = 'pending_payment' and new.status in ('published', 'cancelled'))) then
    raise exception 'tournament_closed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_tournament_update() from public, anon, authenticated;

-- A tournament order's identity and amount never change, and once settled it never moves again.
create or replace function public.guard_tournament_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.tournament_purpose is null then
    if new.tournament_purpose is not null then
      raise exception 'tournament_order_locked' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.tournament_purpose is distinct from old.tournament_purpose or new.amount is distinct from old.amount
     or new.user_id is distinct from old.user_id
     or (new.tournament_id is distinct from old.tournament_id and new.tournament_id is not null)
     or (new.tournament_team_id is distinct from old.tournament_team_id and new.tournament_team_id is not null) then
    raise exception 'tournament_order_locked' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending_payment' and new.status in ('paid', 'cancelled', 'payment_mismatch'))
       or (old.status = 'payment_mismatch' and new.status in ('paid', 'cancelled'))
       or (old.status = 'paid' and new.status in ('completed', 'refunded'))) then
    raise exception 'tournament_order_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_tournament_order() from public, anon, authenticated;
drop trigger if exists orders_tournament_guard on public.orders;
create trigger orders_tournament_guard before update on public.orders
  for each row execute function public.guard_tournament_order();

-- ------------------------------------------------------------------------------------------------ registering (shared)

-- Tries to register a team, taking `p_fee` as its held fee. Returns 'ok' or why not. Every rule re-checked here, under
-- the tournament's row lock (so two registrations can't race past the last spot).
create or replace function public._tournament_try_register(p_team uuid, p_fee numeric, p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_team  public.tournament_teams;
  v_t     public.tournaments;
  v_count integer;
  v_m     record;
  v_cap   text;
begin
  select * into v_team from public.tournament_teams where id = p_team;
  if not found then
    return 'team_not_found';
  end if;
  select * into v_t from public.tournaments where id = v_team.tournament_id for update;
  select * into v_team from public.tournament_teams where id = p_team for update;
  if v_team.status <> 'draft' then
    return 'team_locked';
  end if;
  if v_t.status <> 'published' or v_t.starts_at <= now() then
    return 'tournament_closed';
  end if;
  if v_t.host_id = v_team.captain_id then
    return 'host_cannot_join';
  end if;
  if (select count(*) from public.tournament_team_members
       where team_id = p_team and user_id is not null and game_id is not null and verified_at is not null) <> v_t.team_size then
    return 'team_incomplete';
  end if;
  select count(*) into v_count from public.tournament_teams where tournament_id = v_t.id and status = 'registered';
  if v_count >= v_t.team_count then
    return 'tournament_full';
  end if;
  begin
    update public.tournament_team_members set registered = true where team_id = p_team;
  exception when unique_violation then
    return 'already_in_team';
  end;
  update public.tournament_teams
     set status = 'registered', registered_at = now(), fee_paid = coalesce(p_fee, 0), fee_order_id = p_order, updated_at = now()
   where id = p_team;

  v_cap := public._gift_person_name(v_team.captain_id);
  perform public._tournament_notify(v_t.host_id, 'tournament_team_registered', 'New team registered',
    format('%s registered for %s (%s of %s teams).', v_team.name, v_t.name, v_count + 1, v_t.team_count),
    jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'team_name', v_team.name,
                       'teams', v_count + 1, 'team_count', v_t.team_count));
  for v_m in select user_id from public.tournament_team_members where team_id = p_team and user_id is distinct from v_team.captain_id loop
    perform public._tournament_notify(v_m.user_id, 'tournament_joined', 'You''re in a tournament team',
      format('%s added you to team %s for %s.', v_cap, v_team.name, v_t.name),
      jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'team_name', v_team.name, 'captain_name', v_cap));
  end loop;
  return 'ok';
end;
$$;
revoke all on function public._tournament_try_register(uuid, numeric, uuid) from public, anon, authenticated;

-- "[TEST KEY] " for money that came from a ShegerPay TEST verification (same tag as a test deposit).
create or replace function public._tournament_money_tag(p_order uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when (select payment_mode from public.orders where id = p_order) = 'test' then '[TEST KEY] ' else '' end
$$;
revoke all on function public._tournament_money_tag(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ settling a paid order

create or replace function public.tournament_order_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_result text;
  v_t      public.tournaments;
  v_team   public.tournament_teams;
begin
  if new.tournament_purpose = 'entry' then
    v_result := case when new.tournament_team_id is null then 'team_not_found'
                     else public._tournament_try_register(new.tournament_team_id, new.amount, new.id) end;
    if v_result = 'ok' then
      update public.orders set status = 'completed', completed_at = now() where id = new.id;
    else
      -- Paid, but the team can't take a spot any more: the money is the captain's again, at once, in the wallet.
      select * into v_team from public.tournament_teams where id = new.tournament_team_id;
      select * into v_t from public.tournaments where id = coalesce(v_team.tournament_id, new.tournament_id);
      perform public.wallet_apply(new.user_id, new.amount, 'tournament',
        left(public._tournament_money_tag(new.id) || 'Entry fee returned: ' || coalesce(v_t.name, 'tournament') || ' (' || v_result || ')', 200));
      update public.orders set status = 'refunded' where id = new.id;
      perform public._tournament_notify(new.user_id, 'tournament_entry_refunded', 'Registration didn''t go through',
        format('Your team couldn''t be registered for %s. The entry fee is back in your wallet.', coalesce(v_t.name, 'the tournament')),
        jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'reason', v_result, 'amount', new.amount));
    end if;

  elsif new.tournament_purpose = 'rewards' then
    select * into v_t from public.tournaments where id = new.tournament_id for update;
    if found and v_t.status = 'pending_payment' and v_t.starts_at > now() + interval '5 minutes' then
      update public.tournaments set status = 'published' where id = v_t.id;
      update public.orders set status = 'completed', completed_at = now() where id = new.id;
    else
      perform public.wallet_apply(new.user_id, new.amount, 'tournament',
        left(public._tournament_money_tag(new.id) || 'Tournament rewards returned: ' || coalesce(v_t.name, 'tournament') || ' (too late to publish)', 200));
      if found and v_t.status = 'pending_payment' then
        update public.tournaments set status = 'cancelled', cancelled_at = now() where id = v_t.id;
      end if;
      update public.orders set status = 'refunded' where id = new.id;
      perform public._tournament_notify(new.user_id, 'tournament_entry_refunded', 'Tournament not published',
        format('%s couldn''t be published because it starts too soon. The money is back in your wallet.', coalesce(v_t.name, 'Your tournament')),
        jsonb_build_object('tournament_id', v_t.id, 'tournament_name', v_t.name, 'reason', 'too_late', 'amount', new.amount));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.tournament_order_paid() from public, anon, authenticated;
drop trigger if exists orders_tournament_paid on public.orders;
create trigger orders_tournament_paid after update of status on public.orders
  for each row when (new.status = 'paid' and old.status is distinct from 'paid' and new.tournament_purpose is not null)
  execute function public.tournament_order_paid();

-- The host gave up on paying (the pay screen's Cancel): the waiting tournament is cancelled.
create or replace function public.tournament_order_cancelled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.tournaments set status = 'cancelled', cancelled_at = now()
   where id = new.tournament_id and status = 'pending_payment';
  return null;
end;
$$;
revoke all on function public.tournament_order_cancelled() from public, anon, authenticated;
drop trigger if exists orders_tournament_cancelled on public.orders;
create trigger orders_tournament_cancelled after update of status on public.orders
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.tournament_purpose = 'rewards')
  execute function public.tournament_order_cancelled();

-- Pays an order from the wallet if the balance covers it (as checkout_gift does); true = paid.
create or replace function public._tournament_try_wallet(p_order uuid, p_amount numeric)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if coalesce((select balance from public.wallets where user_id = auth.uid()), 0) < p_amount then
    return false;
  end if;
  begin
    perform public.pay_order_with_wallet(p_order);
    return true;
  exception when raise_exception then
    if sqlerrm <> 'insufficient_balance' then
      raise;
    end if;
    return false;
  end;
end;
$$;
revoke all on function public._tournament_try_wallet(uuid, numeric) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ hosting (replaces part 2)

-- As in 20261025090000, but a register tournament's rewards are paid through an ORDER: from the wallet at once when
-- it covers them (published straight away), otherwise the tournament waits as 'pending_payment' and the app opens
-- the bank-transfer screen for the returned order. Returns {id, paid, order_id?}. Extra error: pending_order_exists
-- (the one-unpaid-order rule every checkout has; detail = that order's id).
drop function if exists public.tournament_create(jsonb);
create function public.tournament_create(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
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
  v_order   uuid;
  v_pending uuid;
  v_paid    boolean;
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

    -- The same lock and one-unpaid-order rule as every checkout.
    perform pg_advisory_xact_lock(hashtextextended('create_cart_order:' || v_uid::text, 0));
    select id into v_pending from public.orders where user_id = v_uid and status = 'pending_payment';
    if found then
      raise exception 'pending_order_exists' using errcode = 'P0001', detail = v_pending::text;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('tournament_host'), hashtext(v_uid::text));
  if (select count(*) from public.tournaments where host_id = v_uid and status in ('published', 'pending_payment') and starts_at > now()) >= 10 then
    raise exception 'too_many_tournaments' using errcode = 'P0001';
  end if;

  insert into public.tournaments (host_id, kind, game, mode, name, team_size, team_count, entry_fee, starts_at,
                                  stream_platform, stream_url, prize_text, reward_hold, status)
  values (v_uid, v_kind, v_game, v_mode, v_name, v_size, v_count, round(v_fee, 2), v_starts, v_plat, v_url, v_prize, v_hold,
          case when v_kind = 'register' then 'pending_payment' else 'published' end)
  returning id into v_id;

  if v_kind = 'live' then
    return jsonb_build_object('id', v_id, 'paid', true);
  end if;

  insert into public.tournament_rewards (tournament_id, place, slot, kind, amount, option_id, product_name, option_label, region_label, price_paid)
  select v_id, public._tj_int(e -> 'place'), public._tj_int(e -> 'slot'), e ->> 'kind',
         case when e ->> 'kind' = 'money' then public._tj_money(e -> 'amount') end,
         o.id, pr.name, o.label, r.label, o.price
    from jsonb_array_elements(v_rewards) e
    left join public.product_options o on e ->> 'kind' = 'product' and o.id = (e ->> 'option_id')::uuid
    left join public.products pr on pr.id = o.product_id
    left join public.product_regions r on r.id = o.region_id;

  -- The rewards are paid through an order: the wallet if it covers them, else the bank-transfer screen.
  insert into public.orders (user_id, product_name, option_label, amount, status, delivery, fulfillment,
                             tournament_purpose, tournament_id)
  values (v_uid, 'Tournament rewards', v_name, v_hold, 'pending_payment', '{}'::jsonb, 'topup', 'rewards', v_id)
  returning id into v_order;
  v_paid := public._tournament_try_wallet(v_order, v_hold);

  return jsonb_build_object('id', v_id, 'paid', v_paid, 'order_id', v_order, 'amount', v_hold,
                            'status', (select status from public.tournaments where id = v_id));
end;
$$;
revoke all on function public.tournament_create(jsonb) from public, anon;
grant execute on function public.tournament_create(jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------------ registering (replaces part 2)

-- Registers the caller's saved draft. Free: at once. Paid: an entry order is created (or the team's open one is
-- returned) and paid from the wallet if it covers the fee; otherwise the app opens the bank-transfer screen for it.
-- Returns {team_id, status: 'registered' | 'awaiting_payment' | 'refunded', order_id?, balance}.
-- Errors (checked before any money moves): team_not_found, tournament_closed, host_cannot_join, team_incomplete,
-- tournament_full, pending_order_exists.
drop function if exists public.tournament_team_register(uuid);
create function public.tournament_team_register(p_team uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_team    public.tournament_teams;
  v_t       public.tournaments;
  v_result  text;
  v_order   uuid;
  v_pending uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_team from public.tournament_teams where id = p_team and captain_id = v_uid;
  if not found then
    raise exception 'team_not_found' using errcode = 'P0002';
  end if;
  if v_team.status = 'registered' then
    return jsonb_build_object('team_id', p_team, 'status', 'registered', 'already', true);
  end if;
  select * into v_t from public.tournaments where id = v_team.tournament_id;

  -- Its payment is already open: hand it back (the app reopens the pay screen).
  select id into v_order from public.orders
   where tournament_team_id = p_team and tournament_purpose = 'entry' and status in ('pending_payment', 'payment_mismatch');
  if found then
    return jsonb_build_object('team_id', p_team, 'status', 'awaiting_payment', 'order_id', v_order);
  end if;

  -- The same checks the registration itself makes, BEFORE any money moves.
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
  if (select count(*) from public.tournament_teams where tournament_id = v_t.id and status = 'registered') >= v_t.team_count then
    raise exception 'tournament_full' using errcode = 'P0001';
  end if;

  if v_t.entry_fee = 0 then
    v_result := public._tournament_try_register(p_team, 0, null);
    if v_result <> 'ok' then
      raise exception '%', v_result using errcode = 'P0001';
    end if;
    return jsonb_build_object('team_id', p_team, 'status', 'registered');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_cart_order:' || v_uid::text, 0));
  select id into v_pending from public.orders where user_id = v_uid and status = 'pending_payment';
  if found then
    raise exception 'pending_order_exists' using errcode = 'P0001', detail = v_pending::text;
  end if;
  insert into public.orders (user_id, product_name, option_label, amount, status, delivery, fulfillment,
                             tournament_purpose, tournament_id, tournament_team_id)
  values (v_uid, 'Tournament entry', left(v_t.name || ' · ' || v_team.name, 200), v_t.entry_fee, 'pending_payment',
          '{}'::jsonb, 'topup', 'entry', v_t.id, p_team)
  returning id into v_order;

  if public._tournament_try_wallet(v_order, v_t.entry_fee) then
    return jsonb_build_object('team_id', p_team, 'order_id', v_order,
      'status', case (select status from public.orders where id = v_order) when 'completed' then 'registered' else 'refunded' end,
      'balance', (select balance from public.wallets where user_id = v_uid));
  end if;
  return jsonb_build_object('team_id', p_team, 'status', 'awaiting_payment', 'order_id', v_order,
                            'balance', (select balance from public.wallets where user_id = v_uid));
end;
$$;
revoke all on function public.tournament_team_register(uuid) from public, anon;
grant execute on function public.tournament_team_register(uuid) to authenticated;

-- A team whose payment is open can't be edited or thrown away (what is being paid for must not change).
create or replace function public.guard_team_while_paying()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_team uuid := coalesce(new.team_id, old.team_id);
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.orders where tournament_team_id = v_team and tournament_purpose = 'entry'
               and status in ('pending_payment', 'payment_mismatch')) then
    raise exception 'payment_in_progress' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.guard_team_while_paying() from public, anon, authenticated;
drop trigger if exists tournament_members_paying_guard on public.tournament_team_members;
create trigger tournament_members_paying_guard before insert or update or delete on public.tournament_team_members
  for each row when (pg_trigger_depth() = 0)
  execute function public.guard_team_while_paying();

create or replace function public.guard_team_row_while_paying()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.orders where tournament_team_id = old.id and tournament_purpose = 'entry'
               and status in ('pending_payment', 'payment_mismatch'))
     and (tg_op = 'DELETE' or new.name is distinct from old.name) then
    raise exception 'payment_in_progress' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.guard_team_row_while_paying() from public, anon, authenticated;
drop trigger if exists tournament_teams_paying_guard on public.tournament_teams;
create trigger tournament_teams_paying_guard before update or delete on public.tournament_teams
  for each row when (pg_trigger_depth() = 0)
  execute function public.guard_team_row_while_paying();

-- ------------------------------------------------------------------------------------------------ cancel (replaces part 2)

-- As in 20261025090000, plus: open entry payments are cancelled (a transfer being checked right now settles later and,
-- finding the tournament cancelled, goes straight back to the captain's wallet), and a refund of money that came from
-- a ShegerPay TEST verification is labelled [TEST KEY]. A tournament still waiting for its rewards payment is cancelled
-- through its order (the pay screen's Cancel), never here.
create or replace function public.tournament_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t      public.tournaments;
  v_team   record;
  v_who    uuid;
  v_reward uuid;
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

  update public.orders
     set status = 'cancelled', payment_provider = null, payment_reference = null, verifying_since = null
   where tournament_id = p_id and tournament_purpose = 'entry' and status = 'pending_payment'
     and (verifying_since is null or verifying_since < now() - interval '90 seconds');

  for v_team in select * from public.tournament_teams where tournament_id = p_id and status = 'registered' for update loop
    if v_team.fee_paid > 0 and v_team.captain_id is not null then
      perform public.wallet_apply(v_team.captain_id, v_team.fee_paid, 'tournament',
        left(public._tournament_money_tag(v_team.fee_order_id) || 'Entry fee refunded: ' || v_t.name || ' (tournament cancelled)', 200));
    end if;
    update public.tournament_teams set status = 'cancelled', updated_at = now() where id = v_team.id;
  end loop;
  delete from public.tournament_teams tt where tt.tournament_id = p_id and tt.status = 'draft'
     and not exists (select 1 from public.orders o where o.tournament_team_id = tt.id and o.status in ('pending_payment', 'payment_mismatch'));

  if v_t.reward_hold > 0 and v_t.host_id is not null then
    select id into v_reward from public.orders where tournament_id = p_id and tournament_purpose = 'rewards';
    perform public.wallet_apply(v_t.host_id, v_t.reward_hold, 'tournament',
      left(coalesce(public._tournament_money_tag(v_reward), '') || 'Tournament rewards returned: ' || v_t.name || ' (cancelled)', 200));
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

-- ------------------------------------------------------------------------------------------------ reading

-- As in 20261025090000, plus the open payment: `payment_order_id` on the tournament (host, rewards waiting) and on
-- my_team (captain, entry waiting), so the app can reopen the pay screen.
create or replace function public._tournament_json(t public.tournaments, p_rewards boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'game', t.game, 'mode', t.mode, 'name', t.name,
    'team_size', t.team_size, 'team_count', t.team_count, 'entry_fee', t.entry_fee,
    'starts_at', t.starts_at, 'stream_platform', t.stream_platform, 'stream_url', t.stream_url,
    'prize_text', t.prize_text, 'rewards_funded', t.reward_hold > 0 and t.status <> 'pending_payment',
    'status', t.status, 'created_at', t.created_at,
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
                        from public._tournament_check_region(t.game) c where c.region_id is not null))
       else '{}'::jsonb end
$$;
revoke all on function public._tournament_json(public.tournaments, boolean) from public, anon, authenticated;

-- A tournament still waiting for its rewards payment is its host's alone.
create or replace function public.tournament_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_t public.tournaments;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_t from public.tournaments where id = p_id;
  if not found or (v_t.status = 'pending_payment' and v_t.host_id is distinct from auth.uid()) then
    return null;
  end if;
  return public._tournament_json(v_t, true);
end;
$$;
revoke all on function public.tournament_detail(uuid) from public, anon;
grant execute on function public.tournament_detail(uuid) to authenticated;
