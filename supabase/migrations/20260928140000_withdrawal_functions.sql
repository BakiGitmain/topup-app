-- topup: wallet. Part 6 of 7: withdrawals (request-and-notify; YOU send the money by hand).
-- Run AFTER 20260928130000_deposit_functions.sql. Safe to re-run.
--
-- THE FLOW:
--   customer: create_withdrawal_request(amount, provider, account)
--               ONE transaction: check the balance AND deduct it (a single UPDATE ... WHERE balance >= amount, via
--               wallet_apply), write the 'withdrawal' ledger row, create the pending request, queue the Telegram message.
--               The money is held from that moment. If the balance isn't enough, nothing at all is written.
--   admin:    admin_resolve_withdrawal(id, approve, note)
--               approve -> the request becomes 'paid' (you already sent the money outside the app). No balance change:
--                          it was deducted when the request was made.
--               decline -> the EXACT held amount goes back to the balance as a 'refund' ledger row carrying your note,
--                          and the request becomes 'declined'. A decline needs a note (the customer sees it).
--
-- RACES: two requests at once on the same balance cannot both succeed: the deduct is one statement that re-checks the
-- balance after waiting for the other request's lock. A resolve tapped twice can't refund twice (row lock + status check,
-- and a unique index allows only one refund row per request).
--
-- GUARDS: at most 5 pending requests per customer (so a bug or a bad actor can't flood your Telegram).

-- Puts a payout account into its canonical form: Telebirr "+251 911 22 33 44" / "911223344" / "0911-22-33-44" -> "0911223344";
-- CBE: spaces and dashes removed. It does not judge validity; the table's CHECK does.
create or replace function public.normalize_payout_account(p_provider text, p_account text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := regexp_replace(coalesce(p_account, ''), '[[:space:]-]', '', 'g');
begin
  if p_provider = 'telebirr' then
    if v ~ '^\+?251[79][0-9]{8}$' then
      v := '0' || regexp_replace(v, '^\+?251', '');
    elsif v ~ '^[79][0-9]{8}$' then
      v := '0' || v;
    end if;
  end if;
  return v;
end;
$$;

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

revoke all on function public.create_withdrawal_request(numeric, text, text) from public, anon;
revoke all on function public.admin_resolve_withdrawal(uuid, boolean, text) from public, anon;
grant execute on function public.create_withdrawal_request(numeric, text, text) to authenticated;
grant execute on function public.admin_resolve_withdrawal(uuid, boolean, text) to authenticated;
