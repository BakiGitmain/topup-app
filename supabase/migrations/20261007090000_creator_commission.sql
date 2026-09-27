-- Item 4 of the creator feature set: a creator's commission balance, withdraw-only, completely separate from their
-- normal shopping wallet (a creator is also a customer and keeps that wallet untouched -- see item 1's own framing).
--
-- LEDGER, SAME MECHANISM AS wallet_transactions/portal_coin_transactions, byte-for-byte: a guarded balance table
-- (creator_commission_balances), an append-only ledger (creator_commission_transactions), a deferred constraint
-- trigger that refuses any commit where a balance disagrees with its ledger sum, and one internal, all-roles-
-- revoked *_apply() function that does the check+change in a single atomic UPDATE. No new guard mechanism invented.
--
-- CREDITED WHERE ITEM 2/3 ALREADY DO -- inside _complete_order(), not at checkout. The commission_amount was
-- already computed and snapshotted onto the order at checkout time (item 2); this migration adds exactly one step,
-- right next to the existing code_redemptions insert (same discount_code_id is not null gate, so it only ever
-- fires for a genuine first-use of a code, never a reused one -- a reused code's commission_amount is always 0,
-- see 20261004090000/20261006090000): read the code's creator_id and credit that amount into their commission
-- balance. Skipped entirely when commission_amount is 0 (a code can have 0% commission -- discount_codes allows
-- it), since creator_commission_transactions, like every ledger in this project, forbids a zero-amount row.
--
-- WITHDRAW-ONLY, NO CROSSOVER: nothing here ever reads or writes creator_commission_balances from
-- pay_order_with_wallet, checkout_cart, or any purchase path -- those only ever touch `wallets`. The only ways this
-- balance moves are creator_commission_apply's two callers: _complete_order (credit) and
-- create_withdrawal_request/admin_resolve_withdrawal (withdraw / decline-refund, below).
--
-- WITHDRAWALS: reused wholesale, not forked. withdrawal_requests gains one column, `source` ('wallet' -- the
-- existing default, every historical row -- or 'creator_commission'), and create_withdrawal_request gains one new
-- optional parameter, p_source default 'wallet', so every existing caller is unaffected. Old signature dropped
-- first: CREATE OR REPLACE cannot add a parameter without changing the function's identity (the same rule this
-- project already hit and documented for create_cart_order/checkout_cart). admin_resolve_withdrawal's DECLINE path
-- -- previously hard-wired to wallet_apply, flagged as a known conflict back when item 4 was first scoped -- now
-- reads v_w.source and refunds into the matching balance/ledger; its APPROVE path is unchanged (no money moves
-- either way, the amount was already held). The Telegram message and the admin withdrawals screen both prefix
-- "[CREATOR COMMISSION]" so it's obvious at a glance which balance a request is against.
--
-- NOT A NEW ANTI-FLOOD RULE: the existing "at most 5 pending requests" cap in create_withdrawal_request stays
-- COMBINED across both sources (not 5 wallet + 5 commission) -- it exists to protect the admin's Telegram from being
-- flooded, a concern that doesn't care which balance a request is against.
--
-- A NON-CREATOR CANNOT WITHDRAW FROM THIS BALANCE, WITH NO EXTRA GUARD NEEDED: every profile gets a
-- creator_commission_balances row (same "every profile gets one" pattern as wallets/portal_coin_balances, so
-- becoming a creator later never hits a missing-row error), but it starts and stays at 0 unless a redeemed code
-- credits it -- creator_commission_apply's own balance check (`balance + amount >= 0`) already refuses any
-- withdrawal past that, the same way wallet_apply already refuses an overdraft.

-------------------------------------------------------------------------------
-- 1. creator_commission_balances + creator_commission_transactions
-------------------------------------------------------------------------------

