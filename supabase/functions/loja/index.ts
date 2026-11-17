// KORBOLY · Função da loja (Supabase Edge Function)
// Faz três coisas, sem expor nenhuma chave no navegador:
//   1. Cota o frete no Melhor Envio (calculadora do site)
//   2. Cria o pedido e o link de pagamento do Mercado Pago (Checkout Pro)
//   3. Recebe os avisos de pagamento do Mercado Pago e atualiza o pedido
//
// Segredos (Supabase > Edge Functions > Secrets):
//   MELHOR_ENVIO_TOKEN   obrigatório para o frete
//   MP_ACCESS_TOKEN      obrigatório para o pagamento (Access Token de PRODUÇÃO do Mercado Pago)
//   MP_WEBHOOK_SECRET    opcional: assinatura secreta dos Webhooks (Suas integrações > Webhooks)
//   SITE_URL             opcional: padrão https://korboly.com.br
//   MELHOR_ENVIO_SANDBOX=1 / MELHOR_ENVIO_EMAIL   opcionais

type Env = Record<string, string | undefined>;
type Item = { slug: string; qty: number };

const ORIGINS = ['https://korboly.com.br', 'https://www.korboly.com.br', 'https://legendadosbrazil-sketch.github.io'];
const hits = new Map<string, number[]>();

class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) { super(String(body.error || 'erro')); this.status = status; this.body = body; }
}

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('origin') || '';
  const ok = ORIGINS.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok
    ? {
        'Access-Control-Allow-Origin': o,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
}

function out(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) },
  });
}

function limited(key: string, max: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

function svcHeaders(env: Env): Record<string, string> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const h: Record<string, string> = { apikey: key, Accept: 'application/json', 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  return h;
}

async function db(env: Env, f: typeof fetch, path: string): Promise<any[]> {
  const r = await f(env.SUPABASE_URL + '/rest/v1/' + path, { headers: svcHeaders(env) });
  if (!r.ok) throw new Error('db ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return await r.json();
}

async function svcRpc(env: Env, f: typeof fetch, fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await f(env.SUPABASE_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: svcHeaders(env), body: JSON.stringify(args) });
  const txt = await r.text();
  if (!r.ok) throw new Error('rpc ' + fn + ' ' + r.status + ' ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

// chave pública que o próprio site enviou (publishable/anon): usada para agir "como o cliente"
function publicKey(req: Request, env: Env): string {
  return req.headers.get('apikey') || env.SUPABASE_ANON_KEY || '';
}

async function currentUser(req: Request, env: Env, f: typeof fetch): Promise<{ id: string; email: string } | null> {
  const a = req.headers.get('authorization') || '';
  if (!/^Bearer\s+[\w-]+\.[\w-]+\.[\w-]+$/.test(a)) return null;
  try {
    const r = await f(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: publicKey(req, env), Authorization: a } });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: String(u.id), email: String(u.email || '') } : null;
  } catch { return null; }
}

