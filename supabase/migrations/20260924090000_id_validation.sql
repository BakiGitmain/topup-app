-- topup: server-enforced ID validation and region lock.
-- Run AFTER 20260923090000_region_matching.sql. Safe to re-run.
--
-- WHY: the region lock and the "ID was checked" rule must hold even if someone calls
-- the database directly with the app's public key. So:
--   1. The validate-id Edge Function checks a player ID with the supplier and, if it is
--      valid, writes an id_validations record (only the server can write it).
--   2. purchase_product_option refuses to sell for a region that validates IDs unless a
--      matching, unexpired record exists for THIS user, THIS region and EXACTLY these ID
--      fields. Validating one ID and buying for another fails.
--   3. A region-locked package is only sold when the record's account region is one the
--      package serves. If the region is unknown, it is not sold (never guessed).
--   4. Regions that cannot validate IDs need the customer's "I've checked my ID" tick,
--      recorded with a timestamp on the order.
--   5. Every order stores what was checked at purchase time.
--
-- WHAT THIS DOES TO EXISTING DATA: nothing is rewritten.
--   * New tables: id_validations, id_validation_attempts.
--   * orders gets four empty columns (validation_id, validated_account_region,
--     validated_player_name, id_self_declared_at). Existing orders keep NULL there.
--   * Existing packages and legacy products (no region) sell exactly as before, unless a
--     package is region-locked: those now need a validation record.
--   * Regions that have buyer fields but no supplier validation now require the tick.

------------------------------------------------------------------------------
-- 1. how long a validation stays good (one place)
------------------------------------------------------------------------------

create or replace function public.id_validation_window()
returns interval
language sql
immutable
as $$ select interval '15 minutes' $$;

------------------------------------------------------------------------------
-- 2. the records
------------------------------------------------------------------------------

create table if not exists public.id_validations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  region_id      uuid not null references public.product_regions (id) on delete cascade,
  -- The exact ID fields that were checked, as text ({"player_id": "3327205705"}).
  fields         jsonb not null,
  -- The region of the ACCOUNT as the supplier reported it ("ME"). Null = none reported.
  account_region text,
  -- The supplier's player name, kept as-is for support.
  player_name    text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  check (jsonb_typeof(fields) = 'object'),
  check (account_region is null or account_region ~ '^[A-Z0-9_-]{1,16}$'),
  check (expires_at > created_at)
);

create index if not exists id_validations_lookup_idx
  on public.id_validations (user_id, region_id, created_at desc);

-- Only the server writes these. Customers cannot read them; admins can, for support.
alter table public.id_validations enable row level security;
drop policy if exists id_validations_admin_select on public.id_validations;
create policy id_validations_admin_select on public.id_validations
  for select to authenticated
  using ((select public.is_admin()));
revoke all on public.id_validations from anon, authenticated;
grant select on public.id_validations to authenticated;
grant all on public.id_validations to service_role;

