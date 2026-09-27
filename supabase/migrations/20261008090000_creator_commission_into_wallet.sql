-- Reverses part of item 4's design (20261007090000_creator_commission.sql): commission now credits straight into
-- the creator's ORDINARY wallet balance (spendable, the same balance a purchase draws from), not a separate
-- withdraw-only balance. Display stays exactly where the wallet balance already shows -- the header pill next to
-- Portal Coin -- no separate creator screen needed. A creator's withdrawal is now an ordinary wallet withdrawal
-- again, same flow as any customer, no special tag.
--
-- WHY: simpler for both the creator (one balance, one place to see it, spendable immediately) and the codebase
-- (one ledger, not two) -- the separate withdraw-only balance from last round is removed, not just unused.
--
-- DATA CHECKED BEFORE WRITING THIS, NOT ASSUMED EMPTY: queried the live project directly before drafting this
-- migration -- creator_commission_balances holds 3 rows (one per profile, all created by last round's own
-- "every profile gets one" trigger), every one is 0; creator_commission_transactions is empty; no
-- withdrawal_requests row has source = 'creator_commission'. Nothing has actually been earned or withdrawn through
-- last round's mechanism yet. Even so, this migration does NOT assume that and migrates generically (see part 1
-- below), so it is correct wherever it runs, including a database this went differently on.
--
-- PART 1, MIGRATE BEFORE DROPPING (per the explicit instruction: never drop real data silently):
--   1a. Any commission still HELD by a pending creator-commission withdrawal request (money already deducted from
--       creator_commission_balances, waiting for an admin) is credited straight into the wallet, and the request is
--       closed out as declined with a note explaining why -- there is no longer a separate balance to pay it from.
--   1b. Any remaining nonzero creator_commission_balances.balance (commission earned but never withdrawn) is
--       credited into the wallet the same way.
--   An approved/paid commission withdrawal is left completely alone: that money already left the system for real
--   (the admin sent it by hand), so it must not be re-credited -- doing so would fabricate money. Only 'pending'
--   requests and nonzero balances are touched.
--
-- PART 2: _complete_order()'s commission branch now calls wallet_apply() (same signature it already uses for every
-- other wallet credit) instead of creator_commission_apply(), logged as an ordinary wallet_transactions row, new
-- kind 'commission', note "Commission -- code X, order Y". Same signature (uuid, text), same gating
-- (discount_code_id is not null, amount > 0) -- only which ledger it writes to changes.
--
-- PART 3: create_withdrawal_request / admin_resolve_withdrawal revert to their pre-item-4 bodies (the `source`
-- parameter/column and the decline-path branch are removed) -- withdrawing is, again, always against the wallet.
--
-- PART 4: the separate ledger (creator_commission_balances, creator_commission_transactions, their guard/append-
-- only triggers and functions, creator_commission_apply, and withdrawal_requests.source) is dropped, not just left
-- unused -- it served no purpose once nothing writes to it any more.

-------------------------------------------------------------------------------
-- Part 1: migrate any real data into the wallet BEFORE anything is dropped.
-------------------------------------------------------------------------------

-- 'commission' must be a valid kind before anything below can write one.
alter table public.wallet_transactions drop constraint if exists wallet_transactions_kind_check;
alter table public.wallet_transactions
  add constraint wallet_transactions_kind_check
  check (kind in ('deposit', 'purchase', 'refund', 'adjustment', 'withdrawal', 'portal_coin_redemption', 'commission'));

do $migrate$
declare
  v_row record;
begin
  -- 1a. A pending creator-commission withdrawal: the held amount goes into the wallet; the request is declined
  -- with a note, since there is no longer a separate balance to pay it from.
  for v_row in
    select * from public.withdrawal_requests where source = 'creator_commission' and status = 'pending'
  loop
    perform public.wallet_apply(
      v_row.user_id, v_row.amount, 'commission',
      'Commission balances were merged into the ordinary wallet: this held withdrawal amount was credited here automatically'
    );
    update public.withdrawal_requests
       set status = 'declined',
           admin_note = 'Commission balances were merged into the ordinary wallet; this amount was credited there automatically.',
           resolved_at = now()
     where id = v_row.id;
  end loop;

  -- 1b. Any remaining nonzero commission balance (earned, never withdrawn) moves into the wallet the same way.
  for v_row in
    select * from public.creator_commission_balances where balance <> 0
  loop
    perform public.wallet_apply(
      v_row.user_id, v_row.balance, 'commission',
      'Commission balance merged into your ordinary wallet'
    );
  end loop;
end;
$migrate$;

-------------------------------------------------------------------------------
-- Part 2: _complete_order -- same signature, same body, except the commission branch now credits the wallet.
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
  v_creator_id  uuid;
  v_code_text   text;
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

    -- REVERSED 2026-10-08 (was creator_commission_apply into a separate withdraw-only balance): the commission
    -- already computed at checkout is credited straight into the creator's ordinary, spendable wallet -- an
    -- everyday wallet_transactions row, same mechanism as any purchase/refund/adjustment. 0% commission codes are
    -- allowed and must not insert a zero-amount ledger row (wallet_apply itself already refuses one).
    if v_order.commission_amount > 0 then
      select creator_id, code into v_creator_id, v_code_text from public.discount_codes where id = v_order.discount_code_id;
      perform public.wallet_apply(
        v_creator_id, v_order.commission_amount, 'commission',
        'Commission -- code ' || v_code_text || ', order ' || left(v_order.id::text, 8),
        p_order => v_order.id
      );
    end if;
  elsif v_order.wheel_prize_won_id is not null then
    update public.wheel_prizes_won
       set redeemed_at = now(), applied_order_id = v_order.id
     where id = v_order.wheel_prize_won_id;
  end if;

  -- +1 Portal Coin for any completed order; a code-using order earns that code's OWN portal_coin_bonus instead
  -- (never additive on top of the +1 -- the whole amount, same as the old flat +2 was). A REUSED code (no discount,
  -- coin_bonus_code_id set instead of discount_code_id) still earns that same bonus, every time, until the code
  -- expires or goes inactive -- just with no code_redemptions row, since that was already logged on first use. A
  -- wheel-discounted order is NOT special-cased (see the wheel migration header, flag 5): it falls into the same
  -- flat +1 as any code-less order.
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
-- Part 3: create_withdrawal_request / admin_resolve_withdrawal revert to their pre-item-4 bodies.
-------------------------------------------------------------------------------

