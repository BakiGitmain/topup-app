-- topup: wallet. Part 5 of 7: deposits.
-- Run AFTER 20260928120000_shared_payment_reference.sql. Safe to re-run.
--
-- THE FLOW (same shape as paying an order):
--   customer:   create_deposit_request(amount)   -> a request + the Telebirr/CBE account details (from payment_accounts)
--               ... sends the money, then the app calls the verify-deposit Edge Function with the reference ...
--   service:    begin_deposit_verification(...)  -> locks the request, claims the reference (refuses one already used)
--               (verify-deposit asks ShegerPay, with the request's OWN amount, using the same code as verify-payment)
--   service:    finish_deposit_verification(...) -> paid: credits the balance + writes the ledger row, in ONE transaction
--                                                   mismatch: nothing credited, needs a person
--                                                   not verified / unavailable: reference freed, the customer retries
--
-- GUARANTEES (each has a test):
--   * The credit happens only if ShegerPay's verified amount EQUALS the requested amount. No partial credit, ever: the
--     database refuses it, and deposit_requests has a CHECK for it too.
--   * Credited at most once per request (row lock + status check + a unique index on the ledger).
--   * The same request + reference twice is answered from the record, without a second credit.
--   * A transfer already used by another deposit OR by an order is refused (shared guard, previous migration).
--   * Each notification is written in the same transaction as the thing it reports.

------------------------------------------------------------------------------
-- 1. create / cancel (the customer)
------------------------------------------------------------------------------

-- Returns {"deposit_id","amount","accounts":[{"provider","account_name","account_number"}]}.
-- If the customer already has an open deposit it raises deposit_open with that id (detail), so the app resumes it.
create or replace function public.create_deposit_request(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_amount   numeric(12, 2);
  v_open     uuid;
  v_id       uuid;
  v_accounts jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_amount := round(coalesce(p_amount, 0), 2);
  if v_amount < 10 or v_amount > 100000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('deposit:' || v_user::text, 0));

  select id into v_open from public.deposit_requests
   where user_id = v_user and status in ('pending_reference', 'pending_verification');
  if found then
    raise exception 'deposit_open' using errcode = 'P0001', detail = v_open::text;
  end if;

  insert into public.deposit_requests (user_id, amount) values (v_user, v_amount) returning id into v_id;

  perform public.enqueue_admin_notification(
    'deposit_requested',
    format(E'New deposit request\nAmount: %s\nCustomer: %s\nRequest: %s',
           public.birr_text(v_amount), public.customer_label(v_user), left(v_id::text, 8))
  );

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', provider, 'account_name', account_name, 'account_number', account_number)
         order by provider), '[]'::jsonb)
    into v_accounts from public.payment_accounts where is_active;

  return jsonb_build_object('deposit_id', v_id, 'amount', v_amount, 'accounts', v_accounts);
end;
$$;

-- The customer changes their mind (or wants a different amount). Only before a check has started.
create or replace function public.cancel_deposit_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_d    record;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select id, status, verifying_since into v_d from public.deposit_requests where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'deposit_not_found' using errcode = 'P0002';
  end if;
  if v_d.status <> 'pending_reference'
     or (v_d.verifying_since is not null and v_d.verifying_since > now() - interval '90 seconds') then
    raise exception 'deposit_not_cancellable' using errcode = 'P0001', detail = v_d.status;
  end if;
  update public.deposit_requests set status = 'failed' where id = p_id;
end;
$$;

revoke all on function public.create_deposit_request(numeric) from public, anon;
revoke all on function public.cancel_deposit_request(uuid) from public, anon;
grant execute on function public.create_deposit_request(numeric) to authenticated;
grant execute on function public.cancel_deposit_request(uuid) to authenticated;

------------------------------------------------------------------------------
-- 2. verification: begin (claim) ... finish (record and credit). Service role only.
------------------------------------------------------------------------------

