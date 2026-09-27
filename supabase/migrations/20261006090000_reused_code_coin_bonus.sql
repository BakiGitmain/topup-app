-- Small fix: reusing an already-redeemed discount code correctly gives no discount, but was falling back to the
-- flat base +1 Portal Coin instead of the code's own portal_coin_bonus. It should credit that bonus every time the
-- code is used, discount or not, until the code expires or goes inactive.
--
-- `orders.coin_bonus_code_id` carries the code through to _complete_order for a REUSED code only (discount_code_id
-- stays null for a reuse, exactly as before -- that column still means "a discount was actually applied and a
-- code_redemptions row should be logged at completion", unchanged). A first-time use still sets discount_code_id,
-- not this column, so its existing +bonus/redemption-logging path is untouched.

alter table public.orders add column if not exists coin_bonus_code_id uuid references public.discount_codes (id) on delete restrict;

-------------------------------------------------------------------------------
-- create_cart_order: same signature, same body, plus: capture the reused code's id into v_bonus_code_id instead of
-- discarding it, and carry it onto the order.
-------------------------------------------------------------------------------

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
  -- ---- a REUSED code: no discount, but its own portal_coin_bonus still applies -- see the migration header.
  v_bonus_code_id  uuid;
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
    -- discounting, but its OWN portal_coin_bonus still applies every time (carried through via v_bonus_code_id, read
    -- back in _complete_order). Nulling v_code_row makes every check below it behave exactly as if no code had been
    -- typed -- no discount, no applicable-products gate, no code_redemptions row.
    if exists (select 1 from public.code_redemptions where customer_id = v_user and code_id = v_code_row.id)
       or exists (select 1 from public.orders where user_id = v_user and discount_code_id = v_code_row.id and status in ('paid', 'processing', 'completed'))
    then
      v_bonus_code_id := v_code_row.id;
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
     discount_code_id, discount_amount, commission_amount, wheel_prize_won_id, coin_bonus_code_id)
  values
    (v_user, v_name, v_label, v_total - v_discount, 'pending_payment', '{}'::jsonb,
     case when v_topup then 'topup' else 'code' end, v_region,
     v_code_row.id, v_discount, v_commission, v_wheel_prize.id, v_bonus_code_id)
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

-------------------------------------------------------------------------------
-- _complete_order: same signature, same body, plus one new branch: a reused code (coin_bonus_code_id set,
-- discount_code_id null) credits that code's own portal_coin_bonus instead of the flat +1 -- no code_redemptions
-- row, since it was already logged the first time this code was used.
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
  -- (never additive on top of the +1 -- the whole amount, same as the old flat +2 was). A REUSED code (no discount,
  -- coin_bonus_code_id set instead of discount_code_id) still earns that same bonus, every time, until the code
  -- expires or goes inactive -- just with no code_redemptions row, since that was already logged on first use. A
  -- wheel-discounted order is NOT special-cased (see the migration header, flag 5): it falls into the same flat +1
  -- as any code-less order.
  if v_order.discount_code_id is not null then
    select portal_coin_bonus into v_coin_amount from public.discount_codes where id = v_order.discount_code_id;
    v_coin_kind := 'earn_purchase_discount';
  elsif v_order.coin_bonus_code_id is not null then
    select portal_coin_bonus into v_coin_amount from public.discount_codes where id = v_order.coin_bonus_code_id;
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

-------------------------------------------------------------------------------
-- preview_discount_code: same signature, same body, plus: the code_already_used branch now also returns
-- portal_coin_bonus, so the cart screen can say "you'll get +N Portal Coin instead of a discount" instead of a
-- plain blocking error. Still never returns discount_percent/commission_percent/creator identity.
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
    -- Fixed 2026-10-06: the code's own bonus still credits on reuse (see create_cart_order/_complete_order above),
    -- so the client can say so instead of just "blocked."
    return jsonb_build_object('ok', false, 'problem', 'code_already_used', 'portal_coin_bonus', v_code_row.portal_coin_bonus);
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
