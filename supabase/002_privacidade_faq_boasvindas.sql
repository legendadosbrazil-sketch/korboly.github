-- =====================================================================
-- KORBOLY — migração 002
-- Privacidade (LGPD) e cookies · FAQ · Pop-up de boas-vindas com cupom
--
-- Rode no Supabase: SQL Editor -> New query -> colar TUDO -> Run.
-- Pode ser rodada mais de uma vez sem perder nada do que já foi editado.
-- Requer o schema.sql (migração 001) já aplicado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Configurações gerais do site (uma única linha)
-- ---------------------------------------------------------------------
create table if not exists public.site_settings (
  id smallint primary key default 1 check (id = 1),
  popup_enabled boolean not null default true,
  popup_delay_seconds int not null default 12 check (popup_delay_seconds between 3 and 120),
  popup_redisplay_days int not null default 14 check (popup_redisplay_days between 1 and 365),
  welcome_discount_percent int not null default 10 check (welcome_discount_percent between 1 and 50),
  welcome_coupon_valid_days int check (welcome_coupon_valid_days is null or welcome_coupon_valid_days between 1 and 365),
  consent_version int not null default 1 check (consent_version between 1 and 100000),
  updated_at timestamptz not null default now()
);
insert into public.site_settings(id) values (1) on conflict (id) do nothing;

alter table public.site_settings enable row level security;
drop policy if exists ss_read on public.site_settings;
create policy ss_read on public.site_settings for select using (true);
drop policy if exists ss_admin on public.site_settings;
create policy ss_admin on public.site_settings for update using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 2. Páginas institucionais (Política de Privacidade)
-- ---------------------------------------------------------------------
create table if not exists public.pages (
  slug text primary key check (slug ~ '^[a-z0-9-]{2,40}$'),
  title text not null check (char_length(title) between 2 and 120),
  body text not null check (char_length(body) between 1 and 60000),
  version int not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.pages enable row level security;
drop policy if exists pages_read on public.pages;
create policy pages_read on public.pages for select using (true);
drop policy if exists pages_admin on public.pages;
create policy pages_admin on public.pages for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 3. Perguntas frequentes
-- ---------------------------------------------------------------------
create table if not exists public.faq_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 60),
  position int not null default 0
);
create table if not exists public.faq_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.faq_categories(id) on delete restrict,
  question text not null check (char_length(question) between 5 and 200),
  answer text not null check (char_length(answer) between 2 and 4000),
  position int not null default 0,
  published boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists faq_items_cat_idx on public.faq_items(category_id, position);

