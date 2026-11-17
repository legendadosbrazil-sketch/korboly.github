-- KORBOLY · 003 · Frete pago pelo comprador
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run. Pode rodar mais de uma vez.

-- Corrige a pergunta do FAQ que dizia "frete grátis"
update public.faq_items
   set question = 'Quem paga o frete?',
       answer   = 'O frete é pago pelo comprador. O valor depende do CEP de entrega e é mostrado antes de você finalizar a compra.'
 where question = 'O frete é grátis?';

-- Texto curto que aparece na página inicial, abaixo do preço (editável em Admin > Conteúdo)
insert into public.site_content (key, value) values ('shipping_note', 'Envio para todo o Brasil')
on conflict (key) do update set value = excluded.value
 where coalesce(public.site_content.value, '') = '' or public.site_content.value ilike '%grátis%';