create table if not exists public.creator_commission_balances (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  balance    numeric(14, 2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

drop trigger if exists creator_commission_balances_set_updated_at on public.creator_commission_balances;
create trigger creator_commission_balances_set_updated_at
  before update on public.creator_commission_balances
  for each row execute function public.set_updated_at();

-- amount is signed: positive = commission in (earned) or a decline refund, negative = a withdrawal being held.
create table if not exists public.creator_commission_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  kind          text not null check (kind in ('earn_commission', 'withdrawal', 'refund')),
  amount        numeric(14, 2) not null check (amount <> 0),
  balance_after numeric(14, 2) not null check (balance_after >= 0),
  order_id      uuid references public.orders (id) on delete set null,
  withdrawal_id uuid references public.withdrawal_requests (id) on delete set null,
  note          text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Shape rules, same spirit as wallet_transactions_links_check: a withdrawal/refund row must carry its request id;
-- an earn row never does (it is tied to an order instead). order_id is intentionally NOT required for an earn row
-- (same reasoning as portal_coin_transactions: an order can be deleted later, on delete set null, and a permanent
-- NOT NULL would make that FK action violate this check on old rows).
alter table public.creator_commission_transactions drop constraint if exists creator_commission_transactions_shape_check;
alter table public.creator_commission_transactions add constraint creator_commission_transactions_shape_check check (
  (kind = 'earn_commission' and amount > 0 and withdrawal_id is null)
  or (kind = 'withdrawal' and amount < 0 and withdrawal_id is not null)
  or (kind = 'refund' and amount > 0 and withdrawal_id is not null)
);

-- Exactly-once, same idiom as wallet_transactions: at most one earn row per order, one withdrawal-hold and one
-- refund per withdrawal request.
create unique index if not exists creator_commission_tx_one_earn_per_order
  on public.creator_commission_transactions (order_id) where kind = 'earn_commission';
create unique index if not exists creator_commission_tx_one_withdrawal_hold
  on public.creator_commission_transactions (withdrawal_id) where kind = 'withdrawal';
create unique index if not exists creator_commission_tx_one_withdrawal_refund
  on public.creator_commission_transactions (withdrawal_id) where kind = 'refund';

create index if not exists creator_commission_transactions_user_idx
  on public.creator_commission_transactions (user_id, created_at desc);

-- Every profile gets a row, same trigger event as create_wallet_for_profile / create_portal_coin_balance_for_profile.
create or replace function public.create_creator_commission_balance_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.creator_commission_balances (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_profile_created_creator_commission on public.profiles;
create trigger on_profile_created_creator_commission
  after insert on public.profiles
  for each row execute function public.create_creator_commission_balance_for_profile();

-- Accounts that existed before this migration.
insert into public.creator_commission_balances (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

-------------------------------------------------------------------------------
-- 2. THE GUARD: balance == sum of the ledger, checked at commit. Byte-for-byte the wallet/Portal Coin mechanism.
-------------------------------------------------------------------------------

create or replace function public.check_creator_commission_matches_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum numeric(14, 2);
  v_bal numeric(14, 2);
begin
  select balance into v_bal from public.creator_commission_balances where user_id = new.user_id;
  select coalesce(sum(amount), 0) into v_sum from public.creator_commission_transactions where user_id = new.user_id;
  if v_bal is distinct from v_sum then
    raise exception 'creator_commission_ledger_mismatch' using errcode = 'P0001',
      detail = format('balance %s but the ledger adds up to %s', v_bal, v_sum);
  end if;
  return null;
end;
$$;

drop trigger if exists creator_commission_balances_match_ledger on public.creator_commission_balances;
create constraint trigger creator_commission_balances_match_ledger
  after insert or update of balance on public.creator_commission_balances
  deferrable initially deferred
  for each row execute function public.check_creator_commission_matches_ledger();

drop trigger if exists creator_commission_transactions_match_balance on public.creator_commission_transactions;
create constraint trigger creator_commission_transactions_match_balance
  after insert on public.creator_commission_transactions
  deferrable initially deferred
  for each row execute function public.check_creator_commission_matches_ledger();

-------------------------------------------------------------------------------
-- 3. the ledger is append-only
-------------------------------------------------------------------------------

create or replace function public.creator_commission_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'creator_commission_ledger_is_append_only' using errcode = 'P0001';
end;
$$;

drop trigger if exists creator_commission_transactions_append_only on public.creator_commission_transactions;
create trigger creator_commission_transactions_append_only
  before update or delete on public.creator_commission_transactions
  for each row execute function public.creator_commission_ledger_append_only();

-------------------------------------------------------------------------------
-- 4. creator_commission_apply: the internal way to move commission, same one-statement atomic pattern as
--    wallet_apply/portal_coin_apply. No p_deposit -- this balance is never funded by a deposit.
-------------------------------------------------------------------------------

create or replace function public.creator_commission_apply(
  p_user       uuid,
  p_amount     numeric,
  p_kind       text,
  p_note       text,
  p_order      uuid default null,
  p_withdrawal uuid default null,
  p_by         uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(14, 2) := round(coalesce(p_amount, 0), 2);
  v_new    numeric(14, 2);
begin
  if v_amount = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  update public.creator_commission_balances
     set balance = balance + v_amount
   where user_id = p_user and balance + v_amount >= 0
  returning balance into v_new;

  if v_new is null then
    if not exists (select 1 from public.creator_commission_balances where user_id = p_user) then
      raise exception 'creator_commission_balance_missing' using errcode = 'P0002';
    end if;
    raise exception 'insufficient_creator_commission_balance' using errcode = 'P0001';
  end if;

  insert into public.creator_commission_transactions
    (user_id, kind, amount, balance_after, order_id, withdrawal_id, note, created_by)
  values
    (p_user, p_kind, v_amount, v_new, p_order, p_withdrawal, p_note, p_by);

  return v_new;
end;
$$;

revoke all on function public.creator_commission_apply(uuid, numeric, text, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 5. RLS: a creator (or anyone, since every profile has a row) reads only their own balance and ledger, same shape
--    as wallets/wallet_transactions and portal_coin_balances/portal_coin_transactions.
-------------------------------------------------------------------------------

alter table public.creator_commission_balances enable row level security;
alter table public.creator_commission_transactions enable row level security;

drop policy if exists creator_commission_balances_select on public.creator_commission_balances;
create policy creator_commission_balances_select on public.creator_commission_balances
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists creator_commission_transactions_select on public.creator_commission_transactions;
create policy creator_commission_transactions_select on public.creator_commission_transactions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.creator_commission_balances, public.creator_commission_transactions from anon, authenticated;
grant select on public.creator_commission_balances, public.creator_commission_transactions to authenticated;

-------------------------------------------------------------------------------
-- 6. withdrawal_requests gains `source`, so ONE request table still serves both balances, distinguishably.
-------------------------------------------------------------------------------

alter table public.withdrawal_requests
  add column if not exists source text not null default 'wallet' check (source in ('wallet', 'creator_commission'));

-------------------------------------------------------------------------------
-- 7. create_withdrawal_request: same body, plus the new p_source param and the branch on which balance it deducts
--    from. Old 3-arg signature dropped first (CREATE OR REPLACE cannot add a parameter to an existing identity).
-------------------------------------------------------------------------------

drop function if exists public.create_withdrawal_request(numeric, text, text);

create or replace function public.create_withdrawal_request(
  p_amount   numeric,
  p_provider text,
  p_account  text,
  p_source   text default 'wallet'
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
  v_source  text := coalesce(p_source, 'wallet');
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
  if v_source not in ('wallet', 'creator_commission') then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
  v_account := public.normalize_payout_account(p_provider, p_account);
  if not ((p_provider = 'telebirr' and v_account ~ '^0[79][0-9]{8}$') or (p_provider = 'cbe' and v_account ~ '^[0-9]{13}$')) then
    raise exception 'invalid_account' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('withdraw:' || v_user::text, 0));
  -- Combined across both sources on purpose -- see the migration header: this cap exists to protect the admin's
  -- Telegram from being flooded, not to ration either balance separately.
  if (select count(*) from public.withdrawal_requests where user_id = v_user and status = 'pending') >= 5 then
    raise exception 'too_many_pending' using errcode = 'P0001';
  end if;

  insert into public.withdrawal_requests (user_id, amount, payout_provider, payout_account, source)
  values (v_user, v_amount, p_provider, v_account, v_source)
  returning id into v_id;

  -- The atomic balance check + deduction, from whichever balance this request is against. If the balance is too
  -- low this raises and the insert above is rolled back too.
  if v_source = 'creator_commission' then
    v_balance := public.creator_commission_apply(v_user, -v_amount, 'withdrawal',
                                                  'Withdrawal to ' || case p_provider when 'telebirr' then 'Telebirr' else 'CBE' end,
                                                  p_withdrawal => v_id);
  else
    v_balance := public.wallet_apply(v_user, -v_amount, 'withdrawal',
                                     'Withdrawal to ' || case p_provider when 'telebirr' then 'Telebirr' else 'CBE' end,
                                     p_withdrawal => v_id);
  end if;

  perform public.enqueue_admin_notification(
    'withdrawal_requested',
    format(E'%sWithdrawal request\nAmount: %s\nSEND TO: %s %s\nCustomer: %s\nRequest: %s\nThe amount is already held. Send it, then mark it paid in the app (Withdrawals).',
           case when v_source = 'creator_commission' then '[CREATOR COMMISSION] ' else '' end,
           public.birr_text(v_amount),
           case p_provider when 'telebirr' then 'Telebirr' else 'CBE' end, v_account,
           public.customer_label(v_user), left(v_id::text, 8))
  );

  return jsonb_build_object('withdrawal_id', v_id, 'amount', v_amount, 'balance', v_balance, 'source', v_source);
end;
$$;

revoke all on function public.create_withdrawal_request(numeric, text, text, text) from public, anon;
grant execute on function public.create_withdrawal_request(numeric, text, text, text) to authenticated;

-------------------------------------------------------------------------------
-- 8. admin_resolve_withdrawal: same signature (no drop needed), the decline branch now reads v_w.source to refund
--    the correct balance instead of always wallet_apply.
-------------------------------------------------------------------------------

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
    -- Exactly the held amount goes back, into the SAME balance it was held from (see `source`, added this
    -- migration): a wallet withdrawal refunds via wallet_apply, a creator-commission one via
    -- creator_commission_apply -- never the wrong one.
    if v_w.source = 'creator_commission' then
      perform public.creator_commission_apply(v_w.user_id, v_w.amount, 'refund', 'Withdrawal declined: ' || v_note,
                                                p_withdrawal => v_w.id, p_by => auth.uid());
    else
      perform public.wallet_apply(v_w.user_id, v_w.amount, 'refund', 'Withdrawal declined: ' || v_note,
                                  p_withdrawal => v_w.id, p_by => auth.uid());
    end if;
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
-- 9. _complete_order: same signature (uuid, text), same body, plus one new step right next to the existing
--    code_redemptions insert -- credit the code's creator with the commission already snapshotted on the order,
--    skipped when it's 0 (a 0%-commission code is allowed and must never insert a zero-amount ledger row).
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

    -- Item 4: credit the code's creator with the commission already computed at checkout. 0% commission codes are
    -- allowed (discount_codes.commission_percent can be 0) and must not insert a zero-amount ledger row.
    if v_order.commission_amount > 0 then
      select creator_id into v_creator_id from public.discount_codes where id = v_order.discount_code_id;
      perform public.creator_commission_apply(
        v_creator_id, v_order.commission_amount, 'earn_commission',
        'Commission from order ' || left(v_order.id::text, 8), v_order.id
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
