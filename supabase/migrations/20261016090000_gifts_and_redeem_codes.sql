-- Gifts and redeem codes, part 1 of 4: the data model, redeem-code generation, and the single-winner redeem/claim
-- core. No UI, no purchase flow (part 2), no vault screen (part 3). FORWARD-ONLY, like every migration here: purely
-- additive (two tables, one attempts log, functions, one guard trigger on orders); no existing column changes, no
-- backfill. Re-runnable (the DB test suites apply every migration twice).
--
-- Shape:
--   * A gift or a redeem code is backed by exactly one PAID order (orders.id): what was actually paid, by whom, how.
--     The order is the buyer's; it is never delivered itself (see the guard trigger, 5).
--   * redeem_codes: a 10-char code the buyer hands to anyone. Redeeming it turns it into a gift for the redeemer
--     (gifts.redeem_code_id), so "claim" is the ONE place a gift/code ever becomes a delivery.
--   * gifts: pending in the recipient's vault until claimed (with a player ID if the pack needs one) or expired.
--   * Both expire gift_ttl() (90 days) after creation. Expired = unclaimable/unredeemable, nothing else: refunds on
--     expiry are an OPEN decision, deliberately not built.
--   * The supplier is NEVER called here. Creating a gift/code only records it; claiming only flips it to 'claimed'
--     and records the player fields. Turning a claimed gift into a supplier order is part 2/3's job (see CLAUDE.md).

-- ------------------------------------------------------------------------------------------------ 1. constants

-- How long a gift or a redeem code lives. Change it here only.
create or replace function public.gift_ttl()
returns interval language sql immutable as $$ select interval '90 days' $$;

-- Redeem attempts: at most this many FAILED tries per user, and per client IP when the request carries one, in the
-- window. A 10-char code from 36 characters is ~3.7e15 combinations; 10 misses per 10 minutes makes guessing hopeless.
create or replace function public.redeem_limits()
returns table (per_user integer, per_ip integer, window_length interval)
language sql immutable as $$ select 10, 30, interval '10 minutes' $$;

-- ------------------------------------------------------------------------------------------------ 2. tables

create table if not exists public.redeem_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{10}$'),
  -- restrict, not cascade: a paid-for code must never vanish as a side effect of deleting its buyer (whose orders
  -- cascade away with them); that deletion is refused until the code is dealt with on purpose.
  order_id    uuid not null unique references public.orders (id) on delete restrict,
  product_id  uuid not null references public.products (id) on delete restrict,
  option_id   uuid not null references public.product_options (id) on delete restrict,
  created_by  uuid not null references public.profiles (id) on delete cascade,
  status      text not null default 'active' check (status in ('active', 'redeemed', 'expired')),
  redeemed_by uuid references public.profiles (id) on delete set null,
  redeemed_at timestamptz,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  constraint redeem_codes_redeemed_shape check ((status = 'redeemed') = (redeemed_at is not null))
);
create index if not exists redeem_codes_created_by_idx on public.redeem_codes (created_by, created_at desc);
create index if not exists redeem_codes_active_expiry_idx on public.redeem_codes (expires_at) where status = 'active';

create table if not exists public.gifts (
  id                uuid primary key default gen_random_uuid(),
  -- one gift per paid order; a gift born from a redeem code shares that code's order
  order_id          uuid not null unique references public.orders (id) on delete restrict, -- see redeem_codes.order_id
  product_id        uuid not null references public.products (id) on delete restrict,
  option_id         uuid not null references public.product_options (id) on delete restrict,
  sender_id         uuid references public.profiles (id) on delete set null,
  recipient_user_id uuid not null references public.profiles (id) on delete cascade,
  -- backstop: a code can become at most ONE gift, whatever the application does
  redeem_code_id    uuid unique references public.redeem_codes (id) on delete set null,
  status            text not null default 'pending' check (status in ('pending', 'claimed', 'expired')),
  -- the player ID (every buyer field, normalized) given at claim time, when the pack needs one
  player_fields     jsonb,
  claimed_at        timestamptz,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  constraint gifts_claimed_shape check ((status = 'claimed') = (claimed_at is not null))
);
create index if not exists gifts_recipient_idx on public.gifts (recipient_user_id, created_at desc);
create index if not exists gifts_sender_idx on public.gifts (sender_id, created_at desc);
create index if not exists gifts_pending_expiry_idx on public.gifts (expires_at) where status = 'pending';

