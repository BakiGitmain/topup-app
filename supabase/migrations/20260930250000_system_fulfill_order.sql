-- The write half of automatic fulfillment: records what a supplier's order-creation call (today: the mock adapter,
-- see _shared/fulfillment.ts) reports back, without a human in the loop. Deliberately the SAME shape as
-- admin_deliver_order (same status guard, same "one code per order" write) but WITHOUT is_admin() -- this is called
-- by the fulfill-order Edge Function using the service_role key, never by a real signed-in user of any kind,
-- exactly the same access pattern already used for begin_payment_verification/finish_payment_verification (revoke
-- from public/anon/authenticated, grant to service_role only -- no in-body role check needed or wanted).
--
-- Manual delivery (admin_deliver_order, the admin queue) is completely unchanged and stays the fallback: automatic
-- fulfillment either succeeds and calls this function, or it doesn't call it at all and the order sits exactly where
-- it already does today ('paid'/'pending'), waiting for admin_deliver_order same as before this existed.

create or replace function public.system_fulfill_order(
  p_order_id uuid,
  p_code     text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_code  text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status not in ('paid', 'pending', 'processing') then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if v_order.fulfillment = 'code' then
    v_code := btrim(coalesce(p_code, ''));
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

  return v_order;
end;
$$;

revoke all on function public.system_fulfill_order(uuid, text) from public, anon, authenticated;
grant execute on function public.system_fulfill_order(uuid, text) to service_role;