drop function if exists public.create_withdrawal_request(numeric, text, text, text);

create or replace function public.create_withdrawal_request(
  p_amount   numeric,
  p_provider text,
  p_account  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_amount  numeric(12, 2);
  v_account text;
  v_id      uuid;
  v_balance numeric(14, 2);
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount < 10 or v_amount > 1000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_provider is null or p_provider not in ('telebirr', 'cbe') then
    raise exception 'invalid_provider' using errcode = '22023';
  end if;
  v_account := public.normalize_payout_account(p_provider, p_account);
  if not ((p_provider = 'telebirr' and v_account ~ '^0[79][0-9]{8}$') or (p_provider = 'cbe' and v_account ~ '^[0-9]{13}$')) then
    raise exception 'invalid_account' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('withdraw:' || v_user::text, 0));
  if (select count(*) from public.withdrawal_requests where user_id = v_user and status = 'pending') >= 5 then
    raise exception 'too_many_pending' using errcode = 'P0001';
  end if;

  insert into public.withdrawal_requests (user_id, amount, payout_provider, payout_account)
  values (v_user, v_amount, p_provider, v_account)
  returning id into v_id;

  -- The atomic balance check + deduction. If the balance is too low this raises and the insert above is rolled back too.
  v_balance := public.wallet_apply(v_user, -v_amount, 'withdrawal',
                                   'Withdrawal to ' || case p_provider when 'telebirr' then 'Telebirr' else 'CBE' end,
                                   p_withdrawal => v_id);

  perform public.enqueue_admin_notification(
    'withdrawal_requested',
    format(E'Withdrawal request\nAmount: %s\nSEND TO: %s %s\nCustomer: %s\nRequest: %s\nThe amount is already held. Send it, then mark it paid in the app (Withdrawals).',
           public.birr_text(v_amount),
           case p_provider when 'telebirr' then 'Telebirr' else 'CBE' end, v_account,
           public.customer_label(v_user), left(v_id::text, 8))
  );

  return jsonb_build_object('withdrawal_id', v_id, 'amount', v_amount, 'balance', v_balance);
end;
$$;

revoke all on function public.create_withdrawal_request(numeric, text, text) from public, anon;
grant execute on function public.create_withdrawal_request(numeric, text, text) to authenticated;

create or replace function public.admin_resolve_withdrawal(
  p_id      uuid,
  p_approve boolean,
  p_note    text default null
)
returns public.withdrawal_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_w    public.withdrawal_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_approve is null then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;

  select * into v_w from public.withdrawal_requests where id = p_id for update;
  if not found then
    raise exception 'withdrawal_not_found' using errcode = 'P0002';
  end if;
  if v_w.status <> 'pending' then
    raise exception 'already_resolved' using errcode = 'P0001', detail = v_w.status;
  end if;

  if p_approve then
    update public.withdrawal_requests
       set status = 'paid', admin_note = v_note, resolved_by = auth.uid(), resolved_at = now()
     where id = p_id
    returning * into v_w;
  else
    if v_note is null then
      raise exception 'note_required' using errcode = '22023';
    end if;
    -- Exactly the held amount goes back, logged with the reason.
    perform public.wallet_apply(v_w.user_id, v_w.amount, 'refund', 'Withdrawal declined: ' || v_note,
                                p_withdrawal => v_w.id, p_by => auth.uid());
    update public.withdrawal_requests
       set status = 'declined', admin_note = v_note, resolved_by = auth.uid(), resolved_at = now()
     where id = p_id
    returning * into v_w;
  end if;

  return v_w;
end;
$$;

revoke all on function public.admin_resolve_withdrawal(uuid, boolean, text) from public, anon;
grant execute on function public.admin_resolve_withdrawal(uuid, boolean, text) to authenticated;

-------------------------------------------------------------------------------
-- Part 4: drop the now-unused source column and the separate ledger entirely.
-------------------------------------------------------------------------------

alter table public.withdrawal_requests drop column if exists source;

drop trigger if exists on_profile_created_creator_commission on public.profiles;
drop function if exists public.create_creator_commission_balance_for_profile();

-- Dropping the tables removes their own triggers (ledger guard, append-only) automatically; the trigger FUNCTIONS
-- are separate objects and are dropped explicitly afterward.
drop table if exists public.creator_commission_transactions;
drop table if exists public.creator_commission_balances;

drop function if exists public.check_creator_commission_matches_ledger();
drop function if exists public.creator_commission_ledger_append_only();
drop function if exists public.creator_commission_apply(uuid, numeric, text, text, uuid, uuid, uuid);
