-- topup: order processing, the code vault, game IDs, language, admin delivery.
-- Run AFTER 20260920120000_roles_wallet_catalog.sql. Safe to re-run.
--
--   * Orders get a "processing" step: pending -> processing -> completed.
--   * Diamonds/UC-style products ("topup") need the customer's game ID at
--     purchase; the server checks it. Gift cards, game keys and subscriptions
--     ("code") are delivered as a code the admin pastes in, which lands in the
--     customer's vault. Diamonds/UC never create a vault row.
--   * Vault rows can be marked used/unused by their owner and never deleted.

------------------------------------------------------------------------------
-- 1. product categories
------------------------------------------------------------------------------

alter table public.products drop constraint if exists products_category_check;
alter table public.products
  add constraint products_category_check
  check (category in ('games', 'gift-cards', 'game-keys', 'subscriptions', 'airtime'));

------------------------------------------------------------------------------
-- 2. orders: processing status + how the order is fulfilled
------------------------------------------------------------------------------

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('pending', 'processing', 'completed', 'failed', 'refunded'));

-- 'topup'  = admin sends it to the customer's game ID (needs delivery.account_id)
-- 'code'   = admin pastes a redeemable code, delivered through the vault
alter table public.orders add column if not exists fulfillment text not null default 'topup';
alter table public.orders drop constraint if exists orders_fulfillment_check;
alter table public.orders
  add constraint orders_fulfillment_check check (fulfillment in ('topup', 'code'));

alter table public.orders add column if not exists completed_at timestamptz;

------------------------------------------------------------------------------
-- 3. language preference (customers may change it themselves)
------------------------------------------------------------------------------

alter table public.profiles add column if not exists language text not null default 'en';
alter table public.profiles drop constraint if exists profiles_language_check;
alter table public.profiles
  add constraint profiles_language_check check (language in ('en', 'am'));

grant update (display_name, avatar_url, language) on public.profiles to authenticated;

------------------------------------------------------------------------------
-- 4. vault
------------------------------------------------------------------------------

create table if not exists public.vault_codes (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null unique references public.orders (id) on delete restrict,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  code       text not null check (length(btrim(code)) > 0),
  is_used    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vault_codes_user_idx
  on public.vault_codes (user_id, created_at desc);

drop trigger if exists vault_codes_set_updated_at on public.vault_codes;
create trigger vault_codes_set_updated_at
  before update on public.vault_codes
  for each row execute function public.set_updated_at();

alter table public.vault_codes enable row level security;

drop policy if exists vault_codes_select on public.vault_codes;
create policy vault_codes_select on public.vault_codes
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Owners may flip is_used and nothing else (column privilege below).
drop policy if exists vault_codes_update_own on public.vault_codes;
create policy vault_codes_update_own on public.vault_codes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.vault_codes from anon, authenticated;
grant select on public.vault_codes to authenticated;
grant update (is_used) on public.vault_codes to authenticated;

------------------------------------------------------------------------------
-- 5. purchase: now validates the game ID and records how to fulfil the order
------------------------------------------------------------------------------

create or replace function public.purchase_product_option(
  p_option_id uuid,
  p_delivery  jsonb default '{}'::jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user        uuid := auth.uid();
  v_opt         record;
  v_fulfillment text;
  v_account     text;
  v_delivery    jsonb := '{}'::jsonb;
  v_balance     numeric(14, 2);
  v_new_balance numeric(14, 2);
  v_order       public.orders;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select o.id, o.label, o.price, p.name, p.category
    into v_opt
    from public.product_options o
    join public.products p on p.id = o.product_id
   where o.id = p_option_id and o.is_active and p.is_active;

  if not found then
    raise exception 'option_unavailable' using errcode = 'P0002';
  end if;

  v_fulfillment := case when v_opt.category in ('games', 'airtime') then 'topup' else 'code' end;

  if v_fulfillment = 'topup' then
    v_account := btrim(coalesce(p_delivery ->> 'account_id', ''));
    if v_account = '' then
      raise exception 'account_id_required' using errcode = '22023';
    end if;
    if length(v_account) > 64 then
      raise exception 'account_id_invalid' using errcode = '22023';
    end if;
    -- Only the fields we know about are stored, whatever the client sent.
    v_delivery := jsonb_build_object('account_id', v_account);
  end if;

  -- Row lock: two purchases at once can't both spend the same money.
  select balance into v_balance
    from public.wallets
   where user_id = v_user
     for update;

  if not found then
    raise exception 'wallet_missing' using errcode = 'P0002';
  end if;

  if v_balance < v_opt.price then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  v_new_balance := v_balance - v_opt.price;
  update public.wallets set balance = v_new_balance where user_id = v_user;

  insert into public.orders (user_id, option_id, product_name, option_label, amount, delivery, fulfillment)
  values (v_user, v_opt.id, v_opt.name, v_opt.label, v_opt.price, v_delivery, v_fulfillment)
  returning * into v_order;

  insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note)
  values (v_user, 'purchase', -v_opt.price, v_new_balance, v_order.id, v_opt.name || ' - ' || v_opt.label);

  return v_order;
end;
$$;

------------------------------------------------------------------------------
-- 6. admin: move an order along, deliver it, refund it
------------------------------------------------------------------------------

-- pending    -> processing
-- pending / processing -> failed   (refunds)
-- completed  -> refunded           (refunds; game top-ups only)
-- "completed" itself goes through admin_deliver_order.
create or replace function public.admin_set_order_status(
  p_order_id uuid,
  p_status   text
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders;
  v_balance numeric(14, 2);
  v_new     numeric(14, 2);
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_status not in ('processing', 'failed', 'refunded') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- The customer already holds the code, so the money can't come back.
  if p_status = 'refunded' and v_order.status = 'completed' and v_order.fulfillment = 'code' then
    raise exception 'code_already_delivered' using errcode = 'P0001';
  end if;

  if not (
    (v_order.status = 'pending'    and p_status in ('processing', 'failed')) or
    (v_order.status = 'processing' and p_status = 'failed') or
    (v_order.status = 'completed'  and p_status = 'refunded')
  ) then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if p_status in ('failed', 'refunded') then
    select balance into v_balance
      from public.wallets where user_id = v_order.user_id for update;

    v_new := v_balance + v_order.amount;
    update public.wallets set balance = v_new where user_id = v_order.user_id;

    insert into public.wallet_transactions (user_id, kind, amount, balance_after, order_id, note, created_by)
    values (
      v_order.user_id, 'refund', v_order.amount, v_new, v_order.id,
      'Refund: ' || v_order.product_name || ' - ' || v_order.option_label,
      auth.uid()
    );
  end if;

  update public.orders set status = p_status where id = p_order_id
  returning * into v_order;

  return v_order;
end;
$$;

-- Mark an order delivered. Code orders need the code, which goes to the
-- customer's vault in the same transaction. Game top-ups need no code.
create or replace function public.admin_deliver_order(
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
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_order.status not in ('pending', 'processing') then
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

revoke all on function public.purchase_product_option(uuid, jsonb) from public, anon;
revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
revoke all on function public.admin_deliver_order(uuid, text) from public, anon;

grant execute on function public.purchase_product_option(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;
grant execute on function public.admin_deliver_order(uuid, text) to authenticated;
