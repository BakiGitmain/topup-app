-- Fix to 20261014090000: a commission earned on a REUSED creator code (orders.coin_bonus_code_id set, no
-- discount_code_id -- see 20261009090000) was announced without naming the code. Look the code up the same way
-- _complete_order does when it credits the commission: coalesce(discount_code_id, coin_bonus_code_id). Nothing
-- else in the function changes.
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
      join public.discount_codes dc on dc.id = coalesce(o.discount_code_id, o.coin_bonus_code_id)
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