async function isAdmin(req: Request, env: Env, f: typeof fetch): Promise<boolean> {
  const a = req.headers.get('authorization') || '';
  if (!/^Bearer\s+[\w-]+\.[\w-]+\.[\w-]+$/.test(a)) return false;
  try {
    const r = await f(env.SUPABASE_URL + '/rest/v1/rpc/is_admin', {
      method: 'POST',
      headers: { apikey: publicKey(req, env), Authorization: a, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return r.ok && (await r.json()) === true;
  } catch { return false; }
}

function parseItems(raw: unknown): Item[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  const items: Item[] = [];
  for (const it of list.slice(0, 10)) {
    const slug = String(it?.slug ?? '');
    const qty = Math.trunc(Number(it?.qty ?? 1));
    if (!/^[a-z0-9-]{1,60}$/.test(slug) || !(qty >= 1 && qty <= 10)) throw new HttpError(400, { error: 'Produto inválido.' });
    const same = items.find((x) => x.slug === slug);
    if (same) same.qty = Math.min(10, same.qty + qty); else items.push({ slug, qty });
  }
  if (!items.length) throw new HttpError(400, { error: 'Nenhum produto informado.' });
  return items;
}

function cpfOk(c: string): boolean {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    const d = ((s * 10) % 11) % 10;
    if (d !== Number(c[n])) return false;
  }
  return true;
}

const unavailable = (detalhe: string) => new HttpError(503, { error: 'Cálculo de frete indisponível no momento.', detalhe });

// ---------------------------------------------------------------- frete
async function quote(env: Env, f: typeof fetch, cep: string, items: Item[], opts: { teste?: boolean }) {
  let settings: any, config: any, products: any[], contact = '';
  try {
    [settings] = await db(env, f, 'site_settings?select=*&id=eq.1');
    [config] = await db(env, f, 'shipping_config?select=origin_cep,services&id=eq.1');
    const list = items.map((i) => i.slug).join(',');
    products = await db(env, f, 'products?select=id,slug,name,description,images,price_cents,available,ship_weight_g,ship_height_cm,ship_width_cm,ship_length_cm&slug=in.(' + list + ')');
    const c = await db(env, f, 'site_content?select=value&key=eq.contact_email');
    contact = String(c?.[0]?.value || '').trim();
  } catch (e) {
    console.error(e);
    throw unavailable('Falha ao ler as configurações no banco.');
  }
  if (!settings?.ship_enabled && !opts.teste) throw unavailable('O cálculo de frete está desligado no painel.');
  if (!config?.origin_cep) throw unavailable('Falta o CEP de origem no painel.');
  if (!env.MELHOR_ENVIO_TOKEN) throw unavailable('Falta o token do Melhor Envio nos segredos da função.');

  const lines = [];
  for (const it of items) {
    const p = products.find((x) => x.slug === it.slug);
    if (!p || !p.available) throw new HttpError(400, { error: 'Produto indisponível.' });
    if (!p.ship_weight_g || !p.ship_height_cm || !p.ship_width_cm || !p.ship_length_cm)
      throw unavailable('Faltam peso e medidas do produto "' + p.name + '" no painel.');
    lines.push({
      id: p.slug,
      width: Number(p.ship_width_cm),
      height: Number(p.ship_height_cm),
      length: Number(p.ship_length_cm),
      weight: p.ship_weight_g / 1000,
      insurance_value: Math.round(p.price_cents) / 100,
      quantity: it.qty,
    });
  }

  const base = env.MELHOR_ENVIO_URL || (env.MELHOR_ENVIO_SANDBOX === '1' ? 'https://sandbox.melhorenvio.com.br' : 'https://www.melhorenvio.com.br');
  const email = contact || env.MELHOR_ENVIO_EMAIL || '';
  const payload: any = { from: { postal_code: config.origin_cep }, to: { postal_code: cep }, products: lines, options: { receipt: false, own_hand: false } };
  if (config.services) payload.services = config.services;

  let data: any;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12_000);
    const r = await f(base + '/api/v2/me/shipment/calculate', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.MELHOR_ENVIO_TOKEN,
        'User-Agent': 'Korboly' + (email ? ' (' + email + ')' : ''),
      },
      body: JSON.stringify(payload),
    });
    clearTimeout(t);
    const txt = await r.text();
    if (r.status === 401) throw unavailable('O Melhor Envio recusou o token (expirado ou sem permissão de cálculo).');
    if (r.status === 422) {
      console.error('ME 422', txt.slice(0, 500));
      let det = '';
      try {
        const j = JSON.parse(txt);
        const errs = j?.errors ? Object.entries(j.errors).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(' ') : String(v))) : [];
        det = [j?.message, ...errs].filter(Boolean).join(' | ').slice(0, 400);
      } catch { det = txt.slice(0, 200); }
      throw new HttpError(400, { error: 'Não foi possível calcular para este CEP. Confira o número.', detalhe: 'Melhor Envio: ' + det });
    }
    if (!r.ok) { console.error('ME', r.status, txt.slice(0, 500)); throw unavailable('O Melhor Envio respondeu com erro ' + r.status + '.'); }
    data = JSON.parse(txt);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error(e);
    throw unavailable('Não foi possível falar com o Melhor Envio.');
  }

  const extra = Math.max(0, Number(settings.ship_handling_days) || 0);
  const desconto = Math.min(20000, Math.max(0, Math.trunc(Number(settings.ship_discount_cents) || 0)));
  const options = (Array.isArray(data) ? data : [])
    .filter((o: any) => o && !o.error && (o.custom_price ?? o.price) != null)
    .map((o: any) => {
      const price = Number.parseFloat(String(o.custom_price ?? o.price));
      const rng = o.custom_delivery_range || o.delivery_range || {};
      const d = Number(o.custom_delivery_time ?? o.delivery_time) || 0;
      const min = (Number(rng.min) || d) + extra;
      const max = (Number(rng.max) || d) + extra;
      return {
        id: Number(o.id),
        servico: String(o.name || ''),
        transportadora: String(o.company?.name || ''),
        preco_original_centavos: Math.round(price * 100),
        preco_centavos: Math.max(0, Math.round(price * 100) - desconto),
        prazo_min: min,
        prazo_max: Math.max(min, max),
      };
    })
    .filter((o: any) => Number.isFinite(o.preco_original_centavos) && o.preco_original_centavos > 0)
    .sort((a: any, b: any) => a.preco_centavos - b.preco_centavos || a.prazo_max - b.prazo_max);

  return { options, desconto, products, settings };
}

