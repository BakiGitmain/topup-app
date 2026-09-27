-- Follow-up: discount_codes gets a per-code Portal Coin bonus (default 2, matching the flat amount every
-- code-using order used to earn), replacing the hardcoded "2" in _complete_order. An admin can now set a bigger (or
-- smaller, but never less than 1 -- redeeming a code must still earn something) bonus per code, e.g. a promo code
-- worth 10 coins. Plain orders (no code) are unaffected: still a flat +1, nothing here changes that.
--
-- (The other three items in this round -- the double-submit checkout-code bug, the real date picker for expiry, and
-- moving the Portal Coin pill to the header -- are client-only; nothing else to migrate.)

alter table public.discount_codes
  add column if not exists portal_coin_bonus integer not null default 2 check (portal_coin_bonus >= 1);

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
  end if;

  -- +1 Portal Coin for any completed order; a code-using order earns that code's OWN portal_coin_bonus instead
  -- (never additive on top of the +1 -- the whole amount, same as the old flat +2 was).
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
