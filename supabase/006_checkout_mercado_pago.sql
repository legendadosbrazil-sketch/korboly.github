-- KORBOLY · 006 · Checkout com Mercado Pago (Checkout Pro) + frete no pedido
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run. Pode rodar mais de uma vez.

-- 1) Novos dados no pedido
alter table public.orders add column if not exists shipping_cents int not null default 0;
alter table public.orders add column if not exists shipping_original_cents int;
alter table public.orders add column if not exists shipping_service text;
alter table public.orders add column if not exists shipping_service_id int;
alter table public.orders add column if not exists customer_cpf text;
alter table public.orders add column if not exists mp_preference_id text;
alter table public.orders add column if not exists mp_init_point text;
alter table public.orders add column if not exists mp_payment_id text;
alter table public.orders add column if not exists payment_method text;
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists updated_at timestamptz not null default now();
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pendente','em_analise','pago','recusado','reembolsado'));
do $$ begin
  alter table public.orders add constraint orders_cpf_chk check (customer_cpf is null or customer_cpf ~ '^[0-9]{11}$');
exception when duplicate_object then null; end $$;
create index if not exists orders_user_idx on public.orders(user_id, created_at desc);

-- 2) Prévia de cupom no checkout (só calcula; o desconto de verdade é aplicado ao criar o pedido)
create or replace function public.preview_coupon(p_code text, p_subtotal_cents int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); cp public.coupons; em text; disc int;
begin
  if uid is null then raise exception 'Faça login para usar um cupom.'; end if;
  if p_subtotal_cents is null or p_subtotal_cents < 0 or p_subtotal_cents > 100000000 then raise exception 'Valor inválido.'; end if;
  select lower(email) into em from auth.users where id = uid;
  select * into cp from public.coupons where code = upper(btrim(coalesce(p_code,'')));
  if not found or not cp.active or (cp.expires_at is not null and cp.expires_at < now())
     or (cp.max_uses is not null and cp.used >= cp.max_uses) then
    raise exception 'Cupom inválido ou expirado.'; end if;
  if cp.email is not null and cp.email <> em then
    raise exception 'Este cupom vale apenas para o e-mail em que foi cadastrado.'; end if;
  if cp.first_purchase_only and exists (select 1 from public.orders where user_id = uid and status <> 'cancelado' and payment_status in ('pago','em_analise','reembolsado')) then
    raise exception 'Este cupom vale somente para a primeira compra.'; end if;
  disc := case cp.kind when 'percent' then (p_subtotal_cents * least(cp.value,100)) / 100 else least(cp.value, p_subtotal_cents) end;
  return jsonb_build_object('code', cp.code, 'kind', cp.kind, 'value', cp.value, 'discount_cents', disc);
end $$;

-- 3) Regra de "primeira compra": pedidos abandonados (sem pagamento) não contam
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
  values (uid, coalesce(nullif(btrim(p_address->>'recipient'),''), prof.full_name), usr.email, prof.phone, 0, 0, p_address)
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
         select 1 from public.orders where user_id = uid and id <> oid and status <> 'cancelado'
           and payment_status in ('pago','em_analise','reembolsado')) then
      raise exception 'Este cupom vale somente para a primeira compra.'; end if;
    disc := case cp.kind when 'percent' then (sub * least(cp.value,100)) / 100 else least(cp.value, sub) end;
    update public.coupons set used = used + 1 where code = cp.code;
  end if;

  update public.orders set subtotal_cents = sub, discount_cents = disc, total_cents = sub - disc,
         coupon_code = case when disc > 0 then cp.code end where id = oid;
  return num;
end $$;

