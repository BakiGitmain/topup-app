-- topup: "how to pay" tutorial images per payment method. Safe to re-run. ADDS one table, one storage bucket and one function;
-- nothing that exists is changed.
--
-- WHAT IT IS: an admin uploads one or more screenshots per provider (Telebirr, CBE), puts them in order and removes the ones
-- that are out of date. The customer's pay and deposit screens show the chosen provider's images as a swipeable carousel
-- above the account details, and show nothing at all when there are none.
--
-- ALONGSIDE payment_accounts (inspected, not modified): that table holds ONE row per provider (name + number, admin-write,
-- signed-in read). Tutorials are MANY rows per provider, so they get their own table with the same access rules.
--
--   * payment_tutorial_images: id, provider, image_url, storage_path (so the file can be tidied up), sort_order.
--     Signed-in users can READ; only admins can write (same policy shape as payment_accounts).
--   * bucket `payment-tutorials`: public read (the app shows the image by URL), admin-only write, same as `product-art`.
--   * admin_save_payment_tutorials(provider, items): the BATCHED SAVE (like admin_apply_active_changes for on/off): the admin's
--     edits (uploads, reorder, removals) are staged on the screen and sent together. ALL OR NOTHING: the provider's whole list
--     becomes exactly `items`, in that order, or nothing changes. It returns the storage paths of removed images so the app
--     can delete the files. At most 10 images per provider.

create table if not exists public.payment_tutorial_images (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('telebirr', 'cbe')),
  image_url    text not null check (image_url ~ '^https://' and length(image_url) <= 1000),
  -- Where the file lives in the bucket, so removing the image can remove the file. Null for an image added by hand.
  storage_path text check (storage_path is null or length(storage_path) <= 300),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists payment_tutorial_images_provider_idx
  on public.payment_tutorial_images (provider, sort_order, created_at);

alter table public.payment_tutorial_images enable row level security;
drop policy if exists payment_tutorial_images_select on public.payment_tutorial_images;
create policy payment_tutorial_images_select on public.payment_tutorial_images
  for select to authenticated using (true);
drop policy if exists payment_tutorial_images_admin_write on public.payment_tutorial_images;
create policy payment_tutorial_images_admin_write on public.payment_tutorial_images
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.payment_tutorial_images from anon, authenticated;
grant select, insert, update, delete on public.payment_tutorial_images to authenticated;

-- The batched save. items = [{"id": "<existing image id>" | null, "image_url": "https://...", "storage_path": "..." | null}, ...]
-- in the order they should appear. An item with an id keeps that image (and moves it to its new position); an item without one
-- is a new upload. Existing images of this provider that are NOT in the list are removed.
-- Returns {"removed_paths": [...]} (files to delete from the bucket).
create or replace function public.admin_save_payment_tutorials(p_provider text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item    jsonb;
  v_pos     integer := 0;
  v_keep    uuid[];
  v_removed text[];
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('telebirr', 'cbe') then
    raise exception 'invalid_provider' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'invalid_items' using errcode = '22023', detail = 'at most 10 images per payment method';
  end if;

  -- Check everything BEFORE changing anything.
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'invalid_items' using errcode = '22023';
    end if;
    if nullif(v_item ->> 'id', '') is not null then
      if not exists (
        select 1 from public.payment_tutorial_images
         where id = (v_item ->> 'id')::uuid and provider = p_provider
      ) then
        raise exception 'image_not_found' using errcode = 'P0002', detail = v_item ->> 'id';
      end if;
    elsif coalesce(v_item ->> 'image_url', '') !~ '^https://' or length(v_item ->> 'image_url') > 1000 then
      raise exception 'invalid_items' using errcode = '22023', detail = 'image_url';
    end if;
  end loop;

  v_keep := array(select (e ->> 'id')::uuid from jsonb_array_elements(p_items) e where nullif(e ->> 'id', '') is not null);

  select coalesce(array_agg(storage_path) filter (where storage_path is not null), '{}')
    into v_removed
    from public.payment_tutorial_images
   where provider = p_provider and id <> all (v_keep);

  delete from public.payment_tutorial_images where provider = p_provider and id <> all (v_keep);

  for v_item in select * from jsonb_array_elements(p_items) loop
    if nullif(v_item ->> 'id', '') is not null then
      update public.payment_tutorial_images set sort_order = v_pos where id = (v_item ->> 'id')::uuid;
    else
      insert into public.payment_tutorial_images (provider, image_url, storage_path, sort_order)
      values (p_provider, v_item ->> 'image_url', nullif(v_item ->> 'storage_path', ''), v_pos);
    end if;
    v_pos := v_pos + 1;
  end loop;

  return jsonb_build_object('removed_paths', to_jsonb(v_removed));
end;
$$;

revoke all on function public.admin_save_payment_tutorials(text, jsonb) from public, anon;
grant execute on function public.admin_save_payment_tutorials(text, jsonb) to authenticated;

-- The image files (Supabase only; skipped where the storage schema is absent, e.g. the local test database).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('payment-tutorials', 'payment-tutorials', true)
    on conflict (id) do nothing;

    drop policy if exists payment_tutorials_read on storage.objects;
    create policy payment_tutorials_read on storage.objects
      for select using (bucket_id = 'payment-tutorials');

    drop policy if exists payment_tutorials_admin_insert on storage.objects;
    create policy payment_tutorials_admin_insert on storage.objects
      for insert to authenticated
      with check (bucket_id = 'payment-tutorials' and (select public.is_admin()));

    drop policy if exists payment_tutorials_admin_update on storage.objects;
    create policy payment_tutorials_admin_update on storage.objects
      for update to authenticated
      using (bucket_id = 'payment-tutorials' and (select public.is_admin()))
      with check (bucket_id = 'payment-tutorials' and (select public.is_admin()));

    drop policy if exists payment_tutorials_admin_delete on storage.objects;
    create policy payment_tutorials_admin_delete on storage.objects
      for delete to authenticated
      using (bucket_id = 'payment-tutorials' and (select public.is_admin()));
  end if;
end
$$;
