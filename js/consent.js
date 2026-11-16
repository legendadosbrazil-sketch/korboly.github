/* Korboly — consentimento de cookies (LGPD)
   - Essenciais: sempre ativos (login, escolhas de privacidade, resposta à oferta de primeira compra).
   - Analíticos e Marketing: só carregam DEPOIS do consentimento.
   Para adicionar uma ferramenta no futuro, inclua o script assim (ele fica inerte até a autorização):
     <script type="text/plain" data-consent="analytics" src="https://..."></script>
     <script type="text/plain" data-consent="marketing">/* código do pixel *\/</script>
   e liste o nome dela em TOOLS abaixo e na Política de Privacidade. */
(function () {
  var TOOLS = { analytics: [], marketing: [] };           // ferramentas em uso hoje: nenhuma
  var COOKIES = {                                          // apagados se a pessoa retirar a autorização
    analytics: ['_ga', '_gid', '_gat', '_clck', '_clsk', '_hj'],
    marketing: ['_fbp', '_fbc', '_gcl_au', '_ttp', '_tt_']
  };
  var KEY = 'kb_consent', VER = 1, cur = read(), activated = { analytics: false, marketing: false };
  var settingsP = window.KBAPI ? window.KBAPI.settings().then(function (s) { if (s && s.consent_version) VER = s.consent_version; return VER; }).catch(function () { return VER; }) : Promise.resolve(VER);

  function read() { try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function has(cat) { if (cat === 'essential') return true; return !!(cur && cur.v >= VER && cur[cat === 'analytics' ? 'a' : 'm']); }

  /* ---------- ativa o que foi autorizado ---------- */
  function apply() {
    ['analytics', 'marketing'].forEach(function (cat) {
      if (!has(cat)) return;
      [].forEach.call(document.querySelectorAll('script[type="text/plain"][data-consent="' + cat + '"]:not([data-on])'), function (s) {
        var n = document.createElement('script');
        [].forEach.call(s.attributes, function (a) { if (a.name !== 'type' && a.name !== 'data-consent') n.setAttribute(a.name, a.value); });
        if (!s.src) n.text = s.text;
        s.setAttribute('data-on', '1'); s.parentNode.insertBefore(n, s.nextSibling); activated[cat] = true;
      });
      [].forEach.call(document.querySelectorAll('[data-consent-src][data-consent="' + cat + '"]:not([data-on])'), function (el) {
        el.setAttribute('src', el.getAttribute('data-consent-src')); el.setAttribute('data-on', '1'); activated[cat] = true;
      });
    });
  }
  function wipe(cat) {
    var host = location.hostname, parts = host.split('.'), doms = ['', host];
    for (var i = 1; i < parts.length - 1; i++) doms.push('.' + parts.slice(i).join('.'));
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (!COOKIES[cat].some(function (p) { return name.indexOf(p) === 0; })) return;
      doms.forEach(function (d) { document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : ''); });
    });
  }

  /* ---------- salvar uma escolha ---------- */
  function save(a, m, action) {
    var before = cur;
    return settingsP.then(function (ver) {
      cur = { v: ver, a: !!a, m: !!m, at: new Date().toISOString(), id: (before && before.id) || uid() };
      write(cur);
      hideBanner(); closePrefs();
      var revoked = false;
      if (!cur.a) { wipe('analytics'); revoked = revoked || activated.analytics; }
      if (!cur.m) { wipe('marketing'); revoked = revoked || activated.marketing; }
      apply();
      try { document.dispatchEvent(new CustomEvent('korboly:consent', { detail: { analytics: cur.a, marketing: cur.m } })); } catch (e) {}
      if (window.KBAPI) window.KBAPI.rpc('record_cookie_consent', { p_visitor: cur.id, p_analytics: cur.a, p_marketing: cur.m, p_version: ver, p_action: action }).catch(function () {});
      toast('Preferências de cookies salvas.');
      if (revoked) setTimeout(function () { location.reload(); }, 600);   // descarrega ferramentas já carregadas
    });
  }

  /* ---------- interface ---------- */
  var banner, prefs, lastFocus, live;
  var POLICY = 'privacidade.html#cookies';
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function toast(t) {
    if (!live) { live = el('<div class="kbc-toast" role="status" aria-live="polite"></div>'); document.body.appendChild(live); }
    live.textContent = t; live.classList.add('on'); clearTimeout(live._t); live._t = setTimeout(function () { live.classList.remove('on'); }, 2600);
  }
  function showBanner(updated) {
    if (banner) { banner.hidden = false; return; }
    banner = el(
      '<section class="kbc" role="region" aria-label="Aviso de cookies">' +
        '<p class="kbc-k">Sua privacidade</p>' +
        '<p class="kbc-t">' + (updated ? 'Atualizamos nossa forma de usar cookies. ' : '') +
        'Usamos cookies essenciais para o site funcionar. Com a sua permissão, usaremos também cookies analíticos e de marketing, para entender a navegação e personalizar ofertas. ' +
        '<a href="' + POLICY + '">Política de Privacidade</a></p>' +
        '<div class="kbc-b">' +
          '<button type="button" class="kbc-btn" data-c="reject">Rejeitar opcionais</button>' +
          '<button type="button" class="kbc-btn" data-c="accept">Aceitar todos</button>' +
          '<button type="button" class="kbc-link" data-c="custom">Personalizar</button>' +
        '</div>' +
      '</section>');
    banner.addEventListener('click', function (e) {
      var b = e.target.closest('[data-c]'); if (!b) return;
      if (b.dataset.c === 'accept') save(true, true, 'aceitar_todos');
      if (b.dataset.c === 'reject') save(false, false, 'rejeitar_opcionais');
      if (b.dataset.c === 'custom') openPrefs(b);
    });
    document.body.insertBefore(banner, document.body.firstChild);
    requestAnimationFrame(function () { banner.classList.add('on'); });
  }
  function hideBanner() { if (banner) { banner.classList.remove('on'); banner.hidden = true; } }

  function row(id, title, text, on, locked, tools) {
    return '<div class="kbc-row">' +
      '<div class="kbc-rt"><label for="kbc-' + id + '">' + title + '</label>' +
      '<p id="kbc-' + id + '-d">' + text + '</p>' +
      (tools ? '<p class="kbc-u">' + (tools.length ? 'Em uso: ' + tools.join(', ') + '.' : 'No momento, a Korboly não usa nenhuma ferramenta desta categoria.') + '</p>' : '') +
      '</div>' +
      '<span class="kbc-sw"><input type="checkbox" id="kbc-' + id + '" aria-describedby="kbc-' + id + '-d"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + '><i aria-hidden="true"></i></span>' +
      (locked ? '<span class="kbc-al">Sempre ativos</span>' : '') +
    '</div>';
  }
  function openPrefs(from) {
    lastFocus = from || document.activeElement;
    if (prefs) prefs.remove();
    prefs = el(
      '<div class="kbc-ov">' +
        '<div class="kbc-dlg" role="dialog" aria-modal="true" aria-labelledby="kbc-h" aria-describedby="kbc-i">' +
          '<button type="button" class="kbc-x" data-c="close" aria-label="Fechar preferências de cookies"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.3"/></svg></button>' +
          '<p class="kbc-k">Privacidade</p>' +
          '<h2 id="kbc-h">Preferências de cookies</h2>' +
          '<p id="kbc-i" class="kbc-i">Escolha o que você autoriza. Você pode mudar isso quando quiser pelo link <b>Preferências de cookies</b>, no rodapé. <a href="' + POLICY + '">Saiba mais</a>.</p>' +
          row('ess', 'Essenciais', 'Necessários para o site funcionar: manter você conectado, lembrar suas escolhas de privacidade e se você já respondeu à oferta de primeira compra.', true, true) +
          row('ana', 'Analíticos', 'Medem visitas e navegação de forma agregada, para melhorarmos o site.', has('analytics'), false, TOOLS.analytics) +
          row('mkt', 'Marketing', 'Medem campanhas e permitem mostrar ofertas mais relevantes, inclusive em outras plataformas.', has('marketing'), false, TOOLS.marketing) +
          '<div class="kbc-b kbc-b2">' +
            '<button type="button" class="kbc-btn" data-c="reject">Rejeitar opcionais</button>' +
            '<button type="button" class="kbc-btn" data-c="save">Salvar escolhas</button>' +
            '<button type="button" class="kbc-btn" data-c="accept">Aceitar todos</button>' +
          '</div>' +
        '</div>' +
      '</div>');
    prefs.addEventListener('click', function (e) {
      if (e.target === prefs) return closePrefs(true);
      var b = e.target.closest('[data-c]'); if (!b) return;
      var c = b.dataset.c;
      if (c === 'close') closePrefs(true);
      if (c === 'accept') save(true, true, 'aceitar_todos');
      if (c === 'reject') save(false, false, 'rejeitar_opcionais');
      if (c === 'save') save(prefs.querySelector('#kbc-ana').checked, prefs.querySelector('#kbc-mkt').checked, 'personalizar');
    });
    prefs.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); return closePrefs(true); }
      if (e.key !== 'Tab') return;
      var f = [].filter.call(prefs.querySelectorAll('button,a[href],input:not([disabled])'), function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    document.body.appendChild(prefs);
    document.documentElement.classList.add('kb-lock');
    requestAnimationFrame(function () { prefs.classList.add('on'); prefs.querySelector('#kbc-ana').focus(); });
  }
  function closePrefs(restore) {
    if (!prefs) return;
    prefs.remove(); prefs = null;
    document.documentElement.classList.remove('kb-lock');
    if (restore && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------- início ---------- */
  function boot() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-cookie-prefs]');
      if (t) { e.preventDefault(); openPrefs(t); }
    });
    if (!cur) showBanner(false); else apply();
    settingsP.then(function (ver) { if (cur && (cur.v || 0) < ver) showBanner(true); });
  }

  window.KorbolyConsent = {
    has: has,
    decided: function () { return !!(cur && cur.v >= VER); },
    ready: settingsP,
    open: function () { openPrefs(document.activeElement); },
    get: function () { return cur ? { analytics: has('analytics'), marketing: has('marketing'), date: cur.at } : null; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
