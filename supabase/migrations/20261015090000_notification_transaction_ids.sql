-- Actionable notifications: each money notification now names the exact wallet_transactions row it is about
-- (data.transaction_id), so tapping it can scroll the Transactions list to that row. Nothing else changes.
--   deposit_approved / refund_credited / commission_credited: the ledger row that fired the trigger (new.id).
--   withdrawal_sent: the 'withdrawal' row that held the money when the customer asked (its withdrawal_id is this
--   request); marking it paid moves no money, so there is no newer row to point at.
-- product_discount already carries product_id and option_id; the product page finds the pack's region/category.

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
            jsonb_build_object('amount', v_amount, 'deposit_id', new.deposit_id, 'transaction_id', new.id), new.user_id);

  elsif new.kind = 'refund' and new.order_id is not null then
    insert into public.notifications (type, title, body, data, user_id)
    values ('refund_credited', 'Refund credited', format('Br %s refunded to your wallet', v_amount),
            jsonb_build_object('amount', v_amount, 'order_id', new.order_id, 'transaction_id', new.id), new.user_id);

  elsif new.kind = 'commission' then
    select dc.code into v_code
      from public.orders o
      join public.discount_codes dc on dc.id = coalesce(o.discount_code_id, o.coin_bonus_code_id)
     where o.id = new.order_id;
    insert into public.notifications (type, title, body, data, user_id)
    values ('commission_credited', 'Commission earned',
            case when v_code is null then format('Br %s commission added to your wallet', v_amount)
                 else format('Br %s from code %s', v_amount, v_code) end,
            jsonb_build_object('amount', v_amount, 'discount_code', v_code, 'order_id', new.order_id, 'transaction_id', new.id),
            new.user_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_wallet_credit() from public, anon, authenticated;

create or replace function public.notify_withdrawal_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := trim_scale(new.amount);
  v_tx     uuid;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    select id into v_tx
      from public.wallet_transactions
     where withdrawal_id = new.id and kind = 'withdrawal'
     order by created_at
     limit 1;
    insert into public.notifications (type, title, body, data, user_id)
    values ('withdrawal_sent', 'Withdrawal sent', format('Br %s sent to you', v_amount),
            jsonb_build_object('amount', v_amount, 'withdrawal_id', new.id, 'transaction_id', v_tx), new.user_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_withdrawal_paid() from public, anon, authenticated;