// ---------------------------------------------------------------- pagamento
function mpItems(items: any[], discount: number, site: string, products: any[]) {
  const sub = items.reduce((a, i) => a + i.unit_price_cents * i.quantity, 0);
  let left = discount;
  const out: any[] = [];
  items.forEach((it, idx) => {
    const line = it.unit_price_cents * it.quantity;
    const share = idx === items.length - 1 ? left : Math.min(left, Math.floor((discount * line) / Math.max(sub, 1)));
    left -= share;
    const net = line - share;
    const p = products.find((x) => x.id === it.product_id) || {};
    const img = Array.isArray(p.images) && p.images[0] ? String(p.images[0]) : '';
    const base = {
      id: String(p.slug || it.product_id || 'item'),
      title: String(it.product_name).slice(0, 120),
      description: String(p.description || it.product_name).slice(0, 250),
      picture_url: img ? (/^https?:\/\//.test(img) ? img : site + '/' + img.replace(/^\/+/, '')) : undefined,
      currency_id: 'BRL',
    };
    const unit = Math.floor(net / it.quantity);
    const rest = net - unit * it.quantity;
    if (rest === 0) { if (unit > 0) out.push({ ...base, quantity: it.quantity, unit_price: unit / 100 }); }
    else {
      if (it.quantity > 1 && unit > 0) out.push({ ...base, quantity: it.quantity - 1, unit_price: unit / 100 });
      out.push({ ...base, quantity: 1, unit_price: (unit + rest) / 100 });
    }
  });
  return out;
}

async function checkout(req: Request, env: Env, f: typeof fetch, body: any): Promise<Response> {
  if (!env.MP_ACCESS_TOKEN) throw new HttpError(503, { error: 'Pagamento indisponível no momento.', detalhe: 'Falta o MP_ACCESS_TOKEN nos segredos da função.' });
  const user = await currentUser(req, env, f);
  if (!user) throw new HttpError(401, { error: 'Entre na sua conta para finalizar a compra.' });
  if (limited('co:' + user.id, Number(env.CHECKOUT_LIMIT) || 12)) throw new HttpError(429, { error: 'Muitas tentativas seguidas. Aguarde um minuto.' });

  const items = parseItems(body?.items);
  const a = body?.address || {};
  const s = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const address = {
    recipient: s(a.recipient, 120), zip: s(a.zip, 9).replace(/\D/g, ''), street: s(a.street, 160), number: s(a.number, 20),
    complement: s(a.complement, 80), district: s(a.district, 80), city: s(a.city, 80), state: s(a.state, 2).toUpperCase(),
  };
  if (!address.recipient || address.recipient.split(/\s+/).length < 2) throw new HttpError(400, { error: 'Informe o nome completo de quem vai receber.' });
  if (!/^\d{8}$/.test(address.zip) || !address.street || !address.number || !address.district || !address.city || !/^[A-Z]{2}$/.test(address.state))
    throw new HttpError(400, { error: 'Endereço incompleto. Confira CEP, rua, número, bairro, cidade e estado.' });
  const cpf = String(body?.cpf ?? '').replace(/\D/g, '');
  if (!cpfOk(cpf)) throw new HttpError(400, { error: 'CPF inválido.' });
  const phone = String(body?.phone ?? '').replace(/\D/g, '');
  if (!/^\d{10,11}$/.test(phone)) throw new HttpError(400, { error: 'Informe um celular com DDD.' });
  const serviceId = Math.trunc(Number(body?.servico_id));
  const coupon = s(body?.coupon, 40);

  // frete calculado de novo aqui: o valor nunca vem do navegador
  const q = await quote(env, f, address.zip, items, {});
  const opt = q.options.find((o) => o.id === serviceId);
  if (!opt) throw new HttpError(409, { error: 'A opção de frete escolhida não está mais disponível. Calcule o frete de novo.' });

  // pedidos antigos sem pagamento deste cliente: cancela e libera cupom e estoque
  await svcRpc(env, f, '_checkout_cleanup', { p_user: user.id });

  // cria o pedido "como o cliente" (regras de preço, estoque e cupom ficam no banco)
  const pItems = items.map((i) => ({ product_id: q.products.find((p) => p.slug === i.slug)!.id, quantity: i.qty }));
  const cr = await f(env.SUPABASE_URL + '/rest/v1/rpc/create_order', {
    method: 'POST',
    headers: { apikey: publicKey(req, env), Authorization: req.headers.get('authorization')!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_items: pItems, p_address: address, p_coupon: coupon || null }),
  });
  const crt = await cr.text();
  if (!cr.ok) {
    let m = 'Não foi possível criar o pedido.';
    try { const j = JSON.parse(crt); if (j?.message && /^[A-ZÀ-Ú]/.test(j.message) && j.message.length < 160) m = j.message; } catch { /* */ }
    throw new HttpError(400, { error: m });
  }
  const number = Number(crt);
  const [order] = await db(env, f, 'orders?select=id,number,subtotal_cents,discount_cents,customer_email&number=eq.' + number);
  if (!order) throw new HttpError(500, { error: 'Pedido não encontrado após a criação.' });

  try {
    const fin = await svcRpc(env, f, '_checkout_finalize', {
      p_order: order.id, p_shipping_cents: opt.preco_centavos, p_shipping_original_cents: opt.preco_original_centavos,
      p_service: opt.servico + (opt.transportadora ? ' · ' + opt.transportadora : ''), p_service_id: opt.id, p_cpf: cpf, p_phone: phone,
    });
    const oItems = await db(env, f, 'order_items?select=product_id,product_name,unit_price_cents,quantity&order_id=eq.' + order.id);
    const site = (env.SITE_URL || 'https://korboly.com.br').replace(/\/+$/, '');
    const fnName = env.LOJA_FUNCTION_NAME || new URL(req.url).pathname.split('/').filter(Boolean).pop() || 'loja';
    const notify = (env.LOJA_URL || env.SUPABASE_URL + '/functions/v1/' + fnName) + '?mp=1';
    const parts = address.recipient.split(/\s+/);
    const pref: any = {
      items: mpItems(oItems, order.discount_cents, site, q.products),
      payer: {
        name: parts[0], surname: parts.slice(1).join(' '), email: user.email,
        phone: { area_code: phone.slice(0, 2), number: phone.slice(2) },
        identification: { type: 'CPF', number: cpf },
        address: { zip_code: address.zip, street_name: address.street, street_number: address.number },
      },
      shipments: {
        mode: 'not_specified', cost: opt.preco_centavos / 100,
        receiver_address: { zip_code: address.zip, street_name: address.street, street_number: address.number, apartment: address.complement || undefined, city_name: address.city, state_name: address.state },
      },
      back_urls: { success: site + '/pedido.html?n=' + number, pending: site + '/pedido.html?n=' + number, failure: site + '/pedido.html?n=' + number },
      auto_return: 'approved',
      external_reference: order.id,
      notification_url: notify,
      statement_descriptor: 'KORBOLY',
      metadata: { pedido: number },
    };
    if (!pref.items.length) throw new HttpError(400, { error: 'Valor do pedido inválido.' });
    const r = await f('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Idempotency-Key': order.id },
      body: JSON.stringify(pref),
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error('MP pref', r.status, txt.slice(0, 600));
      throw new HttpError(502, { error: 'O Mercado Pago não aceitou o pedido agora. Tente de novo em instantes.', detalhe: 'Mercado Pago ' + r.status + ': ' + txt.slice(0, 200) });
    }
    const j = JSON.parse(txt);
    await svcRpc(env, f, '_order_set_preference', { p_order: order.id, p_pref: String(j.id || ''), p_init: String(j.init_point || '') });
    return out(req, 200, { pedido: number, total_centavos: fin?.total_cents, pagar_em: j.init_point });
  } catch (e) {
    try { await svcRpc(env, f, '_order_cancel', { p_order: order.id }); } catch (x) { console.error(x); }
    throw e;
  }
}