-- Answers, like begin_payment_verification:
--   not_found | closed{status} | in_progress | reference_used | go{amount, provider, reference, account_name}
create or replace function public.begin_deposit_verification(
  p_deposit   uuid,
  p_user      uuid,
  p_provider  text,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d    record;
  v_name text;
begin
  perform public.lock_payment_reference(p_provider, p_reference);

  select id, user_id, status, amount, verifying_since into v_d
    from public.deposit_requests where id = p_deposit for update;

  if not found or v_d.user_id <> p_user then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_d.status not in ('pending_reference', 'pending_verification') then
    return jsonb_build_object('result', 'closed', 'status', v_d.status);
  end if;

  if v_d.status = 'pending_verification' and v_d.verifying_since is not null
     and v_d.verifying_since > now() - interval '90 seconds' then
    return jsonb_build_object('result', 'in_progress');
  end if;

  perform public.release_stale_reference_claims(p_provider, p_reference, null, p_deposit);
  if public.payment_reference_taken(p_provider, p_reference, null, p_deposit) then
    return jsonb_build_object('result', 'reference_used');
  end if;

  select account_name into v_name from public.payment_accounts where provider = p_provider;

  begin
    update public.deposit_requests
       set status = 'pending_verification', payment_provider = p_provider, payment_reference = p_reference,
           verifying_since = now(), payment_attempts = payment_attempts + 1
     where id = p_deposit;
  exception when unique_violation then
    return jsonb_build_object('result', 'reference_used');
  end;

  return jsonb_build_object('result', 'go', 'amount', v_d.amount, 'provider', p_provider,
                            'reference', p_reference, 'account_name', v_name);
end;
$$;

-- p_outcome: paid | mismatch | not_verified | unavailable. On 'paid' the amount must equal the requested amount exactly,
-- and the credit + ledger row + notification all happen in this one transaction.
create or replace function public.finish_deposit_verification(
  p_deposit  uuid,
  p_outcome  text,
  p_amount   numeric,
  p_mode     text,
  p_http     integer,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d    record;
  v_bal  numeric(14, 2);
  v_tag  text;
begin
  if p_outcome not in ('paid', 'mismatch', 'not_verified', 'unavailable') then
    raise exception 'bad_outcome' using errcode = '22023';
  end if;

  select id, user_id, status, amount, payment_provider, payment_reference into v_d
    from public.deposit_requests where id = p_deposit for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- Already settled (or the claim was lost): answer from the record. This is what makes a repeat call harmless.
  if v_d.status <> 'pending_verification' then
    return jsonb_build_object('result', 'closed', 'status', v_d.status);
  end if;
  if v_d.payment_reference is null then
    raise exception 'no_claimed_reference' using errcode = 'P0001';
  end if;

  insert into public.payment_attempts (deposit_id, provider, reference, outcome, verified_amount, mode, http_status, response)
  values (p_deposit, v_d.payment_provider, v_d.payment_reference, p_outcome, p_amount, p_mode, p_http, p_response);

  v_tag := case when p_mode = 'test' then ' [TEST KEY]' else '' end;

  if p_outcome = 'paid' then
    -- NO PARTIAL CREDIT: anything but the exact requested amount is refused here, and rolls everything back.
    if p_amount is distinct from v_d.amount then
      raise exception 'paid_amount_must_equal_requested' using errcode = 'P0001';
    end if;

    v_bal := public.wallet_apply(
      v_d.user_id, v_d.amount, 'deposit',
      'Deposit via ' || case v_d.payment_provider when 'telebirr' then 'Telebirr' else 'CBE' end || v_tag,
      p_deposit => p_deposit
    );
    update public.deposit_requests
       set status = 'paid', paid_at = now(), payment_verified_amount = p_amount,
           payment_mode = coalesce(p_mode, 'live'), verifying_since = null
     where id = p_deposit;

    perform public.enqueue_admin_notification(
      'deposit_paid',
      format(E'Deposit received%s\nAmount: %s via %s\nCustomer: %s\nNew balance: %s\nRef: %s',
             v_tag, public.birr_text(v_d.amount),
             case v_d.payment_provider when 'telebirr' then 'Telebirr' else 'CBE' end,
             public.customer_label(v_d.user_id), public.birr_text(v_bal), v_d.payment_reference)
    );
    return jsonb_build_object('result', 'paid', 'balance', v_bal);

  elsif p_outcome = 'mismatch' then
    -- Nothing is credited. The reference stays claimed so this transfer can't be reused for something else.
    update public.deposit_requests
       set status = 'mismatch', payment_verified_amount = p_amount,
           payment_mode = coalesce(p_mode, 'live'), verifying_since = null
     where id = p_deposit;

    perform public.enqueue_admin_notification(
      'deposit_mismatch',
      format(E'Deposit needs review%s\nA transfer was found but not for the requested amount. NOTHING was credited.\nRequested: %s\nCustomer: %s\nRef: %s',
             v_tag, public.birr_text(v_d.amount), public.customer_label(v_d.user_id), v_d.payment_reference)
    );
    return jsonb_build_object('result', 'mismatch');

  else
    -- Not confirmed (wrong reference, or ShegerPay unreachable): free the reference so the customer can try again.
    update public.deposit_requests
       set status = 'pending_reference', payment_provider = null, payment_reference = null, verifying_since = null
     where id = p_deposit;
    return jsonb_build_object('result', p_outcome);
  end if;
end;
$$;

revoke all on function public.begin_deposit_verification(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finish_deposit_verification(uuid, text, numeric, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.begin_deposit_verification(uuid, uuid, text, text) to service_role;
grant execute on function public.finish_deposit_verification(uuid, text, numeric, text, integer, jsonb) to service_role;