-- The redeem rate-limit log. Never stores the code that was tried.
create table if not exists public.redeem_code_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  ip         text,
  succeeded  boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists redeem_code_attempts_user_idx on public.redeem_code_attempts (user_id, created_at desc);
create index if not exists redeem_code_attempts_ip_idx on public.redeem_code_attempts (ip, created_at desc) where ip is not null;

-- ------------------------------------------------------------------------------------------------ 3. access

alter table public.redeem_codes enable row level security;
alter table public.gifts enable row level security;
alter table public.redeem_code_attempts enable row level security;

drop policy if exists redeem_codes_select on public.redeem_codes;
create policy redeem_codes_select on public.redeem_codes
  for select to authenticated
  using (created_by = (select auth.uid()) or redeemed_by = (select auth.uid()) or (select public.is_admin()));

drop policy if exists gifts_select on public.gifts;
create policy gifts_select on public.gifts
  for select to authenticated
  using (recipient_user_id = (select auth.uid()) or sender_id = (select auth.uid()) or (select public.is_admin()));

-- Read-only to customers (RLS picks the rows); every write goes through the functions below.
revoke all on public.redeem_codes, public.gifts, public.redeem_code_attempts from public, anon, authenticated;
grant select on public.redeem_codes, public.gifts to authenticated;

-- ------------------------------------------------------------------------------------------------ 4. backstops

-- A final state is final: once redeemed/claimed/expired nothing moves it, and the identity of a record never
-- changes. Even an application bug doing read-then-write cannot redeem or claim anything twice.
create or replace function public.guard_redeem_code_update()
returns trigger language plpgsql as $$
begin
  -- Depth 2+ = the database's own foreign-key action (a profile deleted, its link emptied): not an edit.
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if old.status <> 'active' then
    raise exception 'redeem_code_final' using errcode = 'P0001';
  end if;
  if new.code <> old.code or new.order_id <> old.order_id or new.option_id <> old.option_id
     or new.product_id <> old.product_id or new.created_by <> old.created_by or new.expires_at <> old.expires_at then
    raise exception 'redeem_code_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists redeem_codes_guard on public.redeem_codes;
create trigger redeem_codes_guard before update on public.redeem_codes
  for each row execute function public.guard_redeem_code_update();

create or replace function public.guard_gift_update()
returns trigger language plpgsql as $$
begin
  -- Depth 2+ = the database's own foreign-key action (a profile deleted, its link emptied): not an edit.
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'gift_final' using errcode = 'P0001';
  end if;
  if new.order_id <> old.order_id or new.option_id <> old.option_id or new.product_id <> old.product_id
     or new.recipient_user_id <> old.recipient_user_id or new.expires_at <> old.expires_at
     or new.redeem_code_id is distinct from old.redeem_code_id then
    raise exception 'gift_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists gifts_guard on public.gifts;
create trigger gifts_guard before update on public.gifts
  for each row execute function public.guard_gift_update();

-- 5. The order behind a gift or code is frozen at 'paid': it can never be delivered (the supplier is called only for
-- a CLAIMED gift, through its own delivery), and never refunded or failed while the gift/code could still be used
-- (that would hand out the product for free). What happens to it on expiry is the open refund decision.
create or replace function public.guard_gift_backed_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and (exists (select 1 from public.gifts where order_id = old.id)
          or exists (select 1 from public.redeem_codes where order_id = old.id)) then
    raise exception 'gift_order_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_gift_backed_order() from public, anon, authenticated;
drop trigger if exists orders_gift_backed_guard on public.orders;
create trigger orders_gift_backed_guard before update of status on public.orders
  for each row execute function public.guard_gift_backed_order();

-- ------------------------------------------------------------------------------------------------ 6. code generation

-- 10 characters from A-Z0-9, from a cryptographically strong source: gen_random_uuid() draws on pg_strong_random
-- (the OS CSPRNG). Only the 13 fully random bytes of each UUID are used (bytes 6 and 8 carry version/variant bits),
-- and bytes >= 252 are thrown away so each of the 36 characters is exactly equally likely (252 = 7 x 36).
create or replace function public.generate_redeem_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  v_code     text := '';
  v_bytes    bytea;
  v_byte     integer;
  v_i        integer;
