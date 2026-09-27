-- Both purchase_product_option and create_cart_order decide "topup" (needs a player ID, delivered straight to an
-- account) vs "code" (a Vault redeemable, no account) from category in ('games', 'airtime') -- a list that predates
-- the 'subscriptions' category (Telegram Premium/Stars is now live and needs exactly the same treatment as a game
-- top-up). Audited every category any live product actually uses (2026-09-23): games, gift-cards, subscriptions.
-- 'subscriptions' is the only gap; gift-cards is correctly excluded (code/Vault, unchanged); game-keys is not live
-- but is intentionally left OUT of this list too, matching gift-cards (a game key is also a Vault code, never a
-- player ID). This affects order.fulfillment / order_items -- which queue an order shows in and what the admin sees
-- ("needs player ID" vs "code") -- not whether an ID is collected at all (that is buyer_fields/id_validation, per
-- region, already correct and untouched).
--
-- Both function bodies below are copied verbatim from their current live definitions (purchase_product_option:
-- 20260924090000_id_validation.sql; create_cart_order: 20260927110000_checkout_functions.sql) with ONLY the three
-- occurrences of `category in ('games', 'airtime')` changed to add 'subscriptions'. Nothing else in either function
-- is touched.

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

  v_fulfillment := case when v_opt.category in ('games', 'airtime', 'subscriptions') then 'topup' else 'code' end;

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

revoke all on function public.purchase_product_option(uuid, jsonb, boolean) from public, anon;
grant execute on function public.purchase_product_option(uuid, jsonb, boolean) to authenticated;

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
        'option_id', v_line.option_id, 'product_name', v_line.product_name, 'label', v_line.label,
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
