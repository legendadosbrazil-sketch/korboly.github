-- KORBOLY · 007 · Produtos esgotados + "Me avise quando voltar"
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run. Pode rodar mais de uma vez.
-- Esgotado = produto com estoque controlado (campo Estoque preenchido) e estoque 0.

-- 1) Pedidos de aviso (um por e-mail e produto enquanto não for avisado)
create table if not exists public.restock_requests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  email text not null check (length(email) <= 254 and email ~ '^[^[:space:]@]{1,64}@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  consent_text text not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  attempts int not null default 0,
  last_error text,
  claimed_at timestamptz
);
create unique index if not exists restock_pending_uq on public.restock_requests(product_id, email) where notified_at is null;
create index if not exists restock_created_idx on public.restock_requests(created_at);

-- 2) Histórico de envios
create table if not exists public.restock_notifications (
  id bigserial primary key,
  request_id uuid references public.restock_requests(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  email text,
  status text not null check (status in ('enviado','falhou')),
  error text,
  provider_id text,
  created_at timestamptz not null default now()
);

alter table public.restock_requests enable row level security;
alter table public.restock_notifications enable row level security;
revoke all on public.restock_requests, public.restock_notifications from anon;
drop policy if exists rr_admin on public.restock_requests;
create policy rr_admin on public.restock_requests for select using (public.is_admin());
drop policy if exists rr_admin_del on public.restock_requests;
create policy rr_admin_del on public.restock_requests for delete using (public.is_admin());
drop policy if exists rn_admin on public.restock_notifications;
create policy rn_admin on public.restock_notifications for select using (public.is_admin());
grant select, delete on public.restock_requests to authenticated;
grant select on public.restock_notifications to authenticated;

-- 3) Configuração interna (só o servidor lê): endereço da função e senha do agendador
create table if not exists public._internal (key text primary key, value text not null);
alter table public._internal enable row level security;
revoke all on public._internal from anon, authenticated;
insert into public._internal(key, value) values
  ('cron_secret', replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
  ('loja_url', 'https://brcepymlgicqgyiapxdj.supabase.co/functions/v1/smooth-task')
on conflict (key) do nothing;

-- 4) Cadastro pelo site (público), com validação e proteção contra spam
create or replace function public.request_restock_alert(p_product text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare em text := lower(btrim(coalesce(p_email,''))); prod public.products; n int;
begin
  if length(em) > 254 or em !~ '^[^[:space:]@]{1,64}@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'Informe um e-mail válido.' using errcode = '22023'; end if;
  select * into prod from public.products where slug = btrim(coalesce(p_product,''));
  if not found or not prod.available then raise exception 'Produto não encontrado.' using errcode = '22023'; end if;
  if prod.stock is null or prod.stock > 0 then raise exception 'Este perfume já está disponível. Você pode comprar agora.' using errcode = '22023'; end if;
  -- limites: no máximo 60 cadastros novos por minuto no site e 10 avisos pendentes por e-mail
  select count(*) into n from public.restock_requests where created_at > now() - interval '1 minute';
  if n >= 60 then raise exception 'Muitos cadastros agora. Tente de novo em alguns minutos.' using errcode = '22023'; end if;
  select count(*) into n from public.restock_requests where email = em and notified_at is null;
  if n >= 10 then raise exception 'Este e-mail já tem muitos avisos pendentes.' using errcode = '22023'; end if;
  insert into public.restock_requests(product_id, email, consent_text)
  values (prod.id, em, 'Aceito receber um único e-mail avisando quando ' || prod.name || ' voltar ao estoque.')
  on conflict (product_id, email) where notified_at is null do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('status', case when n = 1 then 'cadastrado' else 'ja_cadastrado' end, 'produto', prod.name);
end $$;

-- 5) Fila de envio (usada só pela função da loja, com a chave de serviço)
create or replace function public._restock_claim(p_limit int default 25)
returns table(id uuid, email text, product_id uuid, slug text, name text, image text, volume_ml int)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with c as (
    select r.id from public.restock_requests r join public.products p on p.id = r.product_id
     where r.notified_at is null and r.attempts < 5
       and (r.claimed_at is null or r.claimed_at < now() - interval '10 minutes')
       and p.available and (p.stock is null or p.stock > 0)
     order by r.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of r skip locked)
  update public.restock_requests r set claimed_at = now() from c, public.products p
   where r.id = c.id and p.id = r.product_id
  returning r.id, r.email, p.id, p.slug, p.name, (p.images)[1], p.volume_ml;
end $$;

