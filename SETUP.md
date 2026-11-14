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

## Onde cada coisa fica
- Site: `index.html` · Conta do cliente: `conta.html` · Painel: `admin/index.html`
- Segurança: `supabase/schema.sql` (regras RLS, funções, bloqueio de admin)
- Variáveis: só em `js/config.js` (URL + chave anon, ambas públicas por desenho). Senhas e chaves secretas **nunca** vão para o GitHub.

## O que ainda NÃO existe
Carrinho, checkout e cobrança (Pix/cartão). Os pedidos e a função `create_order` já estão prontos no banco (preço calculado no servidor, cupom, baixa de estoque), mas falta a tela de compra e um provedor de pagamento (ex.: Mercado Pago), que exige sua conta.
