-- Rework: discount-code eligibility is now per-customer-PER-CODE, not "one discount ever, any code, platform-wide".
-- A specific code discounts a specific customer's order only the first time THAT customer redeems THAT code, tracked
-- via the existing code_redemptions table (customer_id + code_id) -- not order history. Using a code the customer
-- has already redeemed is NOT an error any more: the order simply gets no discount from it (full price), and earns
-- the flat base +1 Portal Coin instead of that code's own bonus, exactly as if no code had been typed. Expiry,
-- active, and per-code product restrictions are unchanged and still apply on top of this.
--
-- create_cart_order is redefined with the SAME signature, copied verbatim except the one eligibility block (see
-- below); nothing about the cart loop, the discount/commission math, the order insert, or _complete_order changes.
--
-- Also new: preview_discount_code(p_code), a read-only RPC for the cart screen's live-as-you-type validation (see
-- the client work in the same round). It runs the same lookup/eligibility checks against the customer's CURRENT
-- cart_items, without creating or locking anything, and returns only birr amounts -- never discount_percent,
-- commission_percent or the creator's identity, per the existing rule that customers only ever see their own
-- resulting discount, not the code's economics.
--
-- FLAGGING A GAP FOUND WHILE BUILDING THIS, closed rather than shipped: code_redemptions is only written when an
-- order reaches 'completed' (item 2's own design, kept). Eligibility taken literally as "no existing
-- code_redemptions row" would let a customer redeem the SAME code twice over: create order #1 with CODE1 (discount
-- applied, order created as 'pending_payment' -- no redemption row yet), pay it (now 'paid', still no redemption
-- row until an admin delivers it, which can take a while -- see the admin queue), then check out a SECOND cart
-- with CODE1 again while #1 is still sitting 'paid'/'processing' -- nothing yet says CODE1 is used, so it would
-- discount again. Both orders would eventually insert their own code_redemptions row on completion: two discounts
-- and two coin bonuses from one "first use." Closed the same way the previous round's platform-wide rule did (an
-- order in 'paid'/'processing' counts as already claimed, not only 'completed') but scoped to THIS code, not every
-- code: a customer is blocked from re-discounting with CODE1 the moment any of their own orders has charged them
-- with it and gotten at least as far as being paid for, whether or not it has been delivered yet. A different code
-- is completely unaffected.

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
    if v_code_row.expires_at is not null and v_code_row.expires_at <= now() then
      raise exception 'code_expired' using errcode = 'P0001';
    end if;
    -- REWORKED (was: no prior order anywhere, platform-wide). Per-code-per-customer: if THIS customer has already
    -- redeemed THIS code, OR already has an order that charged them with it and got at least as far as being paid
    -- for (see the header: closes the double-discount race, scoped to this one code), that is NOT an error -- the
    -- code just stops discounting. Nulling the whole row here makes every check below it (applicability,
    -- discount/commission math, the order's discount_code_id) behave exactly as if no code had been typed, with no
    -- separate branch to keep in sync: a NULL composite's fields all read as NULL, so `v_code_row.id is not null`
    -- correctly comes out false.
    if exists (select 1 from public.code_redemptions where customer_id = v_user and code_id = v_code_row.id)
       or exists (select 1 from public.orders where user_id = v_user and discount_code_id = v_code_row.id and status in ('paid', 'processing', 'completed'))
    then
      v_code_row := null;
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
  -- (v_code_row is NULL here if the code was already redeemed by this customer -- see above -- so this whole block
  -- is skipped exactly like "no code was typed", never raising code_not_applicable for an already-used code.)
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
-- preview_discount_code: read-only, for the cart screen's live-as-you-type validation. Never creates, locks or
-- redeems anything -- just tells the customer whether a code would apply to their CURRENT cart, and for how much.
-------------------------------------------------------------------------------

create or replace function public.preview_discount_code(
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_code_norm  text;
  v_code_row   public.discount_codes;
  v_total      numeric(14, 2) := 0;
  v_applicable numeric(14, 2) := 0;
  v_discount   numeric(14, 2) := 0;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_code_norm := btrim(coalesce(p_code, ''));
  if v_code_norm = '' then
    return jsonb_build_object('ok', false, 'problem', 'code_not_found');
  end if;

  select * into v_code_row from public.discount_codes where upper(code) = upper(v_code_norm);
  if not found then
    return jsonb_build_object('ok', false, 'problem', 'code_not_found');
  end if;
  if not v_code_row.active then
    return jsonb_build_object('ok', false, 'problem', 'code_inactive');
  end if;
  if v_code_row.expires_at is not null and v_code_row.expires_at <= now() then
    return jsonb_build_object('ok', false, 'problem', 'code_expired');
  end if;
  -- Same "already claimed" test as create_cart_order (see its migration header): a prior order that charged this
  -- customer with this code and got at least as far as being paid counts too, not only a completed redemption.
  if exists (select 1 from public.code_redemptions where customer_id = v_user and code_id = v_code_row.id)
     or exists (select 1 from public.orders where user_id = v_user and discount_code_id = v_code_row.id and status in ('paid', 'processing', 'completed'))
  then
    return jsonb_build_object('ok', false, 'problem', 'code_already_used');
  end if;

  -- The customer's current cart, priced the same way create_cart_order does -- but read-only: no availability
  -- re-check, no lock, nothing written. A pack going off sale between this preview and the real checkout is
  -- exactly what create_cart_order's own all-or-nothing recheck is for; this is a preview, not a commitment.
  select
    coalesce(sum(o.price * c.quantity), 0),
    coalesce(sum(o.price * c.quantity) filter (
      where v_code_row.applicable_products is null or p.id = any (v_code_row.applicable_products)
    ), 0)
    into v_total, v_applicable
    from public.cart_items c
    join public.product_options o on o.id = c.option_id
    join public.products p on p.id = o.product_id
   where c.user_id = v_user;

  if v_total <= 0 then
    return jsonb_build_object('ok', false, 'problem', 'cart_empty');
  end if;
  if v_applicable <= 0 then
    return jsonb_build_object('ok', false, 'problem', 'code_not_applicable');
  end if;

  v_discount := round(v_applicable * v_code_row.discount_percent / 100, 2);

  -- Only birr amounts go back -- never discount_percent, commission_percent or the creator's identity (the
  -- customer sees their own resulting discount, nothing about the code's economics).
  return jsonb_build_object('ok', true, 'discount_amount', v_discount, 'total', v_total, 'new_total', v_total - v_discount);
end;
$$;

revoke all on function public.preview_discount_code(text) from public, anon;
grant execute on function public.preview_discount_code(text) to authenticated;
