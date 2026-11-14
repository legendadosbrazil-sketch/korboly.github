-- Rode DEPOIS do schema.sql: pasta de imagens dos produtos/banners (leitura pública, escrita só admin)
insert into storage.buckets (id, name, public) values ('korboly','korboly',true) on conflict (id) do nothing;
create policy "korboly_public_read" on storage.objects for select using (bucket_id = 'korboly');
create policy "korboly_admin_insert" on storage.objects for insert with check (bucket_id = 'korboly' and public.is_admin());
create policy "korboly_admin_update" on storage.objects for update using (bucket_id = 'korboly' and public.is_admin());
create policy "korboly_admin_delete" on storage.objects for delete using (bucket_id = 'korboly' and public.is_admin());
