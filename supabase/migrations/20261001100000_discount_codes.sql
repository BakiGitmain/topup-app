-- Item 2 of the creator feature set (item 0: Vault-only post-purchase routing, item 1: content-creator flag, both
-- already live). Discount codes: an admin-assigned, content-creator-attributed code a NEW customer can type once, at
-- checkout, on their first order only. Reuses create_cart_order/checkout_cart (the same all-or-nothing re-check
-- every cart already goes through) rather than a separate checkout path, and reuses the admin-write-via-RLS pattern
-- already used for products/product_options (see 20260920120000) rather than inventing bespoke CRUD RPCs.
--
-- REDEMPTION IS LOGGED AT COMPLETION, NOT AT CHECKOUT -- flagging this, per the standing instruction, since it is a
-- judgment call and not explicitly spelled out in the brief. "First-ever COMPLETED order" is the stated rule. An
-- order that applies a code is only PENDING at checkout: it might never be paid (abandoned), or it might be paid and
-- then fail/refund before delivery (admin_set_order_status). None of those are a completed purchase, so none of
-- them should burn the customer's one-time code eligibility or create a commission/discount audit row. So: the
-- discount is validated and the ORDER'S OWN amount is reduced at checkout time (the customer sees the cut price
-- immediately, same as today), but code_redemptions -- the audit trail -- is written only where 'completed' is
-- actually reached: admin_deliver_order and system_fulfill_order, the only two places that ever set it. Both bodies
-- were already near-identical copies (one admin-gated, one service-role-gated); this migration factors the shared
-- part into public._complete_order() and has both call it, so the redemption write lives in exactly one place
-- instead of two copies that could drift.
--
-- THE FIRST-ORDER CHECK IS WIDER THAN "no completed order yet" -- also flagging this. A customer can have at most
-- one 'pending_payment' order at a time (create_cart_order already enforces that), but a PAID order can sit in the
-- admin queue for a while before it reaches 'completed'. If eligibility were checked only against 'completed'
-- orders, a customer could pay for order #1 (no code), then, before #1 is delivered, check out order #2 WITH a
-- code -- and both created_cart_order calls would see zero completed orders and both would look like "the first
-- order". So eligibility here is: no prior order in 'paid', 'processing' OR 'completed' -- i.e. this must be the
-- first order that ever got as far as being paid for. That is a strictly stronger (safer) condition than the
-- brief's wording, never a looser one: anything that would pass "first completed order" also passes this.
--
-- COMMISSION BASE: confirmed with the product owner (AskUserQuestion) -- commission_percent x the WHOLE cart's
-- pre-discount total, not just the subtotal of the lines the code actually applies to.
--
-- NOT DONE HERE (item 4, not started): crediting commission_amount anywhere. It is only recorded on the
-- code_redemptions row for now, per the product owner's explicit instruction not to invent a place to credit it
-- ahead of item 4's creator-commission ledger.
--
-- DISCOUNT CAPPED AT 90%, NOT 100 -- per the product owner, after the Br 0 order gap was flagged: discount applies
-- only to the lines a code covers, so a 100%-off code whose applicable_products covers the whole cart could zero out
-- the order total. wallet_transactions forbids a zero-amount ledger row (`check (amount <> 0)`), so a Br 0 order can
-- never be paid through the wallet path. 90 leaves every order with something left to charge.

-------------------------------------------------------------------------------
-- 1. discount_codes
-------------------------------------------------------------------------------

create table if not exists public.discount_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null,
  creator_id          uuid not null references public.profiles (id) on delete restrict,
  discount_percent    numeric(5, 2) not null check (discount_percent > 0 and discount_percent <= 90),
  commission_percent  numeric(5, 2) not null check (commission_percent >= 0 and commission_percent <= 100),
  -- null = every product. A non-null array is never empty: an admin who wants "no products" should deactivate it.
  applicable_products uuid[],
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.profiles (id) on delete set null,
  -- array_length() of an EMPTY array is null, not 0 -- a check against it would silently let '{}' through.
  -- cardinality() has no such gotcha (0 for empty, null only for a genuinely null array).
  constraint discount_codes_products_not_empty check (applicable_products is null or cardinality(applicable_products) > 0)
);

-- Redemption matches case-insensitively (see create_cart_order below), so two codes differing only by case would be
-- ambiguous; blocked here rather than left to whichever one the lookup happens to prefer.
create unique index if not exists discount_codes_code_ci_idx on public.discount_codes (upper(code));

-- A code can only ever belong to a content creator. Enforced here (not a plain CHECK: Postgres CHECKs can't query
-- another table), so it holds no matter which admin path writes the row, direct table write or otherwise.
-- SECURITY DEFINER: this must see the real profiles.is_content_creator regardless of who is inserting/updating,
-- but profiles' own RLS (id = auth.uid() or is_admin()) would otherwise hide a creator's row from the admin doing
-- the write in some setups and from anyone else entirely -- the same reason is_admin() itself is SECURITY DEFINER.
create or replace function public.guard_discount_code_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = new.creator_id and is_content_creator) then
    raise exception 'creator_not_content_creator' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists discount_codes_guard_creator on public.discount_codes;
create trigger discount_codes_guard_creator
  before insert or update of creator_id on public.discount_codes
  for each row execute function public.guard_discount_code_creator();

alter table public.discount_codes enable row level security;

drop policy if exists discount_codes_admin_write on public.discount_codes;
create policy discount_codes_admin_write on public.discount_codes
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- A creator sees their own codes (and, further down, their own redemption stats) -- never another creator's, and
-- never a customer, who has no policy here at all: entering a code string goes through the SECURITY DEFINER
-- checkout function below, which needs no table grant of its own.
drop policy if exists discount_codes_creator_read on public.discount_codes;
create policy discount_codes_creator_read on public.discount_codes
  for select to authenticated
  using (creator_id = (select auth.uid()));