async function applyPayment(env: Env, f: typeof fetch, paymentId: string, mustBelongTo?: string): Promise<string> {
  if (!/^\d{1,20}$/.test(paymentId)) throw new HttpError(400, { error: 'Pagamento inválido.' });
  const r = await f('https://api.mercadopago.com/v1/payments/' + paymentId, { headers: { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN } });
  if (r.status === 404) return 'nao_encontrado';
  if (!r.ok) throw new Error('MP payment ' + r.status);
  const p = await r.json();
  const ref = String(p.external_reference || '');
  if (!/^[0-9a-f-]{36}$/.test(ref)) return 'sem_pedido';
  if (mustBelongTo) {
    const [o] = await db(env, f, 'orders?select=user_id&id=eq.' + ref);
    if (!o || o.user_id !== mustBelongTo) throw new HttpError(403, { error: 'Pedido de outra conta.' });
  }
  return await svcRpc(env, f, '_order_payment', {
    p_order: ref, p_payment_id: String(p.id), p_status: String(p.status || ''),
    p_amount_cents: Math.round(Number(p.transaction_amount || 0) * 100), p_method: String(p.payment_type_id || p.payment_method_id || ''),
  });
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function webhook(req: Request, env: Env, f: typeof fetch, raw: string): Promise<Response> {
  const u = new URL(req.url);
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* aviso sem JSON */ }
  const type = u.searchParams.get('type') || u.searchParams.get('topic') || body?.type || body?.topic || '';
  const id = String(u.searchParams.get('data.id') || u.searchParams.get('id') || body?.data?.id || '');
  if (type !== 'payment' || !id) return out(req, 200, { ok: true, ignorado: true });

  const sig = req.headers.get('x-signature');
  if (env.MP_WEBHOOK_SECRET && sig) {
    const ts = /ts=([^,]+)/.exec(sig)?.[1] || '';
    const v1 = /v1=([^,]+)/.exec(sig)?.[1] || '';
    const dataId = u.searchParams.get('data.id') ? id.toLowerCase() : id;
    const manifest = 'id:' + dataId + ';request-id:' + (req.headers.get('x-request-id') || '') + ';ts:' + ts + ';';
    if (!ts || (await hmacHex(env.MP_WEBHOOK_SECRET, manifest)) !== v1) return out(req, 401, { error: 'assinatura inválida' });
  }
  if (!env.MP_ACCESS_TOKEN) return out(req, 503, { error: 'sem token' });
  try {
    const st = await applyPayment(env, f, id);
    return out(req, 200, { ok: true, status: st });
  } catch (e) {
    console.error('webhook', e);
    return out(req, 500, { error: 'falha temporária' }); // o Mercado Pago tenta de novo
  }
}