alter table public.faq_categories enable row level security;
alter table public.faq_items enable row level security;
drop policy if exists faqc_read on public.faq_categories;
create policy faqc_read on public.faq_categories for select using (true);
drop policy if exists faqc_admin on public.faq_categories;
create policy faqc_admin on public.faq_categories for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists faqi_read on public.faq_items;
create policy faqi_read on public.faq_items for select using (published or public.is_admin());
drop policy if exists faqi_admin on public.faq_items;
create policy faqi_admin on public.faq_items for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 4. Contatos captados (e-mails)
--    O e-mail é guardado para gerar e validar o cupom (art. 7º, V, LGPD).
--    Só pode ser usado em campanhas se marketing_consent = true (art. 7º, I).
-- ---------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null unique
    check (email = lower(email) and char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'),
  source text not null default 'popup_boas_vindas' check (char_length(source) <= 40),
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  marketing_consent_text text check (marketing_consent_text is null or char_length(marketing_consent_text) <= 300),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists leads_created_idx on public.leads(created_at desc);
alter table public.leads enable row level security;
drop policy if exists leads_admin on public.leads;
create policy leads_admin on public.leads for all using (public.is_admin()) with check (public.is_admin());
revoke all on public.leads from anon;

-- ---------------------------------------------------------------------
-- 5. Registro de consentimento de cookies (prova do consentimento, art. 8º §2º)
--    Sem nome, e-mail ou IP: apenas um identificador aleatório do navegador.
-- ---------------------------------------------------------------------
create table if not exists public.consent_records (
  id bigint generated always as identity primary key,
  visitor_id uuid not null,
  analytics boolean not null,
  marketing boolean not null,
  consent_version int not null,
  action text not null check (action in ('aceitar_todos','rejeitar_opcionais','personalizar')),
  created_at timestamptz not null default now()
);
create index if not exists consent_created_idx on public.consent_records(created_at desc);
create index if not exists consent_visitor_idx on public.consent_records(visitor_id, created_at desc);
alter table public.consent_records enable row level security;
drop policy if exists consent_admin_read on public.consent_records;
create policy consent_admin_read on public.consent_records for select using (public.is_admin());
revoke all on public.consent_records from anon;

-- ---------------------------------------------------------------------
-- 6. Cupons: origem, e-mail vinculado e regra de primeira compra
-- ---------------------------------------------------------------------
alter table public.coupons add column if not exists origin text not null default 'manual';
alter table public.coupons add column if not exists email text;
alter table public.coupons add column if not exists first_purchase_only boolean not null default false;
alter table public.coupons add column if not exists created_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'coupons_origin_chk') then
    alter table public.coupons add constraint coupons_origin_chk check (origin in ('manual','boas_vindas'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupons_email_chk') then
    alter table public.coupons add constraint coupons_email_chk
      check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupons_welcome_email_chk') then
    alter table public.coupons add constraint coupons_welcome_email_chk check (origin <> 'boas_vindas' or email is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupons_percent_chk') then
    alter table public.coupons add constraint coupons_percent_chk check (kind <> 'percent' or value <= 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupons_code_fmt_chk') then
    alter table public.coupons add constraint coupons_code_fmt_chk check (code ~ '^[A-Z0-9_-]{3,30}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupons_max_uses_chk') then
    alter table public.coupons add constraint coupons_max_uses_chk check (max_uses is null or max_uses >= 1) not valid;
  end if;
end $$;
create unique index if not exists coupons_welcome_email_uq on public.coupons(email) where origin = 'boas_vindas';
create index if not exists coupons_created_idx on public.coupons(created_at desc);

-- normaliza código (maiúsculas) e e-mail (minúsculas) antes de gravar
create or replace function public._coupons_norm() returns trigger
language plpgsql set search_path = public as $$
begin
  new.code := upper(btrim(new.code));
  new.email := nullif(lower(btrim(new.email)), '');
  return new;
end $$;
drop trigger if exists coupons_norm on public.coupons;
create trigger coupons_norm before insert or update on public.coupons
  for each row execute function public._coupons_norm();

-- ---------------------------------------------------------------------
-- 7. Gatilhos de data/versão
-- ---------------------------------------------------------------------
create or replace function public._touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public._pages_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.body is distinct from old.body or new.title is distinct from old.title then
    new.version := old.version + 1;
    new.updated_at := now();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;

drop trigger if exists site_settings_touch on public.site_settings;
create trigger site_settings_touch before update on public.site_settings
  for each row execute function public._touch_updated_at();
drop trigger if exists faq_items_touch on public.faq_items;
create trigger faq_items_touch before update on public.faq_items
  for each row execute function public._touch_updated_at();
drop trigger if exists pages_touch on public.pages;
create trigger pages_touch before update on public.pages
  for each row execute function public._pages_touch();

-- ---------------------------------------------------------------------
-- 8. Código de cupom individual (KORB-XXXX-XXXX, sem caracteres ambíguos)
-- ---------------------------------------------------------------------
create or replace function public._welcome_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  a constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 símbolos: sem 0/O, 1/I
  pos constant int[] := array[0,1,2,3,4,5,10,11];         -- bytes 100% aleatórios do UUID v4
  b bytea; c text; i int;
begin
  loop
    b := uuid_send(gen_random_uuid());
    c := 'KORB-';
    for i in 1..8 loop
      c := c || substr(a, 1 + (get_byte(b, pos[i]) % 32), 1);
      if i = 4 then c := c || '-'; end if;
    end loop;
    exit when not exists (select 1 from public.coupons where code = c);
  end loop;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- 9. Pop-up: cadastrar e-mail e receber o cupom de primeira compra
-- ---------------------------------------------------------------------
create or replace function public.claim_welcome_coupon(p_email text, p_marketing boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.site_settings;
  e text := lower(btrim(coalesce(p_email, '')));
  mk boolean := coalesce(p_marketing, false);
  txt constant text := 'Quero receber novidades e ofertas da Korboly por e-mail.';
  cp public.coupons;
begin
  select * into s from public.site_settings where id = 1;
  if not found or not s.popup_enabled then
    raise exception 'Esta oferta não está disponível no momento.' using errcode = 'P0001';
  end if;
  if char_length(e) > 254 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then
    raise exception 'Informe um e-mail válido.' using errcode = '22023';
  end if;
  -- freio contra cadastros automatizados em massa
  if not exists (select 1 from public.leads where email = e)
     and (select count(*) from public.leads where created_at > now() - interval '1 minute') >= 40 then
    raise exception 'Muitas solicitações neste momento. Tente de novo em instantes.' using errcode = 'P0001';
  end if;

  insert into public.leads(email, source, marketing_consent, marketing_consent_at, marketing_consent_text)
  values (e, 'popup_boas_vindas', mk, case when mk then now() end, case when mk then txt end)
  on conflict (email) do update set
    marketing_consent      = public.leads.marketing_consent or excluded.marketing_consent,
    marketing_consent_at   = case when excluded.marketing_consent and not public.leads.marketing_consent
                                  then now() else public.leads.marketing_consent_at end,
    marketing_consent_text = case when excluded.marketing_consent and not public.leads.marketing_consent
                                  then excluded.marketing_consent_text else public.leads.marketing_consent_text end,
    unsubscribed_at        = case when excluded.marketing_consent then null else public.leads.unsubscribed_at end;

  select * into cp from public.coupons where origin = 'boas_vindas' and email = e;
  if not found then
    insert into public.coupons(code, kind, value, active, expires_at, max_uses, origin, email, first_purchase_only)
    values (public._welcome_code(), 'percent', s.welcome_discount_percent, true,
            case when s.welcome_coupon_valid_days is not null
                 then now() + make_interval(days => s.welcome_coupon_valid_days) end,
            1, 'boas_vindas', e, true)
    returning * into cp;
  end if;

  return jsonb_build_object('code', cp.code, 'percent', cp.value, 'expires_at', cp.expires_at);
end $$;

-- ---------------------------------------------------------------------
-- 10. Registro do consentimento de cookies
-- ---------------------------------------------------------------------
create or replace function public.record_cookie_consent(
  p_visitor uuid, p_analytics boolean, p_marketing boolean, p_version int, p_action text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_visitor is null or p_version is null or p_version < 1 or p_version > 100000
     or p_action is null or p_action not in ('aceitar_todos','rejeitar_opcionais','personalizar') then
    raise exception 'Dados de consentimento inválidos.' using errcode = '22023';
  end if;
  -- ignora repetições do mesmo navegador e picos anormais
  if exists (select 1 from public.consent_records
             where visitor_id = p_visitor and created_at > now() - interval '5 seconds') then return; end if;
  if (select count(*) from public.consent_records where created_at > now() - interval '1 minute') >= 300 then return; end if;
  insert into public.consent_records(visitor_id, analytics, marketing, consent_version, action)
  values (p_visitor, coalesce(p_analytics, false), coalesce(p_marketing, false), p_version, p_action);
end $$;

-- ---------------------------------------------------------------------
-- 11. Minha conta: preferência de e-mails e cupom de boas-vindas
-- ---------------------------------------------------------------------
create or replace function public.my_marketing() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); e text; l public.leads; cp public.coupons;
begin
  if uid is null then raise exception 'Faça login.' using errcode = '42501'; end if;
  select lower(email) into e from auth.users where id = uid;
  select * into l from public.leads where email = e;
  select * into cp from public.coupons where origin = 'boas_vindas' and email = e;
  return jsonb_build_object(
    'subscribed', coalesce(l.marketing_consent, false),
    'coupon', case when cp.code is null then null else jsonb_build_object(
      'code', cp.code, 'percent', cp.value, 'expires_at', cp.expires_at,
      'used', cp.used >= coalesce(cp.max_uses, 2147483647),
      'active', cp.active and (cp.expires_at is null or cp.expires_at > now())) end);
end $$;

create or replace function public.set_my_marketing(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); e text; on_ boolean := coalesce(p_on, false);
begin
  if uid is null then raise exception 'Faça login.' using errcode = '42501'; end if;
  select lower(email) into e from auth.users where id = uid;
  if on_ then
    insert into public.leads(email, source, marketing_consent, marketing_consent_at, marketing_consent_text)
    values (e, 'minha_conta', true, now(), 'Quero receber novidades e ofertas da Korboly por e-mail.')
    on conflict (email) do update set marketing_consent = true,
      marketing_consent_at = case when public.leads.marketing_consent then public.leads.marketing_consent_at else now() end,
      marketing_consent_text = coalesce(public.leads.marketing_consent_text, excluded.marketing_consent_text),
      unsubscribed_at = null;
  else
    update public.leads set marketing_consent = false, unsubscribed_at = now()
    where email = e and marketing_consent;
  end if;
  return on_;
end $$;

-- ---------------------------------------------------------------------
-- 12. Painel admin
-- ---------------------------------------------------------------------
create or replace function public.admin_marketing_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso negado.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'leads',            (select count(*) from leads),
    'leads_consent',    (select count(*) from leads where marketing_consent),
    'leads_unsub',      (select count(*) from leads where unsubscribed_at is not null and not marketing_consent),
    'leads_30d',        (select count(*) from leads where created_at > now() - interval '30 days'),
    'welcome_coupons',  (select count(*) from coupons where origin = 'boas_vindas'),
    'welcome_used',     (select count(*) from coupons where origin = 'boas_vindas' and used > 0),
    'consents_30d',     coalesce((select jsonb_object_agg(action, n) from (
                           select action, count(*) n from consent_records
                           where created_at > now() - interval '30 days' group by action) t), '{}'::jsonb));
end $$;

-- exclusão a pedido do titular: apaga o contato e o cupom de boas-vindas não utilizado
create or replace function public.admin_delete_lead(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if not public.is_admin() then raise exception 'Acesso negado.' using errcode = '42501'; end if;
  delete from public.leads where id = p_id returning email into e;
  if e is not null then
    delete from public.coupons where origin = 'boas_vindas' and email = e and used = 0;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 13. Pedido: cupom vinculado ao e-mail e regra de primeira compra
--     (mesma função do schema.sql, com as novas validações de cupom)
-- ---------------------------------------------------------------------
create or replace function public.create_order(p_items jsonb, p_address jsonb, p_coupon text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); prof public.profiles; usr auth.users;
  it jsonb; prod public.products; qty int; sub int := 0; disc int := 0;
  cp public.coupons; oid uuid; num bigint;
begin
  if uid is null then raise exception 'Faça login para comprar.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Carrinho vazio.'; end if;
  if jsonb_array_length(p_items) > 20 then raise exception 'Itens demais.'; end if;
  if coalesce(p_address->>'zip','') = '' or coalesce(p_address->>'street','') = '' then
    raise exception 'Endereço incompleto.'; end if;

  select * into prof from public.profiles where id = uid;
  select * into usr from auth.users where id = uid;

  insert into public.orders(user_id, customer_name, customer_email, customer_phone,
                            subtotal_cents, total_cents, shipping_address)
  values (uid, prof.full_name, usr.email, prof.phone, 0, 0, p_address)
  returning id, number into oid, num;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it->>'quantity')::int;
    if qty is null or qty < 1 or qty > 20 then raise exception 'Quantidade inválida.'; end if;
    select * into prod from public.products where id = (it->>'product_id')::uuid for update;
    if not found or not prod.available then raise exception 'Produto indisponível.'; end if;
    if prod.stock is not null then
      if prod.stock < qty then raise exception 'Estoque insuficiente de %.', prod.name; end if;
      update public.products set stock = stock - qty where id = prod.id;
    end if;
    insert into public.order_items(order_id, product_id, product_name, unit_price_cents, quantity)
    values (oid, prod.id, prod.name, prod.price_cents, qty);
    sub := sub + prod.price_cents * qty;
  end loop;

  if p_coupon is not null and btrim(p_coupon) <> '' then
    select * into cp from public.coupons where code = upper(btrim(p_coupon)) for update;
    if not found or not cp.active or (cp.expires_at is not null and cp.expires_at < now())
       or (cp.max_uses is not null and cp.used >= cp.max_uses) then
      raise exception 'Cupom inválido ou expirado.'; end if;
    if cp.email is not null and cp.email <> lower(usr.email) then
      raise exception 'Este cupom vale apenas para o e-mail em que foi cadastrado.'; end if;
    if cp.first_purchase_only and exists (
         select 1 from public.orders where user_id = uid and id <> oid and status <> 'cancelado') then
      raise exception 'Este cupom vale somente para a primeira compra.'; end if;
    disc := case cp.kind when 'percent' then (sub * least(cp.value,100)) / 100 else least(cp.value, sub) end;
    update public.coupons set used = used + 1 where code = cp.code;
  end if;

  update public.orders set subtotal_cents = sub, discount_cents = disc, total_cents = sub - disc,
         coupon_code = case when disc > 0 then cp.code end where id = oid;
  return num;
end $$;

-- ---------------------------------------------------------------------
-- 14. Permissões das funções (o Supabase libera tudo por padrão: fechamos aqui)
-- ---------------------------------------------------------------------
revoke all on function public._welcome_code() from public, anon, authenticated;
revoke all on function public._coupons_norm() from public, anon, authenticated;
revoke all on function public._touch_updated_at() from public, anon, authenticated;
revoke all on function public._pages_touch() from public, anon, authenticated;

revoke all on function public.claim_welcome_coupon(text, boolean) from public;
grant execute on function public.claim_welcome_coupon(text, boolean) to anon, authenticated;
revoke all on function public.record_cookie_consent(uuid, boolean, boolean, int, text) from public;
grant execute on function public.record_cookie_consent(uuid, boolean, boolean, int, text) to anon, authenticated;

revoke all on function public.my_marketing(), public.set_my_marketing(boolean) from public, anon;
grant execute on function public.my_marketing(), public.set_my_marketing(boolean) to authenticated;
revoke all on function public.admin_marketing_stats(), public.admin_delete_lead(uuid) from public, anon;
grant execute on function public.admin_marketing_stats(), public.admin_delete_lead(uuid) to authenticated;
revoke all on function public.create_order(jsonb, jsonb, text) from public, anon;
grant execute on function public.create_order(jsonb, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- 15. Conteúdo inicial (só é inserido se ainda não existir)
-- ---------------------------------------------------------------------
-- campos usados na política e no FAQ (preencha em Admin > Privacidade)
insert into public.site_content(key, value) values
  ('company_name', ''), ('company_cnpj', ''), ('company_address', ''), ('dpo_name', ''), ('contact_email', '')
on conflict (key) do nothing;

insert into public.pages(slug, title, body) values ('privacidade', 'Política de Privacidade', $pol$
Esta política explica como a Korboly coleta, usa, armazena e protege os dados pessoais de quem visita o site, cria uma conta ou compra conosco, em conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018, a LGPD).

## 1. Quem é o controlador dos dados {#controlador}

- **Controlador:** {{empresa}}
- **CNPJ:** {{cnpj}}
- **Endereço:** {{endereco}}
- **Encarregado pelo tratamento de dados:** {{encarregado}}
- **Contato para assuntos de privacidade:** {{email}}

## 2. Quais dados coletamos {#dados}

- **Conta:** nome, e-mail, telefone (opcional) e senha. A senha é armazenada de forma criptografada pelo nosso provedor de autenticação; nem a equipe Korboly tem acesso a ela.
- **Pedidos e entrega:** endereço de entrega, itens comprados, valores, cupom utilizado e código de rastreamento.
- **Cupom de primeira compra:** o e-mail informado, a data do cadastro e, se você marcar essa opção, o seu consentimento para receber comunicações.
- **Preferências de cookies:** um identificador aleatório do navegador e as escolhas feitas no aviso de cookies. Esse registro não contém nome, e-mail nem endereço IP.
- **Dados técnicos de acesso:** registros gerados automaticamente pelos provedores de hospedagem e de banco de dados (como endereço IP, data e hora), usados para segurança e para o funcionamento do site.

Não coletamos dados pessoais sensíveis e não armazenamos dados de cartão de pagamento.

## 3. Para que usamos os dados e com qual base legal {#finalidades}

- **Criar e manter sua conta, processar pedidos e realizar entregas:** execução de contrato (art. 7º, V, da LGPD).
- **Gerar e validar o cupom de primeira compra que você solicitou:** procedimentos preliminares relacionados a contrato, a pedido do titular (art. 7º, V).
- **Enviar novidades e ofertas por e-mail:** consentimento (art. 7º, I). Só enviamos se você marcar essa opção, e você pode cancelar quando quiser.
- **Cumprir obrigações legais, fiscais e do Código de Defesa do Consumidor:** cumprimento de obrigação legal (art. 7º, II).
- **Proteger o site e prevenir fraudes:** legítimo interesse (art. 7º, IX).

## 4. Cookies e tecnologias semelhantes {#cookies}

Usamos cookies e o armazenamento local do navegador em três categorias:

- **Essenciais:** necessários para o site funcionar, como manter você conectado à sua conta, lembrar as suas escolhas sobre cookies e lembrar se você já respondeu à oferta de primeira compra. Não podem ser desativados.
- **Analíticos:** ajudam a entender como o site é usado. Só são ativados com o seu consentimento.
- **Marketing:** permitem medir campanhas e mostrar ofertas mais relevantes. Só são ativados com o seu consentimento.

No momento, a Korboly não utiliza ferramentas analíticas nem de marketing. Se passarmos a usar, elas só serão carregadas depois da sua autorização, e esta política será atualizada.

Você pode mudar suas escolhas a qualquer momento em **Preferências de cookies**, no rodapé do site.

## 5. Com quem compartilhamos {#compartilhamento}

Não vendemos dados pessoais. Compartilhamos apenas o necessário com fornecedores que tratam dados em nosso nome:

- **Supabase:** banco de dados e autenticação das contas.
- **Hostinger:** hospedagem do site.
- **Google Fonts:** entrega das fontes do site; recebe o endereço IP do navegador para enviar os arquivos.
- **jsDelivr:** entrega de uma biblioteca técnica usada nas páginas de conta.
- **Transportadoras e meios de pagamento:** quando houver compra, somente os dados necessários para a entrega e a cobrança.

Alguns desses fornecedores podem tratar dados fora do Brasil. Nesses casos, a transferência segue as hipóteses do art. 33 da LGPD. Também podemos compartilhar dados com autoridades quando houver obrigação legal ou ordem judicial.

## 6. Por quanto tempo guardamos {#retencao}

- **Conta:** enquanto ela estiver ativa ou até você pedir a exclusão.
- **Pedidos:** pelo prazo exigido pela legislação fiscal e de defesa do consumidor.
- **E-mail do cupom e preferências de comunicação:** até você pedir a exclusão. O consentimento para ofertas vale até ser revogado.
- **Registros de consentimento de cookies:** pelo tempo necessário para comprovar o consentimento.

## 7. Seus direitos {#direitos}

Pela LGPD (art. 18), você pode, a qualquer momento:

- confirmar se tratamos seus dados e ter acesso a eles;
- corrigir dados incompletos, inexatos ou desatualizados;
- pedir a anonimização, o bloqueio ou a eliminação de dados desnecessários, excessivos ou tratados em desacordo com a lei;
- pedir a portabilidade dos seus dados;
- saber com quem compartilhamos seus dados;
- revogar o consentimento e pedir a eliminação dos dados tratados com base nele.

Para exercer qualquer um desses direitos, escreva para {{email}}. Respondemos em até 15 dias. Você também pode apresentar reclamação à Autoridade Nacional de Proteção de Dados (ANPD).

Se você tem uma conta, também pode corrigir seus dados e cancelar o recebimento de e-mails em **Minha conta**.

## 8. Como protegemos seus dados {#seguranca}

- Toda a navegação no site é protegida por HTTPS.
- As senhas são armazenadas criptografadas pelo provedor de autenticação.
- O banco de dados aplica regras de acesso por registro: cada cliente só acessa os próprios dados, e apenas a administração da Korboly acessa o necessário para atender os pedidos.
- O acesso administrativo é restrito e exige login.

Nenhum sistema é totalmente imune a incidentes. Se ocorrer um incidente que possa trazer risco ou dano relevante, comunicaremos a ANPD e as pessoas afetadas, como determina o art. 48 da LGPD.

## 9. Menores de idade {#menores}

O site não é direcionado a menores de 18 anos e não coletamos intencionalmente dados de crianças. Qualquer tratamento de dados de crianças e adolescentes seguirá o art. 14 da LGPD.

## 10. Alterações nesta política {#alteracoes}

Podemos atualizar esta política para refletir mudanças no site ou na legislação. A data da última atualização aparece no topo desta página. Quando a mudança afetar as suas escolhas sobre cookies, pediremos seu consentimento novamente.
$pol$) on conflict (slug) do nothing;

-- FAQ inicial: só é criado se ainda não houver nenhuma categoria.
-- Perguntas marcadas como rascunho (published = false) dependem de informações
-- do negócio e ficam ocultas no site até serem completadas no painel.
do $$
declare c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid;
begin
  if exists (select 1 from public.faq_categories) then return; end if;
  insert into public.faq_categories(name, position) values ('Produtos e fragrâncias', 1) returning id into c1;
  insert into public.faq_categories(name, position) values ('Pedidos e pagamentos', 2) returning id into c2;
  insert into public.faq_categories(name, position) values ('Entrega e rastreamento', 3) returning id into c3;
  insert into public.faq_categories(name, position) values ('Trocas e devoluções', 4) returning id into c4;
  insert into public.faq_categories(name, position) values ('Segurança e privacidade', 5) returning id into c5;
  insert into public.faq_categories(name, position) values ('Atendimento ao cliente', 6) returning id into c6;

  insert into public.faq_items(category_id, position, published, question, answer) values
  (c1, 1, true, 'Quais fragrâncias a Korboly oferece?',
   'A coleção atual tem três fragrâncias: **Dark Luxury** (100 ml), **Évora** (60 ml) e **Haitz** (60 ml). Cada uma tem um frasco autoral, desenhado exclusivamente para a Korboly.'),
  (c1, 2, true, 'Como conservar meu perfume?',
   'Guarde o frasco bem fechado, longe da luz do sol, de fontes de calor e de umidade, como o banheiro. Mudanças bruscas de temperatura alteram a fragrância com o tempo.'),
  (c1, 3, false, 'Qual é a concentração dos perfumes?',
   '[Informe a concentração de cada fragrância, por exemplo Eau de Parfum ou Eau de Toilette.]'),
  (c1, 4, false, 'Quanto tempo a fragrância dura na pele?',
   '[Informe a fixação aproximada de cada fragrância e lembre que ela varia conforme a pele e o clima.]'),

  (c2, 1, true, 'Preciso ter uma conta para comprar?',
   'Sim. A conta guarda seus pedidos, endereços e o histórico de compras, e é por ela que você acompanha cada entrega. Criar uma conta é gratuito, em [Minha conta](conta.html).'),
  (c2, 2, true, 'Como uso o cupom de primeira compra?',
   'Informe o código do cupom ao finalizar a compra. O cupom de primeira compra é individual: vale para a primeira compra feita com o mesmo e-mail em que você se cadastrou e pode ser usado uma única vez. Se você tem uma conta com esse e-mail, o código também aparece em Minha conta › Privacidade.'),
  (c2, 3, false, 'Quais formas de pagamento são aceitas?',
   '[Informe as formas de pagamento aceitas, por exemplo Pix e cartão de crédito, e as condições de parcelamento.]'),

  (c3, 1, true, 'Quem paga o frete?',
   'O frete é pago pelo comprador. O valor depende do CEP de entrega e é mostrado antes de você finalizar a compra.'),
  (c3, 2, true, 'Como acompanho meu pedido?',
   'Assim que o pedido é enviado, o código de rastreamento aparece em [Minha conta](conta.html) › Meus pedidos.'),
  (c3, 3, false, 'Qual é o prazo de entrega?',
   '[Informe o prazo de preparo do pedido e o prazo médio de entrega por região.]'),

  (c4, 1, true, 'Posso desistir da compra?',
   'Sim. Pelo Código de Defesa do Consumidor (art. 49), compras feitas pela internet podem ser canceladas em até 7 dias corridos a partir do recebimento, sem precisar de justificativa. Os valores pagos são devolvidos integralmente. Para solicitar, fale com a gente pelo e-mail {{email}} informando o número do pedido.'),
  (c4, 2, true, 'E se o produto chegar com defeito ou avariado?',
   'Você tem até 30 dias, contados do recebimento, para reclamar de defeitos aparentes (art. 26 do Código de Defesa do Consumidor). Escreva para {{email}} com o número do pedido e fotos do produto e da embalagem, e resolvemos com você.'),
  (c4, 3, false, 'Posso trocar uma fragrância por outra?',
   '[Informe se a Korboly aceita troca de fragrância fora dos casos de arrependimento ou defeito, e em quais condições.]'),

  (c5, 1, true, 'Meus dados estão seguros?',
   'Sim. Toda a navegação é protegida por HTTPS, sua senha é armazenada criptografada pelo provedor de autenticação e cada cliente só tem acesso aos próprios dados. A Korboly não armazena dados de cartão.'),
  (c5, 2, true, 'Como a Korboly usa meus dados?',
   'Usamos seus dados para criar sua conta, processar pedidos e realizar entregas, e só enviamos ofertas por e-mail se você autorizar. Os detalhes estão na [Política de Privacidade](privacidade.html).'),
  (c5, 3, true, 'Como altero minhas preferências de cookies?',
   'A qualquer momento, pelo link **Preferências de cookies** no rodapé de todas as páginas. Cookies analíticos e de marketing só são ativados com a sua autorização.'),
  (c5, 4, true, 'Como deixo de receber e-mails da Korboly?',
   'Se você tem uma conta, desative a opção em [Minha conta](conta.html) › Privacidade. Você também pode pedir pelo e-mail {{email}}.'),
  (c5, 5, true, 'Como peço a exclusão dos meus dados?',
   'Escreva para {{email}} pedindo a exclusão. Atendemos em até 15 dias, mantendo apenas o que a lei nos obriga a guardar, como os registros fiscais de pedidos.'),

  (c6, 1, true, 'Como falo com a Korboly?',
   'Pelo e-mail {{email}} ou pelo Instagram [@korboly](https://instagram.com/korboly).'),
  (c6, 2, false, 'Qual é o horário de atendimento?',
   '[Informe os dias e horários de atendimento.]');
end $$;
