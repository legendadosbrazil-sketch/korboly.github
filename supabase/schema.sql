-- =====================================================================
-- KORBOLY — banco de dados, segurança (RLS) e funções
-- Rode UMA vez no Supabase: SQL Editor -> New query -> colar -> Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Perfis (1 por usuário do Supabase Auth) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role text not null default 'customer' check (role in ('customer','admin')),
  created_at timestamptz not null default now()
);

-- Toda conta nova nasce SEMPRE como cliente (ignora qualquer dado vindo do navegador)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, full_name, phone)
  values (new.id,
          left(coalesce(new.raw_user_meta_data->>'full_name',''), 120),
          left(nullif(new.raw_user_meta_data->>'phone',''), 30));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- Endereços ----------
create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text, recipient text not null,
  zip text not null, street text not null, number text not null, complement text,
  district text not null, city text not null, state text not null check (char_length(state)=2),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index addresses_one_default on public.addresses(user_id) where is_default;

-- ---------- Catálogo ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique, position int not null default 0
);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  price_cents int not null check (price_cents >= 0),
  volume_ml int,
  stock int check (stock is null or stock >= 0),   -- null = estoque não controlado
  available boolean not null default true,
  featured boolean not null default false,
  category_id uuid references public.categories(id) on delete set null,
  images text[] not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- Cupons / conteúdo ----------
create table public.coupons (
  code text primary key check (code = upper(code)),
  kind text not null check (kind in ('percent','fixed')),
  value int not null check (value > 0),
  active boolean not null default true,
  expires_at timestamptz,
  max_uses int,
  used int not null default 0
);
create table public.banners (
  id uuid primary key default gen_random_uuid(),
  title text not null, image_url text not null, link_url text,
  position int not null default 0, active boolean not null default true
);
create table public.site_content (
  key text primary key, value text not null default '', updated_at timestamptz not null default now()
);

-- ---------- Pedidos ----------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity (start with 1001) unique,
  user_id uuid not null references auth.users(id),
  customer_name text not null, customer_email text not null, customer_phone text,
  status text not null default 'novo' check (status in ('novo','em_preparo','enviado','entregue','cancelado')),
  payment_status text not null default 'pendente' check (payment_status in ('pendente','pago','recusado','reembolsado')),
  subtotal_cents int not null, discount_cents int not null default 0, total_cents int not null,
  coupon_code text,
  shipping_address jsonb not null,
  tracking_code text,
  created_at timestamptz not null default now()
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null, unit_price_cents int not null, quantity int not null check (quantity > 0)
);
create index on public.orders(user_id);
create index on public.order_items(order_id);

-- ---------- RLS: tudo fechado por padrão ----------
alter table public.profiles enable row level security;
alter table public.addresses enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.coupons enable row level security;
alter table public.banners enable row level security;
alter table public.site_content enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- perfis: cada um vê/edita o seu (apenas nome e telefone); admin vê todos
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated, anon;
grant update (full_name, phone) on public.profiles to authenticated;   -- 'role' NUNCA editável pelo cliente

-- endereços: só do dono
create policy addr_all on public.addresses for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy addr_admin_read on public.addresses for select using (public.is_admin());

-- catálogo: público lê o que está disponível; só admin escreve
create policy cat_read on public.categories for select using (true);
create policy cat_admin on public.categories for all using (public.is_admin()) with check (public.is_admin());
create policy prod_read on public.products for select using (available or public.is_admin());
create policy prod_admin on public.products for all using (public.is_admin()) with check (public.is_admin());
create policy ban_read on public.banners for select using (active or public.is_admin());
create policy ban_admin on public.banners for all using (public.is_admin()) with check (public.is_admin());
create policy sc_read on public.site_content for select using (true);
create policy sc_admin on public.site_content for all using (public.is_admin()) with check (public.is_admin());
-- cupons: só admin lê/escreve (clientes usam via create_order)
create policy coup_admin on public.coupons for all using (public.is_admin()) with check (public.is_admin());

