-- Profile pictures.
--
-- profiles.avatar_url already exists (20260920120000_roles_wallet_catalog, with `grant update (display_name,
-- avatar_url)` to authenticated and the profiles_update_own policy), and the app already renders it with an
-- initials fallback. What was missing is somewhere to put the file: this bucket.
--
-- Public read, like product-art: an avatar is shown by plain URL. Writes are limited to the caller's own folder,
-- `<auth.uid()>/<file>.jpg`, so a user can add, replace or delete only their own picture and never anyone else's.
-- The app only ever uploads a re-encoded JPEG (src/lib/avatar.ts via prepareArtwork), and the bucket refuses
-- anything else or anything over 2 MB even if a client tried.
--
-- Supabase only; skipped where the storage schema is absent (the in-process test database), same as product-art.

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 2097152, array['image/jpeg'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    drop policy if exists avatars_read on storage.objects;
    create policy avatars_read on storage.objects
      for select using (bucket_id = 'avatars');

    drop policy if exists avatars_own_insert on storage.objects;
    create policy avatars_own_insert on storage.objects
      for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

    drop policy if exists avatars_own_update on storage.objects;
    create policy avatars_own_update on storage.objects
      for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

    drop policy if exists avatars_own_delete on storage.objects;
    create policy avatars_own_delete on storage.objects
      for delete to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
end
$$;
