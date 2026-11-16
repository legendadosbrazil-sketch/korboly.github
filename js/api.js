/* Korboly — acesso leve ao Supabase para as páginas públicas (sem carregar a biblioteca completa).
   Usa só a chave publicável: tudo o que ela alcança é limitado pelas regras (RLS) do banco. */
(function () {
  var c = window.KORBOLY || {};
  var base = String(c.SUPABASE_URL || '').replace(/\/+$/, '');
  var ok = /^https:\/\//.test(base) && String(c.SUPABASE_ANON_KEY || '').length > 40;

  function req(path, opt) {
    if (!ok) return Promise.reject(Object.assign(new Error('Serviço não configurado.'), { code: 'nao_configurado' }));
    opt = opt || {};
    var ctl = 'AbortController' in window ? new AbortController() : null;
    var t = ctl && setTimeout(function () { ctl.abort(); }, opt.timeout || 10000);
    return fetch(base + path, {
      method: opt.method || 'GET',
      headers: { apikey: c.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      signal: ctl ? ctl.signal : undefined,
      credentials: 'omit'
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var err = new Error((data && (data.message || data.msg)) || 'Erro ' + r.status);
          err.status = r.status; err.code = data && data.code;
          throw err;
        }
        return data;
      });
    }).finally(function () { if (t) clearTimeout(t); });
  }

  var cache = {};
  function once(key, fn) { return cache[key] || (cache[key] = fn().catch(function (e) { delete cache[key]; throw e; })); }

  window.KBAPI = {
    ok: ok,
    get: function (path) { return req('/rest/v1/' + path); },
    rpc: function (fn, args) { return req('/rest/v1/rpc/' + fn, { method: 'POST', body: args || {} }); },
    /* configurações públicas do site (pop-up, versão do consentimento) */
    settings: function () {
      return once('settings', function () {
        return req('/rest/v1/site_settings?select=popup_enabled,popup_delay_seconds,popup_redisplay_days,welcome_discount_percent,welcome_coupon_valid_days,consent_version&id=eq.1')
          .then(function (rows) { return (rows && rows[0]) || null; });
      });
    },
    /* dados da empresa usados nos textos ({{email}}, {{empresa}}...) */
    tokens: function () {
      return once('tokens', function () {
        return req('/rest/v1/site_content?select=key,value&key=in.(contact_email,whatsapp,company_name,company_cnpj,company_address,dpo_name)')
          .then(function (rows) {
            var m = {}, map = { contact_email: 'email', whatsapp: 'whatsapp', company_name: 'empresa', company_cnpj: 'cnpj', company_address: 'endereco', dpo_name: 'encarregado' };
            (rows || []).forEach(function (r) { if (map[r.key]) m[map[r.key]] = (r.value || '').trim(); });
            return m;
          });
      });
    }
  };
})();