-- pedidos: cliente lê só os seus e NÃO escreve direto (usa create_order); admin lê/atualiza tudo
create policy ord_read on public.orders for select using (user_id = auth.uid() or public.is_admin());
create policy ord_admin_upd on public.orders for update using (public.is_admin()) with check (public.is_admin());
create policy oi_read on public.order_items for select using (
  public.is_admin() or exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()));

-- ---------- Criar pedido (preços calculados NO SERVIDOR) ----------
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

  if p_coupon is not null and p_coupon <> '' then
    select * into cp from public.coupons where code = upper(trim(p_coupon)) for update;
    if not found or not cp.active or (cp.expires_at is not null and cp.expires_at < now())
       or (cp.max_uses is not null and cp.used >= cp.max_uses) then
      raise exception 'Cupom inválido.'; end if;
    disc := case cp.kind when 'percent' then (sub * least(cp.value,100)) / 100 else least(cp.value, sub) end;
    update public.coupons set used = used + 1 where code = cp.code;
  end if;

  update public.orders set subtotal_cents = sub, discount_cents = disc, total_cents = sub - disc,
         coupon_code = case when disc > 0 then upper(trim(p_coupon)) end where id = oid;
  return num;
end $$;
revoke all on function public.create_order(jsonb,jsonb,text) from public, anon;
grant execute on function public.create_order(jsonb,jsonb,text) to authenticated;

-- ---------- Painel admin: indicadores (checam admin dentro da função) ----------
create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso negado.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'revenue_cents', coalesce((select sum(total_cents) from orders where payment_status='pago'),0),
    'month_cents',   coalesce((select sum(total_cents) from orders where payment_status='pago' and created_at >= date_trunc('month', now())),0),
    'orders',        (select count(*) from orders),
    'customers',     (select count(*) from profiles where role='customer'),
    'top_products',  coalesce((select jsonb_agg(t) from (
        select oi.product_name as name, sum(oi.quantity)::int as qty
        from order_items oi join orders o on o.id=oi.order_id
        where o.payment_status='pago' group by 1 order by 2 desc limit 5) t),'[]'::jsonb));
end $$;

create or replace function public.admin_sales_by_day(p_days int default 30)
returns table(day date, total_cents bigint, orders bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso negado.' using errcode = '42501'; end if;
  return query
    select d::date, coalesce(sum(o.total_cents),0)::bigint, count(o.id)::bigint
    from generate_series(current_date - (least(greatest(p_days,1),365)-1), current_date, '1 day') d
    left join orders o on o.created_at::date = d::date and o.payment_status='pago'
    group by 1 order by 1;
end $$;

create or replace function public.admin_customers()
returns table(id uuid, full_name text, email text, phone text, created_at timestamptz, orders bigint, spent_cents bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso negado.' using errcode = '42501'; end if;
  return query
    select p.id, p.full_name, u.email::text, p.phone, p.created_at,
           count(o.id)::bigint, coalesce(sum(o.total_cents) filter (where o.payment_status='pago'),0)::bigint
    from profiles p join auth.users u on u.id=p.id left join orders o on o.user_id=p.id
    where p.role='customer' group by p.id, u.email order by 7 desc;
end $$;

revoke all on function public.admin_stats(), public.admin_sales_by_day(int), public.admin_customers() from public, anon;
grant execute on function public.admin_stats(), public.admin_sales_by_day(int), public.admin_customers() to authenticated;

-- ---------- Produtos atuais da Korboly ----------
insert into public.categories(name, position) values ('Perfumes', 1);
insert into public.products(slug, name, price_cents, volume_ml, images, position, featured, category_id)
select s, n, p, v, array[img], pos, true, (select id from public.categories where name='Perfumes')
from (values
  ('dark-luxury','Dark Luxury',22990,100,'img/dark-luxury.webp',1),
  ('evora','Évora',16990,60,'img/evora.webp',2),
  ('haitz','Haitz',17990,60,'img/haitz.webp',3)) as t(s,n,p,v,img,pos);
