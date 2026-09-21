-- topup: real payment. Part 3 of 3: checkout and payment verification functions.
-- Run AFTER 20260927100000_cart.sql. Safe to re-run (it replaces the functions). No table or row changes.
--
-- create_cart_order()          customer. Re-checks the WHOLE cart against the live catalog and, only if every line
--                              is fine, creates the pending_payment order (its UUID is the primary key) with every
--                              line snapshotted, and empties the cart. ALL OR NOTHING: if any line is unavailable or
--                              its ID check is missing/expired, NOTHING is created and the error names each line.
-- cancel_pending_order(id)     customer. Closes their own unpaid order and puts its lines back in the cart.
-- begin_payment_verification   service role only (called by the verify-payment Edge Function). Locks the order,
--                              answers idempotently if it is already closed or being checked, and CLAIMS the
--                              (provider, reference) for this order.
-- finish_payment_verification  service role only. Records the raw response, then marks the order paid /
--                              payment_mismatch, or releases the reference if the payment wasn't confirmed.
--
-- Money rule, enforced here AND in the function: an order becomes 'paid' only if the verified amount equals the
-- order total exactly. Anything else is 'payment_mismatch' for a human; it is never accepted silently.
--
-- TODO (Vault work, deliberately NOT done here): nothing happens after 'paid'. There is no delivery step. When it is
-- built it must (1) act only on status = 'paid', (2) treat payment_mode = 'test' as NOT paid for real, and (3) be
-- idempotent per order so a paid order can never be delivered twice.

------------------------------------------------------------------------------
-- 1. checkout: re-check everything, then create the order
------------------------------------------------------------------------------

create or replace function public.create_cart_order()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_pending    uuid;
  v_line       record;
  v_plan       jsonb := '[]'::jsonb;
  v_failures   jsonb := '[]'::jsonb;
  v_problem    text;
  v_fields     jsonb;
  v_delivery   jsonb;
  v_first_key  text;
  v_account    text;
  v_val_id     uuid;
  v_val_exp    timestamptz;
  v_val_region text;
  v_val_name   text;
  v_tick_at    timestamptz;
  v_lines      integer := 0;
  v_qty        integer := 0;
  v_total      numeric(14, 2) := 0;
  v_topup      boolean := false;
  v_name       text;
  v_label      text;
  v_region     text;
  v_order      uuid;
  v_item       jsonb;
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

  for v_line in
    select c.id as cart_id, c.option_id, c.quantity, c.fields, c.id_checked,
           o.label, o.price, o.is_active as option_active, o.region_id, o.region_locked, o.account_region_codes,
           p.name as product_name, p.category, p.is_active as product_active,
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

    elsif v_problem is null and v_line.category in ('games', 'airtime') then
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
        'option_id', v_line.option_id, 'product_name', v_line.product_name, 'label', v_line.label,
        'region_label', v_line.region_label, 'unit_price', v_line.price, 'quantity', v_line.quantity,
        'delivery', v_delivery, 'validation_id', v_val_id, 'account_region', v_val_region,
        'player_name', v_val_name, 'tick_at', v_tick_at));
      v_total := v_total + v_line.price * v_line.quantity;
      v_qty := v_qty + v_line.quantity;
      v_topup := v_topup or v_line.category in ('games', 'airtime');
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

  if v_lines > 1 then
    v_name := 'Cart order';
    v_label := v_qty || ' items';
    v_region := null;
  elsif (v_plan -> 0 ->> 'quantity')::integer > 1 then
    v_label := v_label || ' x ' || (v_plan -> 0 ->> 'quantity');
  end if;

  insert into public.orders (user_id, product_name, option_label, amount, status, delivery, fulfillment, region_label)
  values (v_user, v_name, v_label, v_total, 'pending_payment', '{}'::jsonb,
          case when v_topup then 'topup' else 'code' end, v_region)
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

  return jsonb_build_object('order_id', v_order, 'amount', v_total, 'items', v_lines);
end;
$$;

revoke all on function public.create_cart_order() from public, anon;
grant execute on function public.create_cart_order() to authenticated;

------------------------------------------------------------------------------
-- 2. cancel an unpaid order (its lines go back in the cart)
------------------------------------------------------------------------------

create or replace function public.cancel_pending_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_o    record;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select id, status, verifying_since into v_o
    from public.orders where id = p_order and user_id = v_user for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_o.status <> 'pending_payment' then
    raise exception 'order_not_cancellable' using errcode = 'P0001', detail = v_o.status;
  end if;
  -- A payment check is running right now: don't pull the order out from under it.
  if v_o.verifying_since is not null and v_o.verifying_since > now() - interval '90 seconds' then
    raise exception 'order_not_cancellable' using errcode = 'P0001', detail = 'verifying';
  end if;

  update public.orders
     set status = 'cancelled', payment_provider = null, payment_reference = null, verifying_since = null
   where id = p_order;

  insert into public.cart_items (user_id, option_id, quantity, fields, id_checked)
  select v_user, i.option_id, i.quantity,
         coalesce(i.delivery -> 'fields',
                  case when i.delivery ? 'account_id' then jsonb_build_object('account_id', i.delivery ->> 'account_id') else '{}'::jsonb end),
         i.id_self_declared_at is not null
    from public.order_items i
   where i.order_id = p_order and i.option_id is not null
  on conflict (user_id, option_id, fields_key)
  do update set quantity = least(public.cart_items.quantity + excluded.quantity, 20);
