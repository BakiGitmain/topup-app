-- topup: wallet. Part 7 of 7: pay an order from the wallet at checkout.
-- Run AFTER 20260928140000_withdrawal_functions.sql. Safe to re-run.
--
-- THE RULE (yours): at checkout, if the balance covers the order total, pay instantly from the wallet and skip the
-- bank-transfer screen. If it doesn't, fall back to the existing Telebirr/CBE flow, unchanged. All of the balance or
-- none of it: no partial balance + partial transfer.
--
-- WHAT THIS ADDS
--   checkout_cart()          the app's checkout call now. It runs the existing create_cart_order() (all the availability
--                            and ID re-checks, unchanged) and, in the SAME transaction, pays it from the wallet if the
--                            balance covers the total. If the funds vanished a moment earlier (another request took
--                            them), it quietly falls back to the unpaid bank-transfer order instead of failing.
--   pay_order_with_wallet()  pays one of the customer's OWN unpaid orders from the wallet. Used by checkout_cart, and by
--                            the payment screen for someone who has an unpaid order and has since topped up.
--
-- WHY A WALLET PAYMENT AND A BANK PAYMENT CAN'T BOTH BE TAKEN FOR ONE ORDER
--   Both lock the order row. Wallet pay refuses unless the order is still 'pending_payment' AND no bank check is in
--   flight (the same 90-second rule cancel uses); a bank check that finishes later finds the order already 'paid' and
--   answers "closed" without touching it. Bank pay that finished first leaves the order 'paid' and wallet pay refuses.
--   And there is at most ONE unpaid order per customer, so two orders can never be waiting on the same wallet funds.
--
-- EXISTING TABLE CHANGE (orders, additive): the provider 'wallet' and the mode 'wallet' become allowed, and a wallet
-- payment has no bank reference. The bank-payment rules are otherwise exactly as before.
--
-- NOT DONE HERE (Vault/delivery, out of scope as before): acting on a paid order. A wallet-paid order is 'paid' like a
-- bank-paid one. Refunding a paid order isn't built for either kind: the TODO in 20260927110000 stands.

alter table public.orders drop constraint if exists orders_payment_provider_check;
alter table public.orders add constraint orders_payment_provider_check
  check (payment_provider is null or payment_provider in ('telebirr', 'cbe', 'wallet'));

alter table public.orders drop constraint if exists orders_payment_mode_check;
alter table public.orders add constraint orders_payment_mode_check
  check (payment_mode is null or payment_mode in ('test', 'live', 'wallet'));

-- Bank providers carry a reference; the wallet and "nothing yet" carry none.
alter table public.orders drop constraint if exists orders_payment_pair_check;
alter table public.orders add constraint orders_payment_pair_check check (
  case when payment_provider is null or payment_provider = 'wallet' then payment_reference is null
       else payment_reference is not null end
);

alter table public.orders drop constraint if exists orders_paid_needs_payment_check;
alter table public.orders add constraint orders_paid_needs_payment_check check (
  status not in ('paid', 'payment_mismatch')
  or (payment_mode is not null and (payment_reference is not null or payment_provider = 'wallet'))
);

create or replace function public.pay_order_with_wallet(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_o       record;
  v_balance numeric(14, 2);
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select id, status, amount, verifying_since into v_o
    from public.orders where id = p_order and user_id = v_user for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_o.status <> 'pending_payment' then
    raise exception 'order_not_payable' using errcode = 'P0001', detail = v_o.status;
  end if;
  if v_o.verifying_since is not null and v_o.verifying_since > now() - interval '90 seconds' then
    raise exception 'order_not_payable' using errcode = 'P0001', detail = 'verifying';
  end if;

  -- The atomic balance check + deduction (raises insufficient_balance; nothing changes if it does).
  v_balance := public.wallet_apply(v_user, -v_o.amount, 'purchase', 'Order ' || left(v_o.id::text, 8), p_order => v_o.id);

  -- Any bank reference left over from an abandoned attempt is released: this order is settled by the wallet.
  update public.orders
     set status = 'paid', paid_at = now(), payment_provider = 'wallet', payment_reference = null,
         payment_mode = 'wallet', payment_verified_amount = v_o.amount, verifying_since = null
   where id = p_order;

  return jsonb_build_object('status', 'paid', 'amount', v_o.amount, 'balance', v_balance);
end;
$$;

-- Returns what create_cart_order returns ({order_id, amount, items}) plus {"paid": bool, "balance": number}.
create or replace function public.checkout_cart()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_order   jsonb;
  v_balance numeric(14, 2);
  v_paid    jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Every existing check (products on sale, packs active, region valid, each line's ID) happens in here, all or nothing.
  v_order := public.create_cart_order();

  select balance into v_balance from public.wallets where user_id = v_user;
  if coalesce(v_balance, 0) >= (v_order ->> 'amount')::numeric then
    begin
      v_paid := public.pay_order_with_wallet((v_order ->> 'order_id')::uuid);
      return v_order || jsonb_build_object('paid', true, 'balance', v_paid -> 'balance');
    exception when raise_exception then
      -- The funds were taken between the read and the deduction: keep the unpaid order for the bank-transfer flow.
      if sqlerrm <> 'insufficient_balance' then
        raise;
      end if;
      select balance into v_balance from public.wallets where user_id = v_user;
    end;
  end if;

  return v_order || jsonb_build_object('paid', false, 'balance', coalesce(v_balance, 0));
end;
$$;

revoke all on function public.pay_order_with_wallet(uuid) from public, anon;
revoke all on function public.checkout_cart() from public, anon;
grant execute on function public.pay_order_with_wallet(uuid) to authenticated;
grant execute on function public.checkout_cart() to authenticated;
