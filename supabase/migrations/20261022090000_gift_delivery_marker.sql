-- Gifts: a permanent marker on the recipient's delivery order. FORWARD-ONLY, re-runnable. Fixes 20261021090000.
--
-- BUG (found live 2026-09-27 by the gift test's cleanup): 20261021090000 allowed a Br 0 order only while
-- orders.gift_id is set. But gift_id is ON DELETE SET NULL, so deleting a gift row (cleanup, or deleting an account
-- that holds claimed gifts: its gifts cascade away) clears the link -- and the delivery order, still Br 0, then broke
-- the check and the whole delete failed. "Is this a gift delivery" must not depend on a link that can be cleared.
--
-- FIX: orders.is_gift_delivery, set once when the order is created (from gift_id at insert) and never changed.
-- The Br 0 rule and admin_set_order_status's refusal read it; the app does too (lib/orderView giftSideOf).

alter table public.orders add column if not exists is_gift_delivery boolean not null default false;

-- Set at insert from the gift link, then frozen.
create or replace function public.orders_gift_delivery_marker()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.is_gift_delivery := new.gift_id is not null;
  elsif new.is_gift_delivery is distinct from old.is_gift_delivery then
    raise exception 'gift_delivery_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.orders_gift_delivery_marker() from public, anon, authenticated;

-- Existing delivery orders (before the triggers exist, so the freeze doesn't refuse the backfill).
drop trigger if exists orders_gift_delivery_marker_ins on public.orders;
drop trigger if exists orders_gift_delivery_marker_upd on public.orders;
update public.orders set is_gift_delivery = true where gift_id is not null and not is_gift_delivery;
create trigger orders_gift_delivery_marker_ins before insert on public.orders
  for each row execute function public.orders_gift_delivery_marker();
create trigger orders_gift_delivery_marker_upd before update of is_gift_delivery on public.orders
  for each row execute function public.orders_gift_delivery_marker();

alter table public.orders drop constraint if exists orders_amount_check;
alter table public.orders add constraint orders_amount_check
  check (amount > 0 or (amount = 0 and is_gift_delivery));

-- As in 20261021090000, reading the marker instead of gift_id.
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

  -- A gift delivery is not a sale -- it carries no price (Br 0) and the buyer paid on their own order -- so it can
  -- never be failed or refunded. Refused here, first, with its real reason. Read from the permanent marker, not
  -- gift_id: that link is cleared if the gift row is ever deleted, the marker is not.
  if v_order.is_gift_delivery and p_status in ('failed', 'refunded') then
    raise exception 'gift_delivery_locked' using errcode = 'P0001';
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
revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;