// ---------------------------------------------------------------- entrada
export async function handle(req: Request, env: Env, f: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return out(req, 405, { error: 'Método não permitido.' });
  const u = new URL(req.url);
  const raw = await req.text();
  if (u.searchParams.get('mp') === '1' || u.searchParams.has('topic') || (u.searchParams.has('type') && u.searchParams.has('data.id'))) {
    return webhook(req, env, f, raw);
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  if (limited('ip:' + ip, 30)) return out(req, 429, { error: 'Muitas consultas seguidas. Aguarde um minuto e tente de novo.' });

  let body: any;
  try { body = JSON.parse(raw || 'null'); } catch { return out(req, 400, { error: 'Pedido inválido.' }); }
  if (!body || typeof body !== 'object') return out(req, 400, { error: 'Pedido inválido.' });
  if (body.type === 'payment' && body.data?.id) return webhook(req, env, f, raw);

  try {
    if (body.action === 'checkout') return await checkout(req, env, f, body);
    if (body.action === 'diagnostico') {
      if (!(await isAdmin(req, env, f))) throw new HttpError(403, { error: 'Só administradores.' });
      if (!env.MP_ACCESS_TOKEN) throw new HttpError(503, { error: 'Falta o MP_ACCESS_TOKEN nos segredos da função.' });
      const h = { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN };
      const [pm, me] = await Promise.all([
        f('https://api.mercadopago.com/v1/payment_methods', { headers: h }),
        f('https://api.mercadopago.com/users/me', { headers: h }),
      ]);
      if (pm.status === 401 || me.status === 401) throw new HttpError(400, { error: 'O Mercado Pago recusou o MP_ACCESS_TOKEN. Copie de novo o Access Token de PRODUÇÃO.' });
      const list = pm.ok ? await pm.json() : [];
      const u = me.ok ? await me.json() : {};
      return out(req, 200, {
        conta: {
          id: u.id, apelido: u.nickname, tipo: u.user_type, situacao: u.status?.site_status,
          vender: u.status?.sell?.allow, motivos_venda: u.status?.sell?.codes, etiquetas: u.tags,
        },
        meios: (Array.isArray(list) ? list : []).map((m: any) => ({
          id: m.id, nome: m.name, tipo: m.payment_type_id, status: m.status,
          minimo: m.min_allowed_amount, maximo: m.max_allowed_amount,
        })),
      });
    }
    if (body.action === 'sincronizar') {
      const user = await currentUser(req, env, f);
      if (!user) throw new HttpError(401, { error: 'Entre na sua conta.' });
      if (!env.MP_ACCESS_TOKEN) throw new HttpError(503, { error: 'Pagamento indisponível.' });
      const st = await applyPayment(env, f, String(body.payment_id ?? ''), user.id);
      return out(req, 200, { status: st });
    }
    // padrão: cotação de frete
    const cep = String(body.cep ?? '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(cep) || /^0{8}$/.test(cep)) throw new HttpError(400, { error: 'Informe um CEP válido, com 8 números.' });
    const items = parseItems(body.items);
    const teste = body.teste === true && (await isAdmin(req, env, f));
    const q = await quote(env, f, cep, items, { teste });
    if (!q.options.length) return out(req, 200, { cep, opcoes: [], aviso: 'Nenhuma opção de entrega disponível para este CEP.' });
    return out(req, 200, { cep, opcoes: q.options, desconto_centavos: q.desconto });
  } catch (e) {
    if (e instanceof HttpError) return out(req, e.status, e.body);
    console.error(e);
    return out(req, 500, { error: 'Erro inesperado. Tente de novo.' });
  }
}

const D = (globalThis as any).Deno;
if (D?.serve) D.serve((req: Request) => handle(req, D.env.toObject()));