-- A simple per-customer throttle: validation calls the supplier, which is slow and shared.
create table if not exists public.id_validation_attempts (
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists id_validation_attempts_idx
  on public.id_validation_attempts (user_id, created_at);
alter table public.id_validation_attempts enable row level security;
revoke all on public.id_validation_attempts from anon, authenticated;
grant all on public.id_validation_attempts to service_role;

------------------------------------------------------------------------------
-- 3. orders remember what was checked
------------------------------------------------------------------------------

alter table public.orders
  add column if not exists validation_id           uuid references public.id_validations (id) on delete set null,
  add column if not exists validated_account_region text,
  add column if not exists validated_player_name    text,
  -- Set when the customer ticked "I've checked my ID" (a region with no validation).
  add column if not exists id_self_declared_at      timestamptz;

------------------------------------------------------------------------------
-- 4. one definition of "these ID fields are acceptable for this region"
------------------------------------------------------------------------------

-- Returns the fields as a flat object of trimmed text values. Raises the same errors the
-- purchase always has: buyer_field_unknown / _required / _invalid (detail = the key).
-- Used by BOTH the purchase and the validation record, so what was validated and what is
-- bought are compared in exactly the same form.
create or replace function public.normalize_buyer_fields(p_buyer_fields jsonb, p_delivery jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_fields jsonb := '{}'::jsonb;
  v_key    text;
  v_field  jsonb;
  v_raw    jsonb;
  v_val    text;
begin
  if jsonb_typeof(p_delivery) is distinct from 'object' then
    p_delivery := '{}'::jsonb;
  end if;

  -- No keys the region didn't declare.
  for v_key in select jsonb_object_keys(p_delivery) loop
    if not exists (
      select 1 from jsonb_array_elements(p_buyer_fields) f where f ->> 'key' = v_key
    ) then
      raise exception 'buyer_field_unknown' using errcode = '22023', detail = left(v_key, 60);
    end if;
  end loop;

  -- Every declared field, present and valid.
  for v_field in select * from jsonb_array_elements(p_buyer_fields) loop
    v_key := v_field ->> 'key';
    v_raw := p_delivery -> v_key;

    if v_raw is null or jsonb_typeof(v_raw) not in ('string', 'number') then
      raise exception 'buyer_field_required' using errcode = '22023', detail = v_key;
    end if;

    v_val := btrim(p_delivery ->> v_key);
    if v_val = '' then
      raise exception 'buyer_field_required' using errcode = '22023', detail = v_key;
    end if;
    if length(v_val) > 128 then
      raise exception 'buyer_field_invalid' using errcode = '22023', detail = v_key;
    end if;

    if coalesce(v_field ->> 'type', 'text') = 'select' and not exists (
      select 1 from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) o
       where o ->> 'value' = v_val
    ) then
      raise exception 'buyer_field_invalid' using errcode = '22023', detail = v_key;
    end if;

    v_fields := v_fields || jsonb_build_object(v_key, v_val);
  end loop;

  return v_fields;
end;
$$;

revoke all on function public.normalize_buyer_fields(jsonb, jsonb) from public, anon, authenticated;

------------------------------------------------------------------------------
-- 5. what the Edge Function needs (service role only)
------------------------------------------------------------------------------

-- Everything needed to validate for a region. No rows = not available.
create or replace function public.id_validation_target(p_region_id uuid)
returns table (
  id_validation          text,
  buyer_fields           jsonb,
  family                 text,
  validation_category_id text,
  validation_field_map   jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id_validation, r.buyer_fields, s.family, s.validation_category_id,
         coalesce(s.validation_field_map, '{}'::jsonb)
    from public.product_regions r
    join public.products p on p.id = r.product_id
    left join public.product_region_supplier s on s.region_id = r.id
   where r.id = p_region_id and r.is_active and p.is_active;
$$;

-- true = go ahead; false = this customer is asking too often.
create or replace function public.claim_id_validation_slot(p_user uuid, p_limit integer default 15)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent integer;
begin
  delete from public.id_validation_attempts where created_at < now() - interval '1 hour';

  select count(*) into v_recent
    from public.id_validation_attempts
   where user_id = p_user and created_at > now() - interval '1 minute';

  if v_recent >= p_limit then
    return false;
  end if;

  insert into public.id_validation_attempts (user_id) values (p_user);
  return true;
end;
$$;

-- Writes the record after the supplier said the ID is valid.
create or replace function public.record_id_validation(
  p_user           uuid,
  p_region_id      uuid,
  p_fields         jsonb,
  p_account_region text,
  p_player_name    text
)
returns table (validation_id uuid, valid_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_region record;
  v_fields jsonb;
  v_code   text;
  v_name   text;
  v_id     uuid;
  v_until  timestamptz := now() + public.id_validation_window();
begin
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select r.buyer_fields, r.id_validation
    into v_region
    from public.product_regions r
    join public.products p on p.id = r.product_id
   where r.id = p_region_id and r.is_active and p.is_active;

  if not found or v_region.id_validation <> 'supplier' then
    raise exception 'validation_not_available' using errcode = 'P0002';
  end if;

  v_fields := public.normalize_buyer_fields(v_region.buyer_fields, p_fields);

  -- A region code we can't recognise is stored as "none reported", never guessed.
  v_code := upper(btrim(coalesce(p_account_region, '')));
  if v_code !~ '^[A-Z0-9_-]{1,16}$' then
    v_code := null;
  end if;
  v_name := left(nullif(btrim(coalesce(p_player_name, '')), ''), 200);

  insert into public.id_validations (user_id, region_id, fields, account_region, player_name, expires_at)
  values (p_user, p_region_id, v_fields, v_code, v_name, v_until)
  returning id into v_id;

  -- Housekeeping: old records nobody's order points at.
  delete from public.id_validations v
   where v.expires_at < now() - interval '2 days'
     and not exists (select 1 from public.orders o where o.validation_id = v.id);

  return query select v_id, v_until;
end;
$$;

revoke all on function public.id_validation_target(uuid) from public, anon, authenticated;
revoke all on function public.claim_id_validation_slot(uuid, integer) from public, anon, authenticated;
revoke all on function public.record_id_validation(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.id_validation_target(uuid) to service_role;
grant execute on function public.claim_id_validation_slot(uuid, integer) to service_role;
grant execute on function public.record_id_validation(uuid, uuid, jsonb, text, text) to service_role;

------------------------------------------------------------------------------
-- 6. purchase: validation gate, region lock, and the audit trail
------------------------------------------------------------------------------

-- Errors added (all raised BEFORE any money moves):
--   id_not_validated       no validation record for these exact fields
--   id_validation_expired  the record is older than id_validation_window()
--   id_check_required      region without validation and the tick is missing
--   region_unverifiable    package is region-locked but nothing can verify the account
--   region_unverified      the supplier reported no account region
--   region_mismatch        the account's region is not one this package serves
create or replace function public.purchase_product_option(
  p_option_id  uuid,
  p_delivery   jsonb,
  p_id_checked boolean
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user         uuid := auth.uid();
  v_opt          record;
  v_region       record;
  v_region_label text;   -- plain variables: a record that was never assigned cannot be read, even inside CASE
  v_fulfillment  text;
  v_account      text;
  v_delivery     jsonb := '{}'::jsonb;
  v_fields       jsonb := '{}'::jsonb;
  v_first_key    text;
  v_first        text;
  v_val_id       uuid;
  v_val_expires  timestamptz;
  v_val_region   text;
  v_val_name     text;
  v_self_declared timestamptz;
  v_balance      numeric(14, 2);
  v_new_balance  numeric(14, 2);
  v_order        public.orders;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select o.id, o.label, o.price, o.region_id, o.region_locked, o.account_region_codes,
         p.name, p.category
    into v_opt
    from public.product_options o
    join public.products p on p.id = o.product_id
   where o.id = p_option_id and o.is_active and p.is_active;

  if not found then
    raise exception 'option_unavailable' using errcode = 'P0002';
  end if;

  v_fulfillment := case when v_opt.category in ('games', 'airtime') then 'topup' else 'code' end;

  if v_opt.region_id is not null then
    -- ---------------------------------------------------- region path
    select r.label, r.buyer_fields, r.id_validation, r.is_active
      into v_region
      from public.product_regions r
     where r.id = v_opt.region_id;

    if not found or not v_region.is_active then
      raise exception 'option_unavailable' using errcode = 'P0002';
    end if;
    v_region_label := v_region.label;

    if jsonb_typeof(p_delivery) is distinct from 'object' then
      p_delivery := '{}'::jsonb;
    end if;

    -- Legacy single-ID call onto a one-field region.
    if jsonb_array_length(v_region.buyer_fields) = 1
       and (select count(*) from jsonb_object_keys(p_delivery)) = 1
       and p_delivery ? 'account_id'
       and (v_region.buyer_fields -> 0 ->> 'key') <> 'account_id' then
      p_delivery := jsonb_build_object(v_region.buyer_fields -> 0 ->> 'key', p_delivery -> 'account_id');
    end if;

    v_fields := public.normalize_buyer_fields(v_region.buyer_fields, p_delivery);

    v_first_key := v_region.buyer_fields -> 0 ->> 'key';
    if v_first_key is not null then
      v_first := v_fields ->> v_first_key;
    end if;

    v_delivery := jsonb_build_object('fields', v_fields);
    if v_first is not null then
      v_delivery := v_delivery || jsonb_build_object('account_id', v_first);
    end if;

    -- ---- was this exact ID checked?
    if v_region.id_validation = 'supplier' then
      -- The record must be this customer's, for this region, for EXACTLY these fields.
      select v.id, v.expires_at, v.account_region, v.player_name
        into v_val_id, v_val_expires, v_val_region, v_val_name
        from public.id_validations v
       where v.user_id = v_user
         and v.region_id = v_opt.region_id
         and v.fields = v_fields
       order by v.created_at desc
       limit 1;

      if not found then
        raise exception 'id_not_validated' using errcode = 'P0001';
      end if;
      if v_val_expires <= now() then
        raise exception 'id_validation_expired' using errcode = 'P0001';
      end if;
    elsif jsonb_array_length(v_region.buyer_fields) > 0 then
      -- The supplier can't check this game's IDs: the customer vouches for it, on the record.
      if not coalesce(p_id_checked, false) then
        raise exception 'id_check_required' using errcode = 'P0001';
      end if;
      v_self_declared := now();
    end if;
  elsif v_fulfillment = 'topup' then
    -- ---------------------------------------------------- legacy path (no region)
    v_account := btrim(coalesce(p_delivery ->> 'account_id', ''));
    if v_account = '' then
      raise exception 'account_id_required' using errcode = '22023';
    end if;
    if length(v_account) > 64 then
      raise exception 'account_id_invalid' using errcode = '22023';
    end if;
    -- Only the fields we know about are stored, whatever the client sent.
    v_delivery := jsonb_build_object('account_id', v_account);
  end if;

  -- ---- the region lock: real, and checked here, not just in the app
  if v_opt.region_locked then
    if v_val_id is null then
      raise exception 'region_unverifiable' using errcode = 'P0001';
    end if;
    if v_val_region is null then
      raise exception 'region_unverified' using errcode = 'P0001';
    end if;
    if not (v_val_region = any (v_opt.account_region_codes)) then
      raise exception 'region_mismatch' using errcode = 'P0001', detail = v_val_region;
    end if;
  end if;

  -- Row lock: two purchases at once can't both spend the same money.
  select balance into v_balance
    from public.wallets
   where user_id = v_user
     for update;

  if not found then
    raise exception 'wallet_missing' using errcode = 'P0002';
  end if;

  if v_balance < v_opt.price then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  v_new_balance := v_balance - v_opt.price;
  update public.wallets set balance = v_new_balance where user_id = v_user;

  insert into public.orders (
    user_id, option_id, product_name, option_label, amount, delivery, fulfillment, region_label,
    validation_id, validated_account_region, validated_player_name, id_self_declared_at
  )
  values (
    v_user, v_opt.id, v_opt.name, v_opt.label, v_opt.price, v_delivery, v_fulfillment, v_region_label,
    v_val_id, v_val_region, v_val_name, v_self_declared
  )
  returning * into v_order;

  insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note)
  values (v_user, 'purchase', -v_opt.price, v_new_balance, v_order.id, v_opt.name || ' - ' || v_opt.label);

  return v_order;
end;
$$;

-- The old two-argument call keeps working. It can never claim the tick, so a region that
-- needs one refuses it: there is no way around the gate through this door.
create or replace function public.purchase_product_option(
  p_option_id uuid,
  p_delivery  jsonb default '{}'::jsonb
)
returns public.orders
language sql
security invoker
set search_path = public
as $$
  select * from public.purchase_product_option(p_option_id, p_delivery, false);
$$;

revoke all on function public.purchase_product_option(uuid, jsonb, boolean) from public, anon;
revoke all on function public.purchase_product_option(uuid, jsonb) from public, anon;
grant execute on function public.purchase_product_option(uuid, jsonb, boolean) to authenticated;
grant execute on function public.purchase_product_option(uuid, jsonb) to authenticated;