revoke all on public.discount_codes from anon, authenticated;
grant select, insert, update, delete on public.discount_codes to authenticated;

-------------------------------------------------------------------------------
-- 2. code_redemptions -- the audit trail. Same principle as wallet_transactions: append-only from the app's point of
--    view (only SELECT is granted; the one INSERT happens inside _complete_order, a SECURITY DEFINER function).
-------------------------------------------------------------------------------

create table if not exists public.code_redemptions (
  id                uuid primary key default gen_random_uuid(),
  code_id           uuid not null references public.discount_codes (id) on delete restrict,
  customer_id       uuid not null references public.profiles (id) on delete cascade,
  order_id          uuid not null unique references public.orders (id) on delete cascade,
  discount_amount   numeric(14, 2) not null check (discount_amount >= 0),
  commission_amount numeric(14, 2) not null check (commission_amount >= 0),
  created_at        timestamptz not null default now()
);

create index if not exists code_redemptions_code_idx on public.code_redemptions (code_id);
create index if not exists code_redemptions_customer_idx on public.code_redemptions (customer_id);

alter table public.code_redemptions enable row level security;

drop policy if exists code_redemptions_admin_read on public.code_redemptions;
create policy code_redemptions_admin_read on public.code_redemptions
  for select to authenticated
  using ((select public.is_admin()));

-- "A creator can see their own codes' redemption stats, never another creator's": joins back to discount_codes,
-- which is itself locked to creator_id = auth.uid() by the policy above, so this can't leak another creator's rows
-- even indirectly.
drop policy if exists code_redemptions_creator_read on public.code_redemptions;
create policy code_redemptions_creator_read on public.code_redemptions
  for select to authenticated
  using (exists (
    select 1 from public.discount_codes dc where dc.id = code_redemptions.code_id and dc.creator_id = (select auth.uid())
  ));

revoke all on public.code_redemptions from anon, authenticated;
grant select on public.code_redemptions to authenticated;

-------------------------------------------------------------------------------
-- 3. orders: the snapshot taken at checkout, consumed at completion (see the header comment above).
-------------------------------------------------------------------------------

alter table public.orders add column if not exists discount_code_id uuid references public.discount_codes (id) on delete restrict;
alter table public.orders add column if not exists discount_amount numeric(14, 2) not null default 0 check (discount_amount >= 0);
alter table public.orders add column if not exists commission_amount numeric(14, 2) not null default 0 check (commission_amount >= 0);

-------------------------------------------------------------------------------
-- 4. create_cart_order: adds an optional p_code, unchanged otherwise. Reproduces the current body from
--    20260930230000_subscriptions_topup_fulfillment.sql plus the code-handling additions (marked below); this DROP
--    is needed because the old function took zero arguments -- CREATE OR REPLACE can't turn a 0-arg function into a
--    1-arg one, it would just add a second, overloaded function of the same name.
-------------------------------------------------------------------------------

drop function if exists public.create_cart_order();

create or replace function public.create_cart_order(
  p_code text default null
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
    -- See the header comment: "first order" here means no prior order ever got as far as being paid for, not
    -- merely "no completed order yet" -- closes the race where a second cart checks out before the first is
    -- delivered.
    if exists (select 1 from public.orders where user_id = v_user and status in ('paid', 'processing', 'completed')) then
      raise exception 'code_already_used' using errcode = 'P0001';
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
     discount_code_id, discount_amount, commission_amount)
  values
    (v_user, v_name, v_label, v_total - v_discount, 'pending_payment', '{}'::jsonb,
     case when v_topup then 'topup' else 'code' end, v_region,
     v_code_row.id, v_discount, v_commission)
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

revoke all on function public.create_cart_order(text) from public, anon;
grant execute on function public.create_cart_order(text) to authenticated;

-------------------------------------------------------------------------------
-- 5. checkout_cart: threads p_code through to create_cart_order. Everything else (pay from wallet if it covers the
--    now-possibly-discounted total, else leave unpaid for the bank flow) is unchanged.
-------------------------------------------------------------------------------

drop function if exists public.checkout_cart();

create or replace function public.checkout_cart(
  p_code text default null
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

  -- Every existing check (products on sale, packs active, region valid, each line's ID, and now the code) happens
  -- in here, all or nothing.
  v_order := public.create_cart_order(p_code);

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

revoke all on function public.checkout_cart(text) from public, anon;
grant execute on function public.checkout_cart(text) to authenticated;

-------------------------------------------------------------------------------
-- 6. _complete_order: the shared body admin_deliver_order and system_fulfill_order both had, byte-for-byte, plus
--    the one new step (write the redemption row, only now, see the header comment). Not callable directly by
--    anyone, same as wallet_apply -- only from within another SECURITY DEFINER function.
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
  v_order public.orders;
  v_code  text;
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
  end if;

  return v_order;
end;
$$;

revoke all on function public._complete_order(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.admin_deliver_order(
  p_order_id uuid,
  p_code     text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public._complete_order(p_order_id, p_code);
end;
$$;

create or replace function public.system_fulfill_order(
  p_order_id uuid,
  p_code     text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
begin
  return public._complete_order(p_order_id, p_code);
end;
$$;

revoke all on function public.admin_deliver_order(uuid, text) from public, anon;
grant execute on function public.admin_deliver_order(uuid, text) to authenticated;
revoke all on function public.system_fulfill_order(uuid, text) from public, anon, authenticated;
grant execute on function public.system_fulfill_order(uuid, text) to service_role;