begin
  while length(v_code) < 10 loop
    v_bytes := uuid_send(gen_random_uuid());
    for v_i in 0 .. 15 loop
      continue when v_i in (6, 8);
      v_byte := get_byte(v_bytes, v_i);
      continue when v_byte >= 252;
      v_code := v_code || substr(v_alphabet, (v_byte % 36) + 1, 1);
      exit when length(v_code) = 10;
    end loop;
  end loop;
  return v_code;
end;
$$;
revoke all on function public.generate_redeem_code() from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------ 7. creation (internal)

-- What a giftable order bought: exactly one pack, once. Refuses anything that isn't a captured payment.
create or replace function public._giftable_order(p_order_id uuid)
returns table (user_id uuid, option_id uuid, product_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_order  public.orders;
  v_option uuid;
  v_lines  integer;
  v_qty    integer;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  -- Only a captured payment backs a gift or code.
  if v_order.status <> 'paid' then
    raise exception 'order_not_paid' using errcode = 'P0001', detail = v_order.status;
  end if;
  if exists (select 1 from public.gifts g where g.order_id = p_order_id)
     or exists (select 1 from public.redeem_codes c where c.order_id = p_order_id) then
    raise exception 'order_already_gifted' using errcode = 'P0001';
  end if;

  v_option := v_order.option_id;
  if v_option is null then
    select count(*), min(i.quantity) into v_lines, v_qty from public.order_items i where i.order_id = p_order_id;
    if v_lines <> 1 or v_qty <> 1 then
      raise exception 'order_not_giftable' using errcode = 'P0001';
    end if;
    select i.option_id into v_option from public.order_items i where i.order_id = p_order_id;
  end if;

  -- Still on sale: the product, its region and the pack itself.
  if not exists (
    select 1 from public.product_options o
      join public.products p on p.id = o.product_id
      left join public.product_regions r on r.id = o.region_id
     where o.id = v_option and o.is_active and p.is_active and (o.region_id is null or r.is_active)
  ) then
    raise exception 'pack_unavailable' using errcode = 'P0001';
  end if;

  return query select v_order.user_id, v_option, (select o.product_id from public.product_options o where o.id = v_option);
end;
$$;
revoke all on function public._giftable_order(uuid) from public, anon, authenticated, service_role;

-- A redeem code for a paid order. A collision with an existing code is simply retried with a new one.
create or replace function public.create_redeem_code(p_order_id uuid)
returns public.redeem_codes
language plpgsql security definer set search_path = public as $$
declare
  v_src  record;
  v_row  public.redeem_codes;
  v_try  integer := 0;
begin
  select * into v_src from public._giftable_order(p_order_id);
  loop
    v_try := v_try + 1;
    begin
      insert into public.redeem_codes (code, order_id, product_id, option_id, created_by, expires_at)
      values (public.generate_redeem_code(), p_order_id, v_src.product_id, v_src.option_id, v_src.user_id,
              now() + public.gift_ttl())
      returning * into v_row;
      return v_row;
    exception when unique_violation then
      -- Only a code collision is retried; anything else (the order already backing one) is a real refusal.
      if sqlerrm not like '%redeem_codes_code_key%' then
        raise;
      end if;
      if v_try >= 50 then
        raise exception 'redeem_code_generation_failed' using errcode = 'P0001';
      end if;
    end;
  end loop;
end;
$$;
revoke all on function public.create_redeem_code(uuid) from public, anon, authenticated, service_role;

-- A gift of a paid order's pack to another user (resolved from an email in part 2; the id is stored, never the email).
create or replace function public.create_gift(p_order_id uuid, p_recipient uuid)
returns public.gifts
language plpgsql security definer set search_path = public as $$
declare
  v_src record;
  v_row public.gifts;
begin
  if p_recipient is null or not exists (select 1 from public.profiles where id = p_recipient) then
    raise exception 'recipient_not_found' using errcode = 'P0002';
  end if;
  select * into v_src from public._giftable_order(p_order_id);
  insert into public.gifts (order_id, product_id, option_id, sender_id, recipient_user_id, expires_at)
  values (p_order_id, v_src.product_id, v_src.option_id, v_src.user_id, p_recipient, now() + public.gift_ttl())
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.create_gift(uuid, uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------------------------------------ 8. expiry

-- Moves everything past its time to 'expired'. Redeem/claim never depend on it (they check expires_at in the same
-- statement), so it only keeps the stored status honest for lists; safe to run any time, any number of times.
create or replace function public.expire_gifts_and_codes()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_codes integer;
  v_gifts integer;
begin
  update public.redeem_codes set status = 'expired' where status = 'active' and expires_at <= now();
  get diagnostics v_codes = row_count;
  update public.gifts set status = 'expired' where status = 'pending' and expires_at <= now();
  get diagnostics v_gifts = row_count;
  return v_codes + v_gifts;
end;
$$;
revoke all on function public.expire_gifts_and_codes() from public, anon, authenticated;
grant execute on function public.expire_gifts_and_codes() to service_role;

-- ------------------------------------------------------------------------------------------------ 9. redeem

-- The caller's IP, when PostgREST passed the request headers (best effort; per-user limiting always applies).
create or replace function public._request_ip()
returns text language sql stable as $$
  select nullif(btrim(split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip',
    nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), '')
$$;
revoke all on function public._request_ip() from public, anon, authenticated;

-- Redeems a code for the signed-in user: the code becomes a pending gift in their vault. Returns (never raises, so the
-- attempt log always commits):
--   {ok: true, gift_id}                 the one winner
--   {ok: false, error: 'invalid_code'}  not found, expired, malformed, or already redeemed by SOMEONE ELSE -- one
--                                       answer for all of them, so a guess learns nothing about how close it was
--   {ok: false, error: 'already_redeemed'}  this same user already redeemed it (a double tap). Safe to tell apart:
--                                       only someone who already holds the gift can get this answer.
--   {ok: false, error: 'too_many_attempts'} too many misses recently (per user, and per IP when known)
--   {ok: false, error: 'not_authenticated'}
create or replace function public.redeem_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := auth.uid();
  v_ip     text := public._request_ip();
  v_limits record;
  v_code   text := upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  v_row    public.redeem_codes;
  v_gift   public.gifts;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select * into v_limits from public.redeem_limits();
  delete from public.redeem_code_attempts where created_at < now() - interval '1 day';
  if (select count(*) from public.redeem_code_attempts
       where user_id = v_user and not succeeded and created_at > now() - v_limits.window_length) >= v_limits.per_user
     or (v_ip is not null and (select count(*) from public.redeem_code_attempts
       where ip = v_ip and not succeeded and created_at > now() - v_limits.window_length) >= v_limits.per_ip) then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  if v_code ~ '^[A-Z0-9]{10}$' then
    -- THE single-winner step: one conditional UPDATE. Concurrent callers queue on the row lock; after the first
    -- commits, the rest re-check the WHERE against the committed row and match nothing.
    update public.redeem_codes
       set status = 'redeemed', redeemed_by = v_user, redeemed_at = now()
     where code = v_code and status = 'active' and expires_at > now()
    returning * into v_row;

    if found then
      insert into public.gifts (order_id, product_id, option_id, sender_id, recipient_user_id, redeem_code_id, expires_at)
      values (v_row.order_id, v_row.product_id, v_row.option_id, v_row.created_by, v_user, v_row.id, now() + public.gift_ttl())
      returning * into v_gift;
      insert into public.redeem_code_attempts (user_id, ip, succeeded) values (v_user, v_ip, true);
      return jsonb_build_object('ok', true, 'gift_id', v_gift.id);
    end if;

    if exists (select 1 from public.redeem_codes where code = v_code and redeemed_by = v_user) then
      return jsonb_build_object('ok', false, 'error', 'already_redeemed');
    end if;
    -- Keep the stored status honest for one that ran out.
    update public.redeem_codes set status = 'expired' where code = v_code and status = 'active' and expires_at <= now();
  end if;

  insert into public.redeem_code_attempts (user_id, ip, succeeded) values (v_user, v_ip, false);
  return jsonb_build_object('ok', false, 'error', 'invalid_code');
end;
$$;
revoke all on function public.redeem_code(text) from public, anon;
grant execute on function public.redeem_code(text) to authenticated;

-- ------------------------------------------------------------------------------------------------ 10. claim

-- Claims a pending gift for the signed-in recipient, with the player ID the pack needs (the same rules as checkout:
-- the region's buyer fields, a fresh supplier ID check where the region has one, and the region lock). Everything is
-- validated BEFORE the status moves; then one conditional UPDATE picks the single winner. Raises a distinct error per
-- case: not_authenticated, gift_not_found, gift_not_yours, gift_already_claimed, gift_expired, pack_unavailable,
-- player_id_required, id_fields_invalid, id_not_validated, id_validation_expired, region_unverifiable,
-- region_unverified, region_mismatch. Delivery (the supplier) is NOT triggered here: see the file header.
create or replace function public.claim_gift(p_gift_id uuid, p_fields jsonb default '{}'::jsonb)
returns public.gifts
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid := auth.uid();
  v_gift    public.gifts;
  v_pack    record;
  v_fields  jsonb := null;
  v_val_id  uuid;
  v_val_exp timestamptz;
  v_val_reg text;
  v_account text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' then
    p_fields := '{}'::jsonb;
  end if;

  select * into v_gift from public.gifts where id = p_gift_id;
  if not found then
    raise exception 'gift_not_found' using errcode = 'P0002';
  end if;
  if v_gift.recipient_user_id <> v_user then
    raise exception 'gift_not_yours' using errcode = '42501';
  end if;
  if v_gift.status = 'claimed' then
    raise exception 'gift_already_claimed' using errcode = 'P0001';
  end if;
  if v_gift.status = 'expired' or v_gift.expires_at <= now() then
    raise exception 'gift_expired' using errcode = 'P0001';
  end if;

  select o.is_active and p.is_active and (o.region_id is null or r.is_active) as available,
         o.region_id, o.region_locked, o.account_region_codes, p.category,
         r.buyer_fields, r.id_validation
    into v_pack
    from public.product_options o
    join public.products p on p.id = o.product_id
    left join public.product_regions r on r.id = o.region_id
   where o.id = v_gift.option_id;
  if not coalesce(v_pack.available, false) then
    raise exception 'pack_unavailable' using errcode = 'P0001';
  end if;

  -- The player ID, exactly as checkout requires it for this pack.
  if v_pack.region_id is not null then
    if jsonb_array_length(coalesce(v_pack.buyer_fields, '[]'::jsonb)) > 0 then
      if p_fields = '{}'::jsonb then
        raise exception 'player_id_required' using errcode = '22023';
      end if;
      begin
        v_fields := public.normalize_buyer_fields(v_pack.buyer_fields, p_fields);
      exception when others then
        raise exception 'id_fields_invalid' using errcode = '22023';
      end;
    end if;
    if v_pack.id_validation = 'supplier' then
      select v.id, v.expires_at, v.account_region into v_val_id, v_val_exp, v_val_reg
        from public.id_validations v
       where v.user_id = v_user and v.region_id = v_pack.region_id and v.fields = coalesce(v_fields, '{}'::jsonb)
       order by v.created_at desc limit 1;
      if v_val_id is null then
        raise exception 'id_not_validated' using errcode = 'P0001';
      elsif v_val_exp <= now() then
        raise exception 'id_validation_expired' using errcode = 'P0001';
      end if;
    end if;
    if v_pack.region_locked then
      if v_val_id is null then
        raise exception 'region_unverifiable' using errcode = 'P0001';
      elsif v_val_reg is null then
        raise exception 'region_unverified' using errcode = 'P0001';
      elsif not (v_val_reg = any (v_pack.account_region_codes)) then
        raise exception 'region_mismatch' using errcode = 'P0001';
      end if;
    end if;
  elsif v_pack.category in ('games', 'airtime', 'subscriptions') then
    -- older packs with no region: one game ID
    v_account := btrim(coalesce(p_fields ->> 'account_id', ''));
    if v_account = '' then
      raise exception 'player_id_required' using errcode = '22023';
    elsif length(v_account) > 64 then
      raise exception 'id_fields_invalid' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('account_id', v_account);
  end if;

  -- THE single-winner step (see redeem_code).
  update public.gifts
     set status = 'claimed', claimed_at = now(), player_fields = v_fields
   where id = p_gift_id and recipient_user_id = v_user and status = 'pending' and expires_at > now()
  returning * into v_gift;
  if not found then
    -- Someone (the same user's other tap) got there first, or it ran out in between.
    select * into v_gift from public.gifts where id = p_gift_id;
    if v_gift.status = 'claimed' then
      raise exception 'gift_already_claimed' using errcode = 'P0001';
    end if;
    raise exception 'gift_expired' using errcode = 'P0001';
  end if;
  return v_gift;
end;
$$;
revoke all on function public.claim_gift(uuid, jsonb) from public, anon;
grant execute on function public.claim_gift(uuid, jsonb) to authenticated;
