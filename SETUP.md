# Korboly — conta, login e painel admin (passo a passo)

O site continua no GitHub Pages. Quem guarda os dados e protege o acesso é o **Supabase** (gratuito para começar).

## 1. Criar o projeto no Supabase
1. Entre em https://supabase.com e crie uma conta (pode usar o login do GitHub).
2. **New project** → nome `korboly` → crie uma **senha do banco** e guarde → região **South America (São Paulo)** → Create.

## 2. Criar as tabelas e a segurança
1. No menu esquerdo: **SQL Editor** → **New query**.
2. Abra o arquivo `supabase/schema.sql`, copie tudo, cole e clique em **Run**. Deve aparecer "Success".
3. Nova query: cole o conteúdo de `supabase/storage.sql` e **Run** (pasta das imagens).

Isso já cadastra os 3 perfumes atuais (Dark Luxury, Évora, Haitz) com os preços do site. O estoque fica "não controlado" até você informar no painel.

## 3. Ligar o site ao Supabase
1. No Supabase: **Project Settings → API**. Copie a **Project URL** e a chave **anon public**.
2. Abra `js/config.js` e cole nos dois campos. (A chave *anon* pode ficar pública. **Nunca** use a `service_role`.)

## 4. Endereços permitidos (para os e-mails de confirmação e recuperação)
**Authentication → URL Configuration**:
- **Site URL:** `https://legendadosbrazil-sketch.github.io/korboly.github/`
- **Redirect URLs:** a mesma URL com `**` no final.

Em **Authentication → Providers → Email**, deixe **Confirm email** ligado e **mínimo de senha 8**.
(Quando tiver domínio próprio, troque as URLs.)

## 5. Criar o primeiro administrador (único jeito seguro)
1. No site, abra `conta.html` e **crie sua conta normalmente** (e confirme o e-mail).
2. No Supabase → **SQL Editor** → rode (trocando pelo seu e-mail):
```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'SEU-EMAIL@exemplo.com');
```
3. Entre de novo e acesse `.../korboly.github/admin/`. Ninguém consegue virar admin pelo site: o cliente não tem permissão de alterar esse campo.

## 6. Publicar
Coloque os arquivos na pasta do site e rode `enviar.bat` (ou `git add .`, `git commit`, `git push`).

## 7. Cookies, FAQ, Privacidade e cupom de primeira compra
1. No Supabase, **SQL Editor** → **New query**. Abra `supabase/002_privacidade_faq_boasvindas.sql`, copie tudo, cole e clique em **Run**. Pode rodar de novo sem problema (não apaga nada).
2. No painel (`/admin`) → **Privacidade**: preencha razão social, CNPJ, endereço, encarregado e e-mail de contato. Enquanto estiverem vazios, aparecem como "[a preencher]" na política e no FAQ.
3. Painel → **FAQ**: complete e publique as 6 perguntas em rascunho (as que têm textos entre colchetes).
4. Painel → **Marketing**: ajuste o tempo do pop-up, o desconto e a validade.

Como administrar:
- **Marketing**: contatos captados, quem aceita ofertas, exportar CSV (use "Exportar para campanhas": só quem consentiu), descadastrar, excluir dados a pedido, cupons (criar, desativar, excluir).
- **FAQ**: criar/editar/ordenar perguntas e categorias; rascunho não aparece no site.
- **Privacidade**: dados do controlador e texto da política (cada alteração gera nova versão). "Pedir novo consentimento" mostra o aviso de cookies de novo para todos.
- Se um dia instalar Google Analytics, Meta Pixel etc., coloque o script com `type="text/plain" data-consent="analytics"` (ou `"marketing"`): ele só roda depois que a pessoa aceitar.

## 8. Frete pelo Melhor Envio (pago pelo comprador)
1. **Banco:** no Supabase, SQL Editor → New query → cole `supabase/003_frete_comprador.sql` → Run. Depois faça o mesmo com `supabase/004_frete_melhor_envio.sql`.
2. **Token do Melhor Envio:** entre em melhorenvio.com.br → menu **Integrações** → **Permissões de acesso** → **Gerar novo token**. Dê o nome "Site Korboly" e marque a permissão de **cálculo de fretes** (shipping-calculate). Copie o token (ele aparece uma vez só).
3. **Função no Supabase:** menu **Edge Functions** → **Deploy a new function** → **Via Editor**.
   - Nome: `frete` (exatamente assim).
   - Apague o código de exemplo, cole todo o conteúdo de `supabase/functions/frete/index.ts` e clique em **Deploy**.
   - Na página da função, aba **Details**, desligue **Verify JWT** e salve. Isso é necessário porque o site usa a chave publicável; a segurança fica por conta da própria função.
4. **Segredo:** Edge Functions → **Secrets** → Add new secret. Nome `MELHOR_ENVIO_TOKEN`, valor = o token do passo 2. O token nunca vai para o site nem para o GitHub.
5. **Painel → Produtos:** em cada perfume, preencha peso (g) e medidas (cm) **já embalado para envio**.
6. **Painel → Frete:** CEP de onde os pedidos saem e dias para preparar o envio → Salvar. Use **Testar cotação** com qualquer CEP. Se aparecerem as opções, marque **Mostrar a calculadora de frete no site** e salve.

7. **Desconto no frete (opcional):** rode `supabase/005_desconto_frete.sql`, depois em Painel → Frete preencha "Desconto no frete (R$)". O valor sai de todas as opções e o cliente vê o preço riscado.

Observação: a função foi publicada no Supabase com o nome `smooth-task`; esse nome está em `js/config.js` (LOJA_FUNCTION). O código dela fica em `supabase/functions/loja/COPIAR-PARA-O-SUPABASE.txt`; sempre que mudar, cole o arquivo novo nela e clique em Deploy.