-- 4) Funções internas usadas só pelo servidor da loja (Edge Function, com a chave de serviço)
create or replace function public._order_cancel(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o public.orders; it record;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or o.status = 'cancelado' or o.payment_status in ('pago','em_analise') then return; end if;
  for it in select product_id, quantity from public.order_items where order_id = o.id loop
    update public.products set stock = stock + it.quantity where id = it.product_id and stock is not null;
  end loop;
  if o.coupon_code is not null then
    update public.coupons set used = greatest(used - 1, 0) where code = o.coupon_code;
  end if;
  update public.orders set status = 'cancelado', updated_at = now() where id = o.id;
end $$;

-- cancela pedidos antigos do mesmo cliente que nunca chegaram a ser pagos (libera cupom e estoque)
create or replace function public._checkout_cleanup(p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from public.orders
           where user_id = p_user and status = 'novo' and payment_status in ('pendente','recusado')
             and (mp_payment_id is null or payment_status = 'recusado') loop
    perform public._order_cancel(r.id); n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public._checkout_finalize(p_order uuid, p_shipping_cents int, p_shipping_original_cents int,
  p_service text, p_service_id int, p_cpf text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if p_shipping_cents < 0 or p_shipping_cents > 100000 then raise exception 'Frete inválido.'; end if;
  update public.orders set shipping_cents = p_shipping_cents, shipping_original_cents = p_shipping_original_cents,
         shipping_service = left(p_service, 120), shipping_service_id = p_service_id,
         customer_cpf = p_cpf, customer_phone = coalesce(nullif(p_phone,''), customer_phone),
         total_cents = subtotal_cents - discount_cents + p_shipping_cents, updated_at = now()
   where id = p_order returning * into o;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  return jsonb_build_object('id', o.id, 'number', o.number, 'total_cents', o.total_cents);
end $$;

-- aplica o resultado de um pagamento do Mercado Pago (consultado direto na API deles)
create or replace function public._order_payment(p_order uuid, p_payment_id text, p_status text, p_amount_cents int, p_method text)
returns text language plpgsql security definer set search_path = public as $$
declare o public.orders; it record; novo text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then return 'pedido_nao_encontrado'; end if;
  -- um pagamento recusado não desfaz um aprovado anterior
  if o.payment_status = 'pago' and p_status not in ('refunded','charged_back') and coalesce(o.mp_payment_id,'') <> p_payment_id then
    return 'ignorado';
  end if;
  novo := case
    when p_status = 'approved' and p_amount_cents >= o.total_cents then 'pago'
    when p_status = 'approved' then 'em_analise'            -- valor menor que o pedido: conferir manualmente
    when p_status in ('in_process','authorized','in_mediation') then 'em_analise'
    when p_status = 'pending' then 'pendente'
    when p_status in ('rejected','cancelled') then 'recusado'
    when p_status in ('refunded','charged_back') then 'reembolsado'
    else o.payment_status end;
  -- pagamento aprovado para um pedido que tinha sido cancelado: reativa e baixa o estoque de novo
  if novo in ('pago','em_analise') and o.status = 'cancelado' then
    for it in select product_id, quantity from public.order_items where order_id = o.id loop
      update public.products set stock = greatest(stock - it.quantity, 0) where id = it.product_id and stock is not null;
    end loop;
    if o.coupon_code is not null then update public.coupons set used = used + 1 where code = o.coupon_code; end if;
    update public.orders set status = 'novo' where id = o.id;
  end if;
  update public.orders set payment_status = novo, mp_payment_id = p_payment_id,
         payment_method = coalesce(left(p_method, 40), payment_method),
         paid_at = case when novo = 'pago' then coalesce(paid_at, now()) else paid_at end,
         updated_at = now()
   where id = o.id;
  return novo;
end $$;

create or replace function public._order_set_preference(p_order uuid, p_pref text, p_init text)
returns void language sql security definer set search_path = public as $$
  update public.orders set mp_preference_id = left(p_pref, 80), mp_init_point = left(p_init, 500), updated_at = now() where id = p_order;
$$;

-- 5) Permissões
revoke all on function public.preview_coupon(text, int) from public, anon;
grant execute on function public.preview_coupon(text, int) to authenticated;
revoke all on function public.create_order(jsonb, jsonb, text) from public, anon;
grant execute on function public.create_order(jsonb, jsonb, text) to authenticated;
revoke all on function public._order_cancel(uuid) from public, anon, authenticated;
revoke all on function public._checkout_cleanup(uuid) from public, anon, authenticated;
revoke all on function public._checkout_finalize(uuid, int, int, text, int, text, text) from public, anon, authenticated;
revoke all on function public._order_payment(uuid, text, text, int, text) from public, anon, authenticated;
revoke all on function public._order_set_preference(uuid, text, text) from public, anon, authenticated;
grant execute on function public._order_cancel(uuid), public._checkout_cleanup(uuid),
  public._checkout_finalize(uuid, int, int, text, int, text, text), public._order_payment(uuid, text, text, int, text),
  public._order_set_preference(uuid, text, text) to service_role;

-- 6) Cancelamento pelo painel: devolve estoque e cupom (pedidos já pagos não são cancelados por aqui)
create or replace function public.admin_cancel_order(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if not public.is_admin() then raise exception 'Acesso negado.'; end if;
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if o.payment_status in ('pago','em_analise') then
    raise exception 'Pedido com pagamento aprovado ou em análise: faça o reembolso no Mercado Pago antes de cancelar.'; end if;
  perform public._order_cancel(p_order);
  return 'cancelado';
end $$;
revoke all on function public.admin_cancel_order(uuid) from public, anon;
grant execute on function public.admin_cancel_order(uuid) to authenticated;
