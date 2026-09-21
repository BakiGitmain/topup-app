-- topup: the dollar-to-birr exchange rate, editable by an admin instead of written into the code. Safe to re-run.
--
-- ONE row (the table can't hold two), starting at 175. The import screen reads it to pre-fill each pack's price as
-- cost x rate, and an admin changes it here as the rate drifts. Only admins can read or change it: customers never need it and
-- it is part of the shop's margin. There is no insert or delete grant, so the row can't be removed or duplicated.

create table if not exists public.pricing_settings (
  id          boolean primary key default true check (id),
  usd_to_birr numeric(10, 4) not null default 175 check (usd_to_birr > 0 and usd_to_birr <= 100000),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);

insert into public.pricing_settings (id) values (true) on conflict (id) do nothing;

create or replace function public.pricing_settings_stamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists pricing_settings_stamp on public.pricing_settings;
create trigger pricing_settings_stamp
  before update on public.pricing_settings
  for each row execute function public.pricing_settings_stamp();

alter table public.pricing_settings enable row level security;
drop policy if exists pricing_settings_admin_read on public.pricing_settings;
create policy pricing_settings_admin_read on public.pricing_settings
  for select to authenticated using ((select public.is_admin()));
drop policy if exists pricing_settings_admin_update on public.pricing_settings;
create policy pricing_settings_admin_update on public.pricing_settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.pricing_settings from anon, authenticated;
grant select, update on public.pricing_settings to authenticated;
