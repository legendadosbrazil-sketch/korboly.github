// KORBOLY · Função "frete" (Supabase Edge Function)
// Calcula o frete no Melhor Envio sem expor o token no navegador.
// Segredo obrigatório no Supabase: MELHOR_ENVIO_TOKEN
// Opcionais: MELHOR_ENVIO_SANDBOX=1 (testes), MELHOR_ENVIO_EMAIL (contato técnico, se o e-mail de contato do site estiver vazio)

type Env = Record<string, string | undefined>;
type Item = { slug: string; qty: number };

const ORIGINS = [
  'https://korboly.com.br',
  'https://www.korboly.com.br',
  'https://legendadosbrazil-sketch.github.io',
];
const hits = new Map<string, number[]>();

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

function limited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 20;
}

async function db(env: Env, f: typeof fetch, path: string): Promise<any[]> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const h: Record<string, string> = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  const r = await f(env.SUPABASE_URL + '/rest/v1/' + path, { headers: h });
  if (!r.ok) throw new Error('db ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return await r.json();
}

// Teste pelo painel: permitido com a calculadora desligada, só para administradores
async function isAdmin(req: Request, env: Env, f: typeof fetch): Promise<boolean> {
  const a = req.headers.get('authorization') || '';
  if (!/^Bearer\s+[\w-]+\.[\w-]+\.[\w-]+$/.test(a)) return false;
  try {
    const r = await f(env.SUPABASE_URL + '/rest/v1/rpc/is_admin', {
      method: 'POST',
      headers: { apikey: env.SUPABASE_ANON_KEY || '', Authorization: a, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return r.ok && (await r.json()) === true;
  } catch { return false; }
}

export async function handle(req: Request, env: Env, f: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return out(req, 405, { error: 'Método não permitido.' });

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  if (limited(ip)) return out(req, 429, { error: 'Muitas consultas seguidas. Aguarde um minuto e tente de novo.' });

  let body: any;
  try { body = await req.json(); } catch { return out(req, 400, { error: 'Pedido inválido.' }); }
  const cep = String(body?.cep ?? '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(cep) || /^0{8}$/.test(cep)) return out(req, 400, { error: 'Informe um CEP válido, com 8 números.' });
  const raw: any[] = Array.isArray(body?.items) ? body.items : [];
  const items: Item[] = [];
  for (const it of raw.slice(0, 10)) {
    const slug = String(it?.slug ?? '');
    const qty = Math.trunc(Number(it?.qty ?? 1));
    if (!/^[a-z0-9-]{1,60}$/.test(slug) || !(qty >= 1 && qty <= 10)) return out(req, 400, { error: 'Produto inválido.' });
    const same = items.find((x) => x.slug === slug);
    if (same) same.qty = Math.min(10, same.qty + qty); else items.push({ slug, qty });
  }
  if (!items.length) return out(req, 400, { error: 'Nenhum produto informado.' });

  const fail = (detalhe: string) => out(req, 503, { error: 'Cálculo de frete indisponível no momento.', detalhe });
  let settings: any, config: any, products: any[], contact = '';
  try {
    [settings] = await db(env, f, 'site_settings?select=*&id=eq.1');
    [config] = await db(env, f, 'shipping_config?select=origin_cep,services&id=eq.1');
    const list = items.map((i) => i.slug).join(',');
    products = await db(env, f, 'products?select=slug,name,price_cents,available,ship_weight_g,ship_height_cm,ship_width_cm,ship_length_cm&slug=in.(' + list + ')');
    const c = await db(env, f, 'site_content?select=value&key=eq.contact_email');
    contact = String(c?.[0]?.value || '').trim();
  } catch (e) {
    console.error(e);
    return fail('Falha ao ler as configurações no banco.');
  }
  const teste = body?.teste === true && (await isAdmin(req, env, f));
  if (!settings?.ship_enabled && !teste) return fail('O cálculo de frete está desligado no painel.');
  if (!config?.origin_cep) return fail('Falta o CEP de origem no painel.');
  if (!env.MELHOR_ENVIO_TOKEN) return fail('Falta o token do Melhor Envio nos segredos da função.');

  const lines = [];
  for (const it of items) {
    const p = products.find((x) => x.slug === it.slug);
    if (!p || !p.available) return out(req, 400, { error: 'Produto indisponível.' });
    if (!p.ship_weight_g || !p.ship_height_cm || !p.ship_width_cm || !p.ship_length_cm)
      return fail('Faltam peso e medidas do produto "' + p.name + '" no painel.');
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
  const payload: any = {
    from: { postal_code: config.origin_cep },
    to: { postal_code: cep },
    products: lines,
    options: { receipt: false, own_hand: false },
  };
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
    if (r.status === 401) return fail('O Melhor Envio recusou o token (expirado ou sem permissão de cálculo).');
    if (r.status === 422) {
      console.error('ME 422', txt.slice(0, 500));
      let det = '';
      try {
        const j = JSON.parse(txt);
        const errs = j?.errors ? Object.entries(j.errors).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(' ') : String(v))) : [];
        det = [j?.message, ...errs].filter(Boolean).join(' | ').slice(0, 400);
      } catch { det = txt.slice(0, 200); }
      return out(req, 400, { error: 'Não foi possível calcular para este CEP. Confira o número.', detalhe: 'Melhor Envio: ' + det });
    }
    if (!r.ok) { console.error('ME', r.status, txt.slice(0, 500)); return fail('O Melhor Envio respondeu com erro ' + r.status + '.'); }
    data = JSON.parse(txt);
  } catch (e) {
    console.error(e);
    return fail('Não foi possível falar com o Melhor Envio.');
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

  if (!options.length) return out(req, 200, { cep, opcoes: [], aviso: 'Nenhuma opção de entrega disponível para este CEP.' });
  return out(req, 200, { cep, opcoes: options, desconto_centavos: desconto });
}

declare const Deno: any;
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req, Deno.env.toObject()));
