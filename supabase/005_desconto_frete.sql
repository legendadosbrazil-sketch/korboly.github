-- KORBOLY · 005 · Desconto fixo no frete (a loja paga uma parte)
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run. Pode rodar mais de uma vez.
alter table public.site_settings add column if not exists ship_discount_cents int not null default 0;
do $$ begin
  alter table public.site_settings add constraint site_settings_ship_discount_chk check (ship_discount_cents between 0 and 20000);
exception when duplicate_object then null; end $$;
