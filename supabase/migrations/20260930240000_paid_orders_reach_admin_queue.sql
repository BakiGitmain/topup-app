-- Closes the gap flagged in CLAUDE.md since the payments work first went in: an order that reaches 'paid' (bank
-- transfer via finish_payment_verification, or instant wallet payment via pay_order_with_wallet/checkout_cart) was
-- never visible to the admin fulfilment queue and could never be delivered -- admin_deliver_order only accepted
-- 'pending'/'processing', and the queue's own reads only ever looked for 'pending'. Two real customer orders (Roblox,
-- 800 Robux) are stuck exactly this way right now; this migration does not touch them directly, but the app's own
-- admin actions can now act on them once this is live (see the report for how to check).
--
-- THE FIX IS NOT "rename the stored status from 'paid' to 'pending'" -- that was the literal first idea, but
-- pay/[id].tsx's own success screen (the "Payment confirmed" screen the customer sees the moment they pay) keys
-- specifically off `status === 'paid'` (src/app/pay/[id].tsx:170); overwriting it to 'pending' in the same
-- transaction would make that screen show "closed" instead of "paid" for every real payment. orderView.ts's
-- fulfilmentOf() already anticipated this exact fork in its own comment: "today only orders that went through the
-- older direct-purchase path (pending/processing/completed) carry a delivery status; an order that is merely 'paid'
-- has none yet because fulfilment for paid orders is not built." So the fix is the other direction: 'paid' becomes a
-- second, equally valid ENTRY POINT into the same fulfilment funnel 'pending' already has -- nothing about
-- finish_payment_verification or pay_order_with_wallet changes; they keep setting 'paid', exactly as today.
--
-- WHAT CHANGES HERE (both copied verbatim from their current definitions, one clause each):
--   admin_deliver_order    now accepts status 'paid' as well as 'pending'/'processing' before marking 'completed'
--                          (and, for a code product, writing vault_codes) -- this is the one that actually
--                          delivers an order, so THIS clause is what unblocks the two stuck Roblox orders.
--   admin_set_order_status now also allows 'paid' -> 'processing' and 'paid' -> 'failed' (refund), the same two
--                          transitions already allowed from 'pending', so a paid order has the same admin actions
--                          available as a pending one, not a partial set.
-- The client-side half (admin.ts's queue reads, OrderSheet's action-panel gate, orderView's fulfilment display) is
-- a separate, non-SQL change -- see the same commit/PR.

create or replace function public.admin_deliver_order(
  p_order_id uuid,
  p_code     text default null
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
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status not in ('paid', 'pending', 'processing') then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if v_order.fulfillment = 'code' then
    v_code := btrim(coalesce(p_code, ''));
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

  return v_order;
end;
$$;

create or replace function public.admin_set_order_status(
  p_order_id uuid,
  p_status   text
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders;
  v_balance numeric(14, 2);
  v_new     numeric(14, 2);
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_status not in ('processing', 'failed', 'refunded') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- The customer already holds the code, so the money can't come back.
  if p_status = 'refunded' and v_order.status = 'completed' and v_order.fulfillment = 'code' then
    raise exception 'code_already_delivered' using errcode = 'P0001';
  end if;

  if not (
    (v_order.status = 'paid'       and p_status in ('processing', 'failed')) or
    (v_order.status = 'pending'    and p_status in ('processing', 'failed')) or
    (v_order.status = 'processing' and p_status = 'failed') or
    (v_order.status = 'completed'  and p_status = 'refunded')
  ) then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if p_status in ('failed', 'refunded') then
    select balance into v_balance
      from public.wallets where user_id = v_order.user_id for update;

    v_new := v_balance + v_order.amount;
    update public.wallets set balance = v_new where user_id = v_order.user_id;

    insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note, created_by)
    values (
      v_order.user_id, 'refund', v_order.amount, v_new, v_order.id,
      'Refund: ' || v_order.product_name || ' - ' || v_order.option_label,
      auth.uid()
    );
  end if;

  update public.orders set status = p_status where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

revoke all on function public.admin_deliver_order(uuid, text) from public, anon;
revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
grant execute on function public.admin_deliver_order(uuid, text) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;