Se o teste der erro, a mensagem diz o que falta (token, CEP de origem, medidas ou a função não publicada).
O token gerado pelo Melhor Envio tem validade. Se um dia o teste disser que o token foi recusado, gere outro e troque o segredo.

## 9. Pagamento com Mercado Pago (Checkout Pro)
O cliente monta o carrinho, preenche os dados em `checkout.html` e paga na página do Mercado Pago (Pix, cartão ou boleto). Quando o pagamento é aprovado, o pedido vira "Pago" sozinho no painel.

1. **Banco:** SQL Editor → cole `supabase/006_checkout_mercado_pago.sql` → Run.
2. **Função:** Edge Functions → `smooth-task` → apague o código e cole `supabase/functions/loja/COPIAR-PARA-O-SUPABASE.txt` → Deploy. (Ela continua fazendo o frete e agora faz também o pagamento.)
3. **Credencial do Mercado Pago:** mercadopago.com.br/developers → **Suas integrações** → **Criar aplicação** (Checkout Pro / pagamentos online). Em **Credenciais de produção**, copie o **Access Token** (começa com `APP_USR-`).
4. **Segredo:** Edge Functions → Secrets → `MP_ACCESS_TOKEN` = o Access Token.
5. **Avisos de pagamento (Webhooks):** na mesma aplicação → **Webhooks** → Modo produção → URL:
   `https://brcepymlgicqgyiapxdj.supabase.co/functions/v1/smooth-task?mp=1`
   Marque o evento **Pagamentos** e salve. Copie a **assinatura secreta** e crie o segredo `MP_WEBHOOK_SECRET` com ela.
6. Rode o `enviar.bat`.
7. **Teste real:** faça uma compra pequena com a sua conta pagando com Pix, confira que o pedido fica "Pago" no painel e depois devolva o dinheiro pelo Mercado Pago (Atividade → pagamento → Devolver).

Como administrar: **Painel → Pedidos** mostra frete, CPF, forma de pagamento e o número do pagamento no Mercado Pago. Pedidos que o cliente começou e não pagou ficam ocultos (marque "Mostrar abandonados" para ver); eles são cancelados sozinhos quando o cliente tenta de novo e devolvem estoque e cupom. Para cancelar um pedido pago, devolva o dinheiro primeiro no Mercado Pago.

## 10. Produtos esgotados e "Me avise quando voltar"
Um perfume aparece como **Esgotado** quando o campo **Estoque** (Painel → Produtos) está em **0**. Se o campo estiver vazio, o estoque não é controlado e o perfume nunca esgota. Esgotado, ele ganha o selo, o botão "Comprar" some, aparece "Me avise quando voltar" e o checkout não deixa comprar. Quando você coloca estoque de novo, cada pessoa que pediu aviso recebe **um único e-mail** automaticamente.

1. **Banco:** SQL Editor → cole `supabase/007_esgotados_avise_me.sql` → Run. Se aparecer aviso sobre `pg_net` ou `pg_cron`, ative essas duas em **Database → Extensions** e rode o arquivo de novo.
2. **Função:** Edge Functions → `smooth-task` → cole `supabase/functions/loja/COPIAR-PARA-O-SUPABASE.txt` → Deploy.
3. **Serviço de e-mail (Resend):** crie a conta em resend.com → **Domains → Add domain** → `korboly.com.br`. Ele mostra alguns registros de DNS: copie cada um em **Hostinger → Domínios → korboly.com.br → DNS / Nameservers** e depois clique em **Verify** no Resend.
4. Resend → **API Keys → Create API key** (permissão "Sending access"). No Supabase, crie o segredo `RESEND_API_KEY` com ela.
5. Opcional: segredo `EMAIL_FROM` para trocar o remetente (padrão: `Korboly <avisos@korboly.com.br>`).
6. Rode o `enviar.bat`.
7. **Painel → Avise-me:** mostra quem está esperando cada perfume, os e-mails, o histórico de envios e se o e-mail está configurado. "Excluir" apaga um cadastro quando o cliente pedir.

Enquanto o `RESEND_API_KEY` não existir, os pedidos de aviso ficam guardados e são enviados assim que ele for configurado (automático a cada 15 minutos, ou pelo botão "Enviar avisos pendentes agora").

## Onde cada coisa fica
- Site: `index.html` · Conta do cliente: `conta.html` · Painel: `admin/index.html` · FAQ: `faq.html` · Política: `privacidade.html`
- Calculadora de frete: `js/frete.js` · Carrinho: `js/cart.js` · Checkout: `checkout.html` · Retorno do pagamento: `pedido.html`
- Servidor da loja (frete + pagamento + avisos por e-mail): `supabase/functions/loja/index.ts`
- Esgotados e "Me avise": `js/estoque.js` · Imagens dos e-mails: `img/email/`
- Aviso de cookies: `js/consent.js` · Pop-up de primeira compra: `js/welcome.js`
- Segurança: `supabase/schema.sql` (regras RLS, funções, bloqueio de admin)
- Variáveis: só em `js/config.js` (URL + chave anon, ambas públicas por desenho). Senhas e chaves secretas **nunca** vão para o GitHub.

## O que ainda NÃO existe
- E-mails de confirmação de pedido, de código de rastreio e do cupom (o envio de e-mail já existe, por enquanto só para o aviso de volta ao estoque). Hoje o cliente acompanha o pedido em "Minha conta".
- Compra da etiqueta de frete pelo painel: a etiqueta é comprada no site do Melhor Envio, e o código de rastreio é colado em Painel → Pedidos.
