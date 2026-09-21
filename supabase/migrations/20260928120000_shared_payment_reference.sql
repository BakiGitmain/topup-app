-- topup: wallet. Part 4 of 7: one transfer can be used ONCE, across orders AND deposits.
-- Run AFTER 20260928110000_wallet_ledger_guard.sql. Safe to re-run.
--
-- THE PROBLEM: orders and deposit_requests each have their own UNIQUE (payment_provider, payment_reference). That stops one
-- transfer paying two orders, or crediting two deposits. It does NOT stop one transfer paying an order AND crediting a
-- deposit, because they are different tables. Same money, spent twice.
--
-- THE FIX: both "claim" functions (begin_payment_verification for orders, begin_deposit_verification for deposits) now
--   1. take an advisory lock named after the transfer (so two requests for the SAME reference queue up, whichever table
--      they are for, and the second one sees the first one's claim once it commits),
--   2. free a stale claim (a check that died more than 90 s ago), then
--   3. refuse if the reference is held by anything else, in either table.
-- The lock is taken FIRST, before any row lock, in both functions, so they can't deadlock each other.
--
-- Only begin_payment_verification is replaced (create or replace, same signature, same answers); its tests still pass.
-- The per-table UNIQUE constraints stay as the last line of defence.

create or replace function public.lock_payment_reference(p_provider text, p_reference text)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended(p_provider || ':' || p_reference, 0));
$$;

-- Frees a claim that belongs to a check that died (over 90 s old and never finished), in either table, so a customer
-- whose app crashed mid-check isn't locked out of their own transfer.
create or replace function public.release_stale_reference_claims(
  p_provider text, p_reference text, p_except_order uuid, p_except_deposit uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
     set payment_provider = null, payment_reference = null, verifying_since = null
   where status = 'pending_payment' and payment_provider = p_provider and payment_reference = p_reference
     and id is distinct from p_except_order
     and (verifying_since is null or verifying_since < now() - interval '90 seconds');

  update public.deposit_requests
     set status = 'pending_reference', payment_provider = null, payment_reference = null, verifying_since = null
   where status = 'pending_verification' and payment_provider = p_provider and payment_reference = p_reference
     and id is distinct from p_except_deposit
     and (verifying_since is null or verifying_since < now() - interval '90 seconds');
end;
$$;

-- True if this transfer already belongs to some other order or deposit (paid, mismatched, or being checked).
create or replace function public.payment_reference_taken(
  p_provider text, p_reference text, p_except_order uuid, p_except_deposit uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.orders
            where payment_provider = p_provider and payment_reference = p_reference and id is distinct from p_except_order)
      or exists (
           select 1 from public.deposit_requests
            where payment_provider = p_provider and payment_reference = p_reference and id is distinct from p_except_deposit);
$$;

revoke all on function public.lock_payment_reference(text, text) from public, anon, authenticated, service_role;
revoke all on function public.release_stale_reference_claims(text, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.payment_reference_taken(text, text, uuid, uuid) from public, anon, authenticated, service_role;

-- begin_payment_verification (orders): same contract as before, plus the shared guard.
create or replace function public.begin_payment_verification(
  p_order     uuid,
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
  v_o    record;
  v_name text;
begin
  perform public.lock_payment_reference(p_provider, p_reference);

  select id, user_id, status, amount, verifying_since into v_o
    from public.orders where id = p_order for update;

  if not found or v_o.user_id <> p_user then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_o.status <> 'pending_payment' then
    return jsonb_build_object('result', 'closed', 'status', v_o.status);
  end if;

  if v_o.verifying_since is not null and v_o.verifying_since > now() - interval '90 seconds' then
    return jsonb_build_object('result', 'in_progress');
  end if;

  perform public.release_stale_reference_claims(p_provider, p_reference, p_order, null);
  if public.payment_reference_taken(p_provider, p_reference, p_order, null) then
    return jsonb_build_object('result', 'reference_used');
  end if;

  select account_name into v_name from public.payment_accounts where provider = p_provider;

  begin
    update public.orders
       set payment_provider = p_provider, payment_reference = p_reference,
           verifying_since = now(), payment_attempts = payment_attempts + 1
     where id = p_order;
  exception when unique_violation then
    return jsonb_build_object('result', 'reference_used');
  end;

  return jsonb_build_object('result', 'go', 'amount', v_o.amount, 'provider', p_provider,
                            'reference', p_reference, 'account_name', v_name);
end;
$$;

revoke all on function public.begin_payment_verification(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_payment_verification(uuid, uuid, text, text) to service_role;
