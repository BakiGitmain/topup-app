-- New subsystem: a prize wheel. Customers buy spins with Portal Coins (admin-configurable packages), spin to win a
-- birr-off discount (admin-configurable prizes and relative weights), and apply a won discount at checkout, same as
-- a discount code but never stacked with one.
--
-- FAIRNESS, the one non-negotiable part: the prize is chosen HERE, server-side, inside spin_wheel(), before any
-- animation exists. The client only ever receives the ALREADY-DECIDED prize (id, label, discount, and its 0-based
-- index among the active prizes in the same order the client rendered them) and animates to match -- it never
-- influences or re-derives the outcome. See the client's PrizeWheel component (custom Reanimated, not a library --
-- confirmed with the owner) for the animation half of this contract.
--
-- FLAGGED DECISIONS, not guessed past:
--   1. wheel_prizes.weight IS customer-readable (not admin-only). Unlike a discount code's discount/commission
--      percent (an explicit existing rule: customers never see those), nothing here asked for the wheel's odds to
--      be hidden, and a real prize wheel showing plausible-looking slices without hidden odds is normal in this
--      genre. Column-level hiding would need a public view on top of the table for one integer; not worth it
--      without being asked. Admin CRUD is still the only way to WRITE it.
--   2. A wheel credit and a discount code do NOT stack (the given default): create_cart_order rejects a call that
--      somehow carries both (a client bug, since the app itself only ever applies one) with
--      'multiple_discounts_not_allowed' rather than silently picking one.
--   3. The cart's "unredeemed prize" pill shows the OLDEST unredeemed prize first (won_at ascending), not the
--      smallest. Reasoning: "smallest first" would let a customer accumulate large prizes indefinitely without ever
--      being offered them, since a small one would always be offered ahead of it; oldest-first guarantees every
--      prize eventually surfaces. Only the app's own UI limits this to one prize at a time -- nothing in the schema
--      stops a customer holding several; a "my prizes" list is not built this round.
--   4. A flat birr discount is capped so the order total can never hit exactly Br 0 (min(discount_birr, total - 1),
--      never less than 0): the same reasoning already applied to discount codes (a Br 0 order can't be paid through
--      the wallet -- wallet_transactions forbids a zero-amount ledger row).
--   5. Portal Coin earning is UNCHANGED for a wheel-discounted order: _complete_order's existing branch
--      (discount_code_id is not null => the code's bonus, else the flat +1) is not touched -- a wheel prize was not
--      asked to carry its own coin bonus, so a wheel-discounted order earns the same flat +1 as any code-less order.
--   6. A KNOWN, low-priority race, not closed: if an admin adds/removes/reorders active prizes between the moment a
--      customer's client fetched the prize list (to draw the wheel) and the moment they tap Spin, the index
--      spin_wheel() returns could point at a different slice than what is on screen. This cannot affect the
--      OUTCOME (the prize itself is still chosen fairly, server-side, from whatever is active at spin time) --
--      only, in the rare case an admin edits the wheel at that exact moment, which slice the animation lands on
--      visually. Not closed: it would need the client to hold a version/snapshot of the prize list and the server
--      to validate against it, real complexity for an edit-during-a-spin coincidence.

-------------------------------------------------------------------------------
-- 1. wheel_prizes: the slices. Admin-only write; every signed-in customer reads active ones (see flag 1 above).
-------------------------------------------------------------------------------

create table if not exists public.wheel_prizes (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  discount_birr  numeric(14, 2) not null check (discount_birr > 0),
  weight         integer not null check (weight > 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.profiles (id) on delete set null
);

create index if not exists wheel_prizes_active_idx on public.wheel_prizes (created_at, id) where active;

alter table public.wheel_prizes enable row level security;

drop policy if exists wheel_prizes_select on public.wheel_prizes;
create policy wheel_prizes_select on public.wheel_prizes
  for select to authenticated
  using (active or (select public.is_admin()));

drop policy if exists wheel_prizes_admin_write on public.wheel_prizes;
create policy wheel_prizes_admin_write on public.wheel_prizes
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.wheel_prizes from anon, authenticated;
grant select, insert, update, delete on public.wheel_prizes to authenticated;

-------------------------------------------------------------------------------
-- 2. wheel_spin_packages: what a customer can buy with Portal Coins. Same admin-write / customer-read-active shape.
-------------------------------------------------------------------------------

create table if not exists public.wheel_spin_packages (
  id                uuid primary key default gen_random_uuid(),
  spins_count       integer not null check (spins_count > 0),
  portal_coin_cost  integer not null check (portal_coin_cost > 0),
  active            boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now()
);

alter table public.wheel_spin_packages enable row level security;

drop policy if exists wheel_spin_packages_select on public.wheel_spin_packages;
create policy wheel_spin_packages_select on public.wheel_spin_packages
  for select to authenticated
  using (active or (select public.is_admin()));

drop policy if exists wheel_spin_packages_admin_write on public.wheel_spin_packages;
create policy wheel_spin_packages_admin_write on public.wheel_spin_packages
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.wheel_spin_packages from anon, authenticated;
grant select, insert, update, delete on public.wheel_spin_packages to authenticated;

-------------------------------------------------------------------------------
-- 3. wheel_spin_credits: "spins bought but not yet used." A plain atomic counter, not a full guarded ledger like
--    the wallet/Portal Coin -- there is no audit requirement here beyond what buy_spin_package/spin_wheel's own
--    callers (portal_coin_transactions, wheel_prizes_won) already record; the counter itself only needs to never
--    go negative and never race, which one atomic UPDATE (below) already guarantees.
-------------------------------------------------------------------------------

create table if not exists public.wheel_spin_credits (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  credits     integer not null default 0 check (credits >= 0),
  updated_at  timestamptz not null default now()
);

drop trigger if exists wheel_spin_credits_set_updated_at on public.wheel_spin_credits;
create trigger wheel_spin_credits_set_updated_at
  before update on public.wheel_spin_credits
  for each row execute function public.set_updated_at();

create or replace function public.create_wheel_spin_credits_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wheel_spin_credits (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created_wheel_credits on public.profiles;
create trigger on_profile_created_wheel_credits
  after insert on public.profiles
  for each row execute function public.create_wheel_spin_credits_for_profile();

insert into public.wheel_spin_credits (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

alter table public.wheel_spin_credits enable row level security;

drop policy if exists wheel_spin_credits_select on public.wheel_spin_credits;
create policy wheel_spin_credits_select on public.wheel_spin_credits
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.wheel_spin_credits from anon, authenticated;
grant select on public.wheel_spin_credits to authenticated;

-- The atomic check+change, same one-statement idiom as wallet_apply/portal_coin_apply. Internal only.
create or replace function public.wheel_spin_credits_apply(
  p_user  uuid,
  p_delta integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new integer;
begin
  if coalesce(p_delta, 0) = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  update public.wheel_spin_credits
     set credits = credits + p_delta
   where user_id = p_user and credits + p_delta >= 0
  returning credits into v_new;

  if v_new is null then
    if not exists (select 1 from public.wheel_spin_credits where user_id = p_user) then
      raise exception 'wheel_spin_credits_missing' using errcode = 'P0002';
    end if;
    raise exception 'insufficient_spin_credits' using errcode = 'P0001';
  end if;

  return v_new;
end;
$$;

revoke all on function public.wheel_spin_credits_apply(uuid, integer)
  from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 4. wheel_prizes_won: what a customer actually won, and whether they have spent it. Customer reads their own rows;
--    the only writer is spin_wheel() (insert) and _complete_order() (marking it redeemed) -- no direct grant.
-------------------------------------------------------------------------------

create table if not exists public.wheel_prizes_won (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.profiles (id) on delete cascade,
  prize_id          uuid not null references public.wheel_prizes (id) on delete restrict,
  -- Snapshotted at win time, like code_redemptions snapshots a code's amounts: if the prize is later relabelled or
  -- repriced by an admin, what the customer actually won and can still redeem does not silently change underneath them.
  label             text not null,
  discount_birr     numeric(14, 2) not null check (discount_birr > 0),
  won_at            timestamptz not null default now(),
  redeemed_at       timestamptz,
  applied_order_id  uuid references public.orders (id) on delete set null
);

create index if not exists wheel_prizes_won_customer_idx on public.wheel_prizes_won (customer_id, won_at);

alter table public.wheel_prizes_won enable row level security;

drop policy if exists wheel_prizes_won_select on public.wheel_prizes_won;
create policy wheel_prizes_won_select on public.wheel_prizes_won
  for select to authenticated
  using (customer_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.wheel_prizes_won from anon, authenticated;
grant select on public.wheel_prizes_won to authenticated;

-------------------------------------------------------------------------------
-- 5. Portal Coin gains one more spend kind (buying spins), same pattern as 'redeem' (which stayed reserved for the
--    paused wallet-redemption path -- this is a new, separate way to spend, not a reuse of that one).
-------------------------------------------------------------------------------

alter table public.portal_coin_transactions drop constraint if exists portal_coin_transactions_kind_check;
alter table public.portal_coin_transactions
  add constraint portal_coin_transactions_kind_check
  check (kind in ('earn_purchase', 'earn_purchase_discount', 'redeem', 'spend_wheel_spins'));

alter table public.portal_coin_transactions drop constraint if exists portal_coin_transactions_shape_check;
alter table public.portal_coin_transactions add constraint portal_coin_transactions_shape_check check (
  (kind in ('earn_purchase', 'earn_purchase_discount') and amount > 0)
  or (kind in ('redeem', 'spend_wheel_spins') and amount < 0)
);

-------------------------------------------------------------------------------
-- 6. buy_spin_package: burns coins (portal_coin_apply), credits spin_credits. Both in one function/transaction, so
--    either both happen or (on insufficient coins) neither does -- ordinary Postgres atomicity, the same reasoning
--    redeem_portal_coins already relies on for its own two-ledger move.
-------------------------------------------------------------------------------

create or replace function public.buy_spin_package(
  p_package_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user         uuid := auth.uid();
  v_pkg          public.wheel_spin_packages;
  v_coin_balance numeric;
  v_credits      integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_pkg from public.wheel_spin_packages where id = p_package_id and active;
  if not found then
    raise exception 'package_not_found' using errcode = 'P0002';
  end if;

  -- Raises insufficient_portal_coins if the balance doesn't cover it; nothing below runs if it does.
  v_coin_balance := public.portal_coin_apply(
    v_user, -v_pkg.portal_coin_cost, 'spend_wheel_spins',
    'Bought ' || v_pkg.spins_count || ' spin' || case when v_pkg.spins_count = 1 then '' else 's' end
  );
  v_credits := public.wheel_spin_credits_apply(v_user, v_pkg.spins_count);

  return jsonb_build_object('spins_bought', v_pkg.spins_count, 'spin_credits', v_credits, 'coin_balance', v_coin_balance);
end;
$$;

revoke all on function public.buy_spin_package(uuid) from public, anon;
grant execute on function public.buy_spin_package(uuid) to authenticated;

-------------------------------------------------------------------------------
-- 7. spin_wheel: the fairness-critical function. Reads every ACTIVE prize ONCE into a local array (so the count,
--    the total weight, and the pick itself can never disagree with each other even if an admin edits the wheel
--    mid-call), then a classic cumulative-weight walk decides the winner before anything is returned to the client.
-------------------------------------------------------------------------------

create or replace function public.spin_wheel()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user         uuid := auth.uid();
  v_credits      integer;
  v_prizes       public.wheel_prizes[];
  v_total_prizes integer;
  v_total_weight numeric := 0;
  v_r            numeric;
  v_running      numeric := 0;
  v_index        integer := 0;
  v_won          public.wheel_prizes;
  v_won_id       uuid;
  i              integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Atomic check+decrement: raises insufficient_spin_credits if none are left. Nothing else runs if it does.
  v_credits := public.wheel_spin_credits_apply(v_user, -1);

  v_prizes := array(select p from public.wheel_prizes p where p.active order by p.created_at, p.id);
  v_total_prizes := coalesce(array_length(v_prizes, 1), 0);
  if v_total_prizes = 0 then
    raise exception 'no_active_prizes' using errcode = 'P0001';
  end if;

  for i in 1..v_total_prizes loop
    v_total_weight := v_total_weight + v_prizes[i].weight;
  end loop;

  v_r := random() * v_total_weight;
  for i in 1..v_total_prizes loop
    v_running := v_running + v_prizes[i].weight;
    if v_running >= v_r then
      v_won := v_prizes[i];
      v_index := i - 1; -- 0-based, matching the client's own render order (same "created_at, id" ordering)
      exit;
    end if;
  end loop;

  insert into public.wheel_prizes_won (customer_id, prize_id, label, discount_birr)
  values (v_user, v_won.id, v_won.label, v_won.discount_birr)
  returning id into v_won_id;

  return jsonb_build_object(
    'won_id', v_won_id, 'prize_id', v_won.id, 'label', v_won.label, 'discount_birr', v_won.discount_birr,
    'index', v_index, 'total_prizes', v_total_prizes, 'spin_credits', v_credits
  );
end;
$$;

revoke all on function public.spin_wheel() from public, anon;
grant execute on function public.spin_wheel() to authenticated;

-------------------------------------------------------------------------------
-- 8. orders gains a link to a spent wheel prize, parallel to discount_code_id. A code and a wheel prize never
--    coexist on the same order (enforced in create_cart_order below), so they safely share the one existing
--    discount_amount column for whichever mechanism was actually used.
-------------------------------------------------------------------------------

alter table public.orders add column if not exists wheel_prize_won_id uuid references public.wheel_prizes_won (id) on delete restrict;

-------------------------------------------------------------------------------
-- 9. create_cart_order: the SAME signature plus one new optional parameter. Copied verbatim from the last
--    definition (20261004090000) except: the new parameter, the mutual-exclusivity guard, the wheel-prize
--    eligibility block (mirrors the discount-code one), the wheel discount computation, and the order insert
--    carrying wheel_prize_won_id. Old signature dropped first -- CREATE OR REPLACE cannot change a parameter list.
-------------------------------------------------------------------------------

drop function if exists public.create_cart_order(text);

create or replace function public.create_cart_order(
  p_code text default null,
  p_wheel_prize_won_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user           uuid := auth.uid();
  v_pending        uuid;
  v_line           record;
  v_plan           jsonb := '[]'::jsonb;
  v_failures       jsonb := '[]'::jsonb;
  v_problem        text;
  v_fields         jsonb;
  v_delivery       jsonb;
  v_first_key      text;
  v_account        text;
  v_val_id         uuid;
  v_val_exp        timestamptz;
  v_val_region     text;
  v_val_name       text;
  v_tick_at        timestamptz;
  v_lines          integer := 0;
  v_qty            integer := 0;
  v_total          numeric(14, 2) := 0;
  v_topup          boolean := false;
  v_name           text;
  v_label          text;
  v_region         text;
  v_order          uuid;
  v_item           jsonb;
  -- ---- discount code additions
  v_code_norm      text;
  v_code_row       public.discount_codes;
  v_applicable     numeric(14, 2) := 0;
  v_discount       numeric(14, 2) := 0;
  v_commission     numeric(14, 2) := 0;
  -- ---- wheel prize addition
  v_wheel_prize    public.wheel_prizes_won;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- A double-tap on "Checkout" waits here instead of racing.
  perform pg_advisory_xact_lock(hashtextextended('create_cart_order:' || v_user::text, 0));

  select id into v_pending from public.orders where user_id = v_user and status = 'pending_payment';
  if found then
    raise exception 'pending_order_exists' using errcode = 'P0001', detail = v_pending::text;
  end if;

  if btrim(coalesce(p_code, '')) <> '' and p_wheel_prize_won_id is not null then
    raise exception 'multiple_discounts_not_allowed' using errcode = 'P0001';
  end if;

  -- ---- discount code: look up and gate on eligibility BEFORE touching the cart, so a bad code fails fast.
  v_code_norm := btrim(coalesce(p_code, ''));
  if v_code_norm <> '' then
    select * into v_code_row from public.discount_codes where upper(code) = upper(v_code_norm);
    if not found then
      raise exception 'code_not_found' using errcode = 'P0001';
    end if;
    if not v_code_row.active then
      raise exception 'code_inactive' using errcode = 'P0001';
    end if;
    if v_code_row.expires_at is not null and v_code_row.expires_at <= now() then
      raise exception 'code_expired' using errcode = 'P0001';
    end if;
    -- Per-code-per-customer: if THIS customer has already redeemed THIS code, or already has an order that charged
    -- them with it and got at least as far as being paid for, that is NOT an error -- the code just stops
    -- discounting. Nulling the whole row makes every check below it behave exactly as if no code had been typed.
    if exists (select 1 from public.code_redemptions where customer_id = v_user and code_id = v_code_row.id)
       or exists (select 1 from public.orders where user_id = v_user and discount_code_id = v_code_row.id and status in ('paid', 'processing', 'completed'))
    then
      v_code_row := null;
    end if;
  end if;

  -- ---- wheel prize: look up and gate on eligibility, same fail-fast spirit as the code above.
  if p_wheel_prize_won_id is not null then
    select * into v_wheel_prize from public.wheel_prizes_won where id = p_wheel_prize_won_id and customer_id = v_user;
    if not found then
      raise exception 'wheel_prize_not_found' using errcode = 'P0001';
    end if;
    if v_wheel_prize.redeemed_at is not null then
      raise exception 'wheel_prize_unavailable' using errcode = 'P0001';
    end if;
    -- A won prize is a one-time item, unlike a reusable code: a prior order that already claimed it and got at
    -- least as far as being paid for makes it unavailable outright, not "silently no discount".
    if exists (select 1 from public.orders where user_id = v_user and wheel_prize_won_id = p_wheel_prize_won_id and status in ('paid', 'processing', 'completed')) then
      raise exception 'wheel_prize_unavailable' using errcode = 'P0001';
    end if;
  end if;

  for v_line in
    select c.id as cart_id, c.option_id, c.quantity, c.fields, c.id_checked,
           o.label, o.price, o.is_active as option_active, o.region_id, o.region_locked, o.account_region_codes,
           p.id as product_id, p.name as product_name, p.category, p.is_active as product_active,
           r.label as region_label, r.buyer_fields, r.id_validation, r.is_active as region_active
      from public.cart_items c
      join public.product_options o on o.id = c.option_id
      join public.products p on p.id = o.product_id
      left join public.product_regions r on r.id = o.region_id
     where c.user_id = v_user
     order by c.created_at, c.id
       for update of c
  loop
    v_lines := v_lines + 1;
    v_problem := null;
    v_val_id := null; v_val_exp := null; v_val_region := null; v_val_name := null; v_tick_at := null;
    v_delivery := '{}'::jsonb;

    -- ---- still on sale?
    if not v_line.product_active then
      v_problem := 'product_off';
    elsif not v_line.option_active then
      v_problem := 'pack_off';
    elsif v_line.region_id is not null and not coalesce(v_line.region_active, false) then
      v_problem := 'region_off';
    end if;

    -- ---- this line's own player ID (the same gate purchase_product_option applies)
    if v_problem is null and v_line.region_id is not null then
      begin
        v_fields := public.normalize_buyer_fields(v_line.buyer_fields, v_line.fields);
      exception when others then
        v_problem := 'id_fields_invalid';
      end;

      if v_problem is null then
        if v_line.id_validation = 'supplier' then
          select v.id, v.expires_at, v.account_region, v.player_name
            into v_val_id, v_val_exp, v_val_region, v_val_name
            from public.id_validations v
           where v.user_id = v_user and v.region_id = v_line.region_id and v.fields = v_fields
           order by v.created_at desc
           limit 1;
          if v_val_id is null then
            v_problem := 'id_not_validated';
          elsif v_val_exp <= now() then
            v_problem := 'id_validation_expired';
          end if;
        elsif jsonb_array_length(v_line.buyer_fields) > 0 then
          if not v_line.id_checked then
            v_problem := 'id_check_required';
          else
            v_tick_at := now();
          end if;
        end if;
      end if;

      -- the region lock is real, and checked here, not just in the app
      if v_problem is null and v_line.region_locked then
        if v_val_id is null then
          v_problem := 'region_unverifiable';
        elsif v_val_region is null then
          v_problem := 'region_unverified';
        elsif not (v_val_region = any (v_line.account_region_codes)) then
          v_problem := 'region_mismatch';
        end if;
      end if;

      if v_problem is null then
        v_delivery := jsonb_build_object('fields', v_fields);
        v_first_key := v_line.buyer_fields -> 0 ->> 'key';
        if v_first_key is not null then
          v_delivery := v_delivery || jsonb_build_object('account_id', v_fields ->> v_first_key);
        end if;
      end if;

    elsif v_problem is null and v_line.category in ('games', 'airtime', 'subscriptions') then
      -- older packs with no region: one game ID
      v_account := btrim(coalesce(v_line.fields ->> 'account_id', ''));
      if v_account = '' or length(v_account) > 64 then
        v_problem := 'id_fields_invalid';
      else
        v_delivery := jsonb_build_object('account_id', v_account);
      end if;
    end if;

    if v_problem is not null then
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'item_id', v_line.cart_id, 'option_id', v_line.option_id,
        'product_name', v_line.product_name, 'label', v_line.label, 'problem', v_problem));
    else
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'option_id', v_line.option_id, 'product_id', v_line.product_id, 'product_name', v_line.product_name, 'label', v_line.label,
        'region_label', v_line.region_label, 'unit_price', v_line.price, 'quantity', v_line.quantity,
        'delivery', v_delivery, 'validation_id', v_val_id, 'account_region', v_val_region,
        'player_name', v_val_name, 'tick_at', v_tick_at));
      v_total := v_total + v_line.price * v_line.quantity;
      v_qty := v_qty + v_line.quantity;
      v_topup := v_topup or v_line.category in ('games', 'airtime', 'subscriptions');
      if v_lines = 1 then
        v_name := v_line.product_name; v_label := v_line.label; v_region := v_line.region_label;
      end if;
    end if;
  end loop;

  if v_lines = 0 then
    raise exception 'cart_empty' using errcode = 'P0001';
  end if;

  -- ALL OR NOTHING: one bad line and no order exists; the error names every bad line.
  if jsonb_array_length(v_failures) > 0 then
    raise exception 'cart_unavailable' using errcode = 'P0001', detail = v_failures::text;
  end if;

  -- ---- discount code: applicable to at least one line? Checked only now, once the plan (with each line's real
  -- product_id) exists. A null applicable_products means every product; otherwise it must match at least one line.
  if v_code_row.id is not null then
    select coalesce(sum((item ->> 'unit_price')::numeric * (item ->> 'quantity')::integer), 0)
      into v_applicable
      from jsonb_array_elements(v_plan) item
     where v_code_row.applicable_products is null
        or (item ->> 'product_id')::uuid = any (v_code_row.applicable_products);

    if v_applicable <= 0 then
      raise exception 'code_not_applicable' using errcode = 'P0001';
    end if;

    v_discount := round(v_applicable * v_code_row.discount_percent / 100, 2);
    -- Confirmed with the product owner: commission is against the WHOLE cart's pre-discount total, not just the
    -- applicable subtotal.
    v_commission := round(v_total * v_code_row.commission_percent / 100, 2);
  elsif v_wheel_prize.id is not null then
    -- A flat birr-off, not tied to any product -- but never enough to bring the order to exactly Br 0 (see the
    -- migration header: a zero-amount order can't be paid through the wallet).
    v_discount := least(v_wheel_prize.discount_birr, greatest(v_total - 1, 0));
  end if;

  if v_lines > 1 then
    v_name := 'Cart order';
    v_label := v_qty || ' items';
    v_region := null;
  elsif (v_plan -> 0 ->> 'quantity')::integer > 1 then
    v_label := v_label || ' x ' || (v_plan -> 0 ->> 'quantity');
  end if;

  insert into public.orders
    (user_id, product_name, option_label, amount, status, delivery, fulfillment, region_label,
     discount_code_id, discount_amount, commission_amount, wheel_prize_won_id)
  values
    (v_user, v_name, v_label, v_total - v_discount, 'pending_payment', '{}'::jsonb,
     case when v_topup then 'topup' else 'code' end, v_region,
     v_code_row.id, v_discount, v_commission, v_wheel_prize.id)
  returning id into v_order;

  for v_item in select value from jsonb_array_elements(v_plan) loop
    insert into public.order_items
      (order_id, user_id, option_id, product_name, option_label, region_label, unit_price, quantity, line_total,
       delivery, validation_id, validated_account_region, validated_player_name, id_self_declared_at)
    values
      (v_order, v_user, (v_item ->> 'option_id')::uuid, v_item ->> 'product_name', v_item ->> 'label',
       v_item ->> 'region_label', (v_item ->> 'unit_price')::numeric, (v_item ->> 'quantity')::integer,
       (v_item ->> 'unit_price')::numeric * (v_item ->> 'quantity')::integer,
       v_item -> 'delivery', (v_item ->> 'validation_id')::uuid, v_item ->> 'account_region',
       v_item ->> 'player_name', (v_item ->> 'tick_at')::timestamptz);
  end loop;

  delete from public.cart_items where user_id = v_user;

  return jsonb_build_object('order_id', v_order, 'amount', v_total - v_discount, 'items', v_lines, 'discount', v_discount);
end;
$$;

revoke all on function public.create_cart_order(text, uuid) from public, anon;
grant execute on function public.create_cart_order(text, uuid) to authenticated;

-------------------------------------------------------------------------------
-- 10. checkout_cart: threads the new parameter through. Old signature dropped first, same reason as above.
-------------------------------------------------------------------------------

drop function if exists public.checkout_cart(text);

create or replace function public.checkout_cart(
  p_code text default null,
  p_wheel_prize_won_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_order   jsonb;
  v_balance numeric(14, 2);
  v_paid    jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Every existing check (products on sale, packs active, region valid, each line's ID, the code, the wheel
  -- prize) happens in here, all or nothing.
  v_order := public.create_cart_order(p_code, p_wheel_prize_won_id);

  select balance into v_balance from public.wallets where user_id = v_user;
  if coalesce(v_balance, 0) >= (v_order ->> 'amount')::numeric then
    begin
      v_paid := public.pay_order_with_wallet((v_order ->> 'order_id')::uuid);
      return v_order || jsonb_build_object('paid', true, 'balance', v_paid -> 'balance');
    exception when raise_exception then
      -- The funds were taken between the read and the deduction: keep the unpaid order for the bank-transfer flow.
      if sqlerrm <> 'insufficient_balance' then
        raise;
      end if;
      select balance into v_balance from public.wallets where user_id = v_user;
    end;
  end if;

  return v_order || jsonb_build_object('paid', false, 'balance', coalesce(v_balance, 0));
end;
$$;

revoke all on function public.checkout_cart(text, uuid) from public, anon;
grant execute on function public.checkout_cart(text, uuid) to authenticated;

-------------------------------------------------------------------------------
-- 11. _complete_order: same signature, same body, plus one new branch (parallel to the code_redemptions insert)
--     that marks a spent wheel prize redeemed at completion -- the same "logged only once genuinely delivered,
--     never at checkout" discipline code_redemptions already uses.
-------------------------------------------------------------------------------

create or replace function public._complete_order(
  p_order_id      uuid,
  p_delivery_code text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order       public.orders;
  v_code        text;
  v_coin_amount integer;
  v_coin_kind   text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status not in ('paid', 'pending', 'processing') then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if v_order.fulfillment = 'code' then
    v_code := btrim(coalesce(p_delivery_code, ''));
    if v_code = '' then
      raise exception 'code_required' using errcode = '22023';
    end if;
    insert into public.vault_codes (order_id, user_id, code)
    values (v_order.id, v_order.user_id, v_code);
  end if;

  update public.orders
     set status = 'completed', completed_at = now()
   where id = p_order_id
  returning * into v_order;

  if v_order.discount_code_id is not null then
    insert into public.code_redemptions (code_id, customer_id, order_id, discount_amount, commission_amount)
    values (v_order.discount_code_id, v_order.user_id, v_order.id, v_order.discount_amount, v_order.commission_amount);
  elsif v_order.wheel_prize_won_id is not null then
    update public.wheel_prizes_won
       set redeemed_at = now(), applied_order_id = v_order.id
     where id = v_order.wheel_prize_won_id;
  end if;

  -- +1 Portal Coin for any completed order; a code-using order earns that code's OWN portal_coin_bonus instead
  -- (never additive on top of the +1 -- the whole amount, same as the old flat +2 was). A wheel-discounted order is
  -- NOT special-cased (see the migration header, flag 5): it falls into the same flat +1 as any code-less order.
  if v_order.discount_code_id is not null then
    select portal_coin_bonus into v_coin_amount from public.discount_codes where id = v_order.discount_code_id;
    v_coin_kind := 'earn_purchase_discount';
  else
    v_coin_amount := 1;
    v_coin_kind := 'earn_purchase';
  end if;

  perform public.portal_coin_apply(
    v_order.user_id, v_coin_amount, v_coin_kind, 'Order ' || left(v_order.id::text, 8), v_order.id
  );

  return v_order;
end;
$$;

revoke all on function public._complete_order(uuid, text) from public, anon, authenticated, service_role;