end;
$$;

revoke all on function public.cancel_pending_order(uuid) from public, anon;
grant execute on function public.cancel_pending_order(uuid) to authenticated;

------------------------------------------------------------------------------
-- 3. payment verification: begin (claim) ... finish (record)
------------------------------------------------------------------------------

-- Result of begin:
--   {"result":"not_found"}                      no such order, or it is not this user's (never says which)
--   {"result":"closed","status":"paid"|...}     the order is no longer awaiting payment: answer idempotently
--   {"result":"in_progress"}                    another request is checking this order right now
--   {"result":"reference_used"}                 that transfer already pays a DIFFERENT order
--   {"result":"go","amount":..., "provider":..., "reference":..., "account_name":...}   proceed to ShegerPay
create or replace function public.begin_payment_verification(
  p_order     uuid,
  p_user      uuid,
  p_provider  text,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o        record;
  v_released integer;
  v_name     text;
begin
  select id, user_id, status, amount, verifying_since into v_o
    from public.orders where id = p_order for update;

  if not found or v_o.user_id <> p_user then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_o.status <> 'pending_payment' then
    return jsonb_build_object('result', 'closed', 'status', v_o.status);
  end if;

  if v_o.verifying_since is not null and v_o.verifying_since > now() - interval '90 seconds' then
    return jsonb_build_object('result', 'in_progress');
  end if;

  select account_name into v_name from public.payment_accounts where provider = p_provider;

  -- Claim the transfer for THIS order. The unique constraint is what really refuses a second order.
  for i in 1..2 loop
    begin
      update public.orders
         set payment_provider = p_provider, payment_reference = p_reference,
             verifying_since = now(), payment_attempts = payment_attempts + 1
       where id = p_order;
      return jsonb_build_object('result', 'go', 'amount', v_o.amount, 'provider', p_provider,
                                'reference', p_reference, 'account_name', v_name);
    exception when unique_violation then
      -- If the holder is an unpaid order whose check died long ago (a crash), free the claim once and retry.
      update public.orders
         set payment_provider = null, payment_reference = null, verifying_since = null
       where status = 'pending_payment' and payment_provider = p_provider and payment_reference = p_reference
         and id <> p_order
         and (verifying_since is null or verifying_since < now() - interval '90 seconds');
      get diagnostics v_released = row_count;
      if v_released = 0 then
        return jsonb_build_object('result', 'reference_used');
      end if;
    end;
  end loop;
  return jsonb_build_object('result', 'reference_used');
end;
$$;

-- outcome: paid | mismatch | not_verified | unavailable
create or replace function public.finish_payment_verification(
  p_order    uuid,
  p_outcome  text,
  p_amount   numeric,
  p_mode     text,
  p_http     integer,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_o record;
begin
  if p_outcome not in ('paid', 'mismatch', 'not_verified', 'unavailable') then
    raise exception 'bad_outcome' using errcode = '22023';
  end if;

  select id, status, amount, payment_provider, payment_reference into v_o
    from public.orders where id = p_order for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_o.status <> 'pending_payment' then
    return jsonb_build_object('result', 'closed', 'status', v_o.status);
  end if;
  if v_o.payment_reference is null then
    raise exception 'no_claimed_reference' using errcode = 'P0001';
  end if;

  insert into public.payment_attempts (order_id, provider, reference, outcome, verified_amount, mode, http_status, response)
  values (p_order, v_o.payment_provider, v_o.payment_reference, p_outcome, p_amount, p_mode, p_http, p_response);

  if p_outcome = 'paid' then
    -- The database refuses to accept any payment that is not exactly the order total.
    if p_amount is distinct from v_o.amount then
      raise exception 'paid_amount_must_equal_total' using errcode = 'P0001';
    end if;
    update public.orders
       set status = 'paid', paid_at = now(), payment_verified_amount = p_amount,
           payment_mode = coalesce(p_mode, 'live'), verifying_since = null
     where id = p_order;
    return jsonb_build_object('result', 'paid');
  elsif p_outcome = 'mismatch' then
    -- Needs a person. The reference stays claimed so this transfer cannot be reused for another order.
    update public.orders
       set status = 'payment_mismatch', payment_verified_amount = p_amount,
           payment_mode = coalesce(p_mode, 'live'), verifying_since = null
     where id = p_order;
    return jsonb_build_object('result', 'mismatch');
  else
    -- Not confirmed: free the reference so the customer can correct it and try again.
    update public.orders
       set payment_provider = null, payment_reference = null, verifying_since = null
     where id = p_order;
    return jsonb_build_object('result', p_outcome);
  end if;
end;
$$;

-- Only the Edge Function (service role) may run these two; a customer can never call them directly.
revoke all on function public.begin_payment_verification(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finish_payment_verification(uuid, text, numeric, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.begin_payment_verification(uuid, uuid, text, text) to service_role;
grant execute on function public.finish_payment_verification(uuid, text, numeric, text, integer, jsonb) to service_role;
