-- Notification triggers, reworked: the discount-code broadcast is removed; a product-sale broadcast and four
-- targeted money notifications are added. Same notifications/notification_seen tables, same realtime, badge, seen
-- timer and 3-day expiry -- only the events that write rows change. Each is a new `type` value; no schema change.
--
--   product_discount     broadcast  a pack goes ON SALE (see below)
--   deposit_approved     targeted   a deposit request is verified and credited
--   refund_credited      targeted   an ORDER refund is credited back
--   commission_credited  targeted   a creator's commission is credited
--   withdrawal_sent      targeted   an admin marks a withdrawal as paid (never at request time)
--
-- The three money-in types come from ONE trigger on wallet_transactions, the append-only ledger every credit
-- already goes through (wallet_apply() or the older direct inserts). Nothing that moves money is edited: the
-- notification is written in the same transaction as the ledger row, so a credit that rolls back never notifies,
-- and any future path that credits the same way is covered automatically. The ledger's own link columns tell the
-- cases apart exactly:
--   kind 'deposit'    + deposit_id set  -> a verified deposit request (finish_deposit_verification). A manual admin
--                                          credit (admin_adjust_balance) is also kind 'deposit' but has no
--                                          deposit_id, so it is NOT announced.
--   kind 'refund'     + order_id set    -> an order refund (admin_set_order_status). A declined withdrawal's refund
--                                          carries withdrawal_id instead, so it is NOT announced as an order refund.
--   kind 'commission'                   -> the creator's commission (_complete_order), order_id names the code.

-- 1. The discount-code broadcast goes away entirely.
drop trigger if exists discount_codes_notify on public.discount_codes;
drop function if exists public.notify_discount_code_active();

-- 2. "On sale", defined exactly as the shop's own "-N%" badge (priceDisplay in src/lib/pricing.ts): an old price
-- above zero and strictly above the price, marking it down by at least 1% once rounded; shown as at most 99%.
-- Only an active pack counts as on sale -- a hidden pack isn't something a customer can see or buy.
create or replace function public.pack_sale_percent(p_price numeric, p_old numeric)
returns integer
language sql
immutable
as $$
  select case
    when p_price is null or p_price <= 0 or p_old is null or p_old <= 0 or p_old <= p_price then null
    when round((p_old - p_price) / p_old * 100) < 1 then null
    else least(round((p_old - p_price) / p_old * 100), 99)::integer
  end
$$;

-- Announces a pack only on the TRANSITION into sale: it wasn't on sale before (no gap, inactive, or brand new) and
-- is now. Editing the price again while it stays on sale announces nothing; ending the sale and starting a new one
-- later is a fresh transition and announces again. A pack of a hidden product is not announced.
create or replace function public.notify_pack_on_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pct      integer := case when new.is_active then public.pack_sale_percent(new.price, new.old_price) end;
  v_was      integer;
  v_product  public.products;
begin
  if v_pct is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_was := case when old.is_active then public.pack_sale_percent(old.price, old.old_price) end;
    if v_was is not null then
      return new;
    end if;
  end if;

  select * into v_product from public.products where id = new.product_id;
  if not found or not v_product.is_active then
    return new;
  end if;

  insert into public.notifications (type, title, body, data)
  values (
    'product_discount',
    'On sale now',
    left(format('%s %s now %s%% off', v_product.name, new.label, v_pct), 500),
    jsonb_build_object(
      'product_id', v_product.id,
      'option_id', new.id,
      'product_name', v_product.name,
      'pack_label', new.label,
      'discount_percent', v_pct,
      'price', new.price,
      'old_price', new.old_price
    )
  );
  return new;
end;
$$;
revoke all on function public.notify_pack_on_sale() from public, anon, authenticated;

drop trigger if exists product_options_notify_sale on public.product_options;
create trigger product_options_notify_sale
  after insert or update of price, old_price, is_active on public.product_options
  for each row execute function public.notify_pack_on_sale();

-- 3-5. Money in: deposit approved, order refund, creator commission.
create or replace function public.notify_wallet_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := trim_scale(abs(new.amount));
  v_code   text;
begin
  if new.amount <= 0 then
    return new;
  end if;

  if new.kind = 'deposit' and new.deposit_id is not null then
    insert into public.notifications (type, title, body, data, user_id)
    values ('deposit_approved', 'Deposit approved', format('Br %s added to your wallet', v_amount),
            jsonb_build_object('amount', v_amount, 'deposit_id', new.deposit_id), new.user_id);

  elsif new.kind = 'refund' and new.order_id is not null then
    insert into public.notifications (type, title, body, data, user_id)
    values ('refund_credited', 'Refund credited', format('Br %s refunded to your wallet', v_amount),
            jsonb_build_object('amount', v_amount, 'order_id', new.order_id), new.user_id);

  elsif new.kind = 'commission' then
    select dc.code into v_code
      from public.orders o
      join public.discount_codes dc on dc.id = o.discount_code_id
     where o.id = new.order_id;
    insert into public.notifications (type, title, body, data, user_id)
    values ('commission_credited', 'Commission earned',
            case when v_code is null then format('Br %s commission added to your wallet', v_amount)
                 else format('Br %s from code %s', v_amount, v_code) end,
            jsonb_build_object('amount', v_amount, 'discount_code', v_code, 'order_id', new.order_id), new.user_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_wallet_credit() from public, anon, authenticated;

drop trigger if exists wallet_transactions_notify on public.wallet_transactions;
create trigger wallet_transactions_notify
  after insert on public.wallet_transactions
  for each row execute function public.notify_wallet_credit();

-- 6. Withdrawal sent: only when an admin marks it paid, never at request time (a request starts 'pending').
create or replace function public.notify_withdrawal_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := trim_scale(new.amount);
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    insert into public.notifications (type, title, body, data, user_id)
    values ('withdrawal_sent', 'Withdrawal sent', format('Br %s sent to you', v_amount),
            jsonb_build_object('amount', v_amount, 'withdrawal_id', new.id), new.user_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_withdrawal_paid() from public, anon, authenticated;

drop trigger if exists withdrawal_requests_notify_paid on public.withdrawal_requests;
create trigger withdrawal_requests_notify_paid
  after update of status on public.withdrawal_requests
  for each row execute function public.notify_withdrawal_paid();
