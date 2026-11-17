-- KORBOLY · 004 · Cálculo de frete com Melhor Envio
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run. Pode rodar mais de uma vez.

-- 1) Medidas de cada produto JÁ EMBALADO para envio (preenchidas no painel, em Produtos)
alter table public.products add column if not exists ship_weight_g int;
alter table public.products add column if not exists ship_height_cm numeric(6,1);
alter table public.products add column if not exists ship_width_cm  numeric(6,1);
alter table public.products add column if not exists ship_length_cm numeric(6,1);
do $$ begin
  alter table public.products add constraint products_ship_chk check (
    (ship_weight_g  is null or ship_weight_g  between 1 and 30000) and
    (ship_height_cm is null or ship_height_cm between 0.4 and 100) and
    (ship_width_cm  is null or ship_width_cm  between 0.4 and 100) and
    (ship_length_cm is null or ship_length_cm between 0.4 and 100));
exception when duplicate_object then null; end $$;

-- 2) Configurações públicas (o site precisa saber se mostra a calculadora)
alter table public.site_settings add column if not exists ship_enabled boolean not null default false;
alter table public.site_settings add column if not exists ship_handling_days int not null default 0;
do $$ begin
  alter table public.site_settings add constraint site_settings_handling_chk check (ship_handling_days between 0 and 30);
exception when duplicate_object then null; end $$;

-- 3) Configurações privadas (só o administrador e o servidor de frete leem)
create table if not exists public.shipping_config (
  id smallint primary key default 1 check (id = 1),
  origin_cep text check (origin_cep is null or origin_cep ~ '^[0-9]{8}$'),
  services text check (services is null or services ~ '^[0-9]+(,[0-9]+)*$'),
  updated_at timestamptz not null default now()
);
insert into public.shipping_config(id) values (1) on conflict (id) do nothing;
alter table public.shipping_config enable row level security;
revoke all on public.shipping_config from anon;
drop policy if exists shc_admin on public.shipping_config;
create policy shc_admin on public.shipping_config for all using (public.is_admin()) with check (public.is_admin());
grant select, update on public.shipping_config to authenticated;