create or replace function public._restock_done(p_id uuid, p_ok boolean, p_error text, p_provider text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.restock_requests; pn text;
begin
  select * into r from public.restock_requests where id = p_id for update;
  if not found then return; end if;
  select name into pn from public.products where id = r.product_id;
  if p_ok then
    update public.restock_requests set notified_at = coalesce(notified_at, now()), claimed_at = null, last_error = null where id = p_id;
  else
    -- mantém a reserva por 10 minutos: a próxima tentativa só acontece depois desse intervalo
    update public.restock_requests set attempts = attempts + 1, claimed_at = now(), last_error = left(p_error, 300) where id = p_id;
  end if;
  insert into public.restock_notifications(request_id, product_id, product_name, email, status, error, provider_id)
  values (p_id, r.product_id, pn, r.email, case when p_ok then 'enviado' else 'falhou' end, left(p_error, 300), left(p_provider, 120));
end $$;

-- chama a função da loja para enviar os avisos pendentes (se houver produto de volta com interessados)
create or replace function public._restock_kick()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; s text;
begin
  if not exists (select 1 from public.restock_requests r join public.products p on p.id = r.product_id
                  where r.notified_at is null and r.attempts < 5 and p.available and (p.stock is null or p.stock > 0)) then
    return; end if;
  select value into u from public._internal where key = 'loja_url';
  select value into s from public._internal where key = 'cron_secret';
  begin
    perform net.http_post(url := u, body := jsonb_build_object('action','notificar_estoque'),
      headers := jsonb_build_object('Content-Type','application/json','x-korboly-cron', s));
  exception when others then
    raise notice 'pg_net indisponível: %', sqlerrm;  -- o agendamento ou o painel enviam depois
  end;
end $$;

-- quando o estoque volta (0 -> mais de 0), dispara o envio na hora
create or replace function public._products_restock_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.available and (new.stock is null or new.stock > 0)
     and (not old.available or (old.stock is not null and old.stock <= 0)) then
    perform public._restock_kick();
  end if;
  return new;
end $$;
drop trigger if exists products_restock on public.products;
create trigger products_restock after update of stock, available on public.products
  for each row execute function public._products_restock_trg();

-- 6) Painel
create or replace function public.admin_restock_overview()
returns table(product_id uuid, name text, slug text, stock int, available boolean, aguardando bigint, avisados bigint, falhas bigint, ultimo_aviso timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso negado.'; end if;
  return query
  select p.id, p.name, p.slug, p.stock, p.available,
         count(r.id) filter (where r.notified_at is null),
         count(r.id) filter (where r.notified_at is not null),
         count(r.id) filter (where r.notified_at is null and r.attempts > 0),
         max(r.notified_at)
    from public.products p left join public.restock_requests r on r.product_id = p.id
   group by p.id order by count(r.id) filter (where r.notified_at is null) desc, p.position, p.name;
end $$;

-- 7) Permissões
revoke all on function public.request_restock_alert(text, text) from public;
grant execute on function public.request_restock_alert(text, text) to anon, authenticated;
revoke all on function public._restock_claim(int) from public, anon, authenticated;
revoke all on function public._restock_done(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public._restock_kick() from public, anon, authenticated;
revoke all on function public._products_restock_trg() from public, anon, authenticated;
grant execute on function public._restock_claim(int), public._restock_done(uuid, boolean, text, text), public._restock_kick() to service_role;
revoke all on function public.admin_restock_overview() from public, anon;
grant execute on function public.admin_restock_overview() to authenticated;

-- 8) Envio automático: pg_net (chamada imediata) e pg_cron (nova tentativa a cada 15 minutos)
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then raise notice 'Não foi possível ativar pg_net: % (ative em Database > Extensions)', sqlerrm; end $$;
do $$ begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    create extension if not exists pg_cron;
  end;
exception when others then raise notice 'Não foi possível ativar pg_cron: % (ative em Database > Extensions)', sqlerrm; end $$;
do $$ begin
  perform cron.unschedule('korboly-avise-me') where exists (select 1 from cron.job where jobname = 'korboly-avise-me');
  perform cron.schedule('korboly-avise-me', '*/15 * * * *', 'select public._restock_kick()');
exception when others then raise notice 'Agendamento não criado: %', sqlerrm; end $$;

-- 9) Política de privacidade: informa a nova finalidade (só acrescenta se ainda não estiver no texto)
update public.pages set body = replace(body,
  '- **Preferências de cookies:**',
  '- **Aviso de volta ao estoque:** o e-mail informado e o perfume escolhido, quando você pede para ser avisado.' || chr(10) || '- **Preferências de cookies:**')
 where slug = 'privacidade' and body not like '%Aviso de volta ao estoque%' and body like '%- **Preferências de cookies:**%';
update public.pages set body = replace(body,
  '- **Enviar novidades e ofertas por e-mail:**',
  '- **Avisar, por um único e-mail, quando um perfume esgotado voltar ao estoque:** consentimento (art. 7º, I), dado no momento do pedido de aviso. Esse e-mail não é usado para ofertas.' || chr(10) || '- **Enviar novidades e ofertas por e-mail:**')
 where slug = 'privacidade' and body not like '%voltar ao estoque:** consentimento%' and body like '%- **Enviar novidades e ofertas por e-mail:**%';
update public.pages set body = replace(body,
  '- **jsDelivr:**',
  '- **Resend:** envio dos e-mails automáticos da loja, como o aviso de volta ao estoque.' || chr(10) || '- **jsDelivr:**')
 where slug = 'privacidade' and body not like '%**Resend:**%' and body like '%- **jsDelivr:**%';
update public.pages set body = replace(body,
  '- **Registros de consentimento de cookies:**',
  '- **Pedidos de aviso de volta ao estoque:** até o aviso ser enviado e, depois, pelo tempo necessário para comprovar o envio, ou até você pedir a exclusão.' || chr(10) || '- **Registros de consentimento de cookies:**')
 where slug = 'privacidade' and body not like '%Pedidos de aviso de volta ao estoque%' and body like '%- **Registros de consentimento de cookies:**%';
