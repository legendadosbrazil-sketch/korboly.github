/* Korboly — oferta de primeira compra (pop-up de boas-vindas)
   Aparece só em páginas com <body data-welcome>, depois de alguns segundos de navegação,
   nunca junto com o aviso de cookies e nunca de novo para quem já se cadastrou.
   A frequência, o atraso e o desconto são definidos em Admin › Marketing. */
(function () {
  if (!document.body || !document.body.hasAttribute('data-welcome') || !window.KBAPI || !window.KBAPI.ok) return;
  var KEY = 'kb_welcome', DAY = 864e5, st = read();
  if (st && st.s === 'subscribed') return;

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

  var cfg, box, lastFocus, timer;

  window.KBAPI.settings().then(function (s) {
    if (!s || !s.popup_enabled) return;
    cfg = s;
    if (st && st.s === 'dismissed' && Date.now() - (st.at || 0) < s.popup_redisplay_days * DAY) return;
    var consent = window.KorbolyConsent;
    var go = function () { countdown(s.popup_delay_seconds); };
    if (!consent) return go();
    consent.ready.then(function () {
      if (consent.decided()) go();
      else document.addEventListener('korboly:consent', function h() { document.removeEventListener('korboly:consent', h); go(); });
    });
  }).catch(function () { /* sem conexão: não mostra nada */ });

  /* conta só o tempo em que a página está visível */
  function countdown(sec) {
    var left = Math.max(3, sec | 0);
    timer = setInterval(function () {
      if (document.hidden) return;
      if (--left > 0) return;
      if (busy()) { left = 4; return; }
      clearInterval(timer); open();
    }, 1000);
  }
  function busy() {
    var d = document.getElementById('detail');
    return document.documentElement.classList.contains('kb-lock') ||
      (d && getComputedStyle(d).visibility === 'visible') ||
      !!document.querySelector('.kbc:not([hidden])');
  }

  function open() {
    lastFocus = document.activeElement;
    var p = cfg.welcome_discount_percent;
    var tpl = document.createElement('div');
    tpl.innerHTML =
      '<div class="kbw" role="dialog" aria-modal="true" aria-labelledby="kbw-t" aria-describedby="kbw-d">' +
        '<div class="kbw-card">' +
          '<div class="kbw-art" aria-hidden="true"><img src="img/boasvindas.webp" alt="" width="720" height="960" decoding="async"><img class="kbw-logo" src="img/logo-inv.svg" alt="" width="715" height="160"></div>' +
          '<div class="kbw-body">' +
            '<button type="button" class="kbw-x" data-w="close" aria-label="Fechar oferta"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.3"/></svg></button>' +
            '<div class="kbw-pane" id="kbw-p1">' +
              '<p class="kbw-k">Primeira compra</p>' +
              '<h2 id="kbw-t">Um presente para sua primeira experiência Korboly.</h2>' +
              '<p id="kbw-d" class="kbw-d">Cadastre seu e-mail e receba <b>' + p + '% OFF</b> na sua primeira compra.</p>' +
              '<form class="kbw-f" novalidate>' +
                '<label class="kbw-l" for="kbw-e">E-mail</label>' +
                '<input id="kbw-e" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" required aria-describedby="kbw-m" placeholder="seu@email.com">' +
                '<label class="kbw-c"><input type="checkbox" name="mk"><span>Quero receber novidades e ofertas da Korboly por e-mail. Posso cancelar quando quiser.</span></label>' +
                '<p class="kbw-m" id="kbw-m" role="alert"></p>' +
                '<button type="submit" class="kbw-btn">Quero meu desconto</button>' +
                '<p class="kbw-s">Usamos seu e-mail para gerar e validar o cupom. Ofertas por e-mail, só se você marcar a opção acima. <a href="privacidade.html">Política de Privacidade</a>.</p>' +
              '</form>' +
              '<button type="button" class="kbw-no" data-w="close">Agora não</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    box = tpl.firstChild;
    document.body.appendChild(box);
    document.documentElement.classList.add('kb-lock');
    requestAnimationFrame(function () { box.classList.add('on'); setTimeout(function () { var i = box.querySelector('#kbw-e'); if (i) i.focus(); }, 380); });

    box.addEventListener('click', function (e) {
      if (e.target === box) return close(true);
      var b = e.target.closest('[data-w]'); if (!b) return;
      if (b.dataset.w === 'close') close(true);
      if (b.dataset.w === 'done') close(false);
      if (b.dataset.w === 'copy') copy(b);
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); return close(true); }
      if (e.key !== 'Tab') return;
      var f = [].filter.call(box.querySelectorAll('button,a[href],input'), function (x) { return x.offsetParent !== null && !x.disabled; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    box.querySelector('form').addEventListener('submit', submit);
  }

  function msg(t) { var m = box.querySelector('#kbw-m'); m.textContent = t || ''; }
  function submit(e) {
    e.preventDefault();
    var f = e.target, inp = f.email, btn = f.querySelector('.kbw-btn');
    var email = inp.value.trim().toLowerCase();
    inp.removeAttribute('aria-invalid');
    if (!email) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); return msg('Informe seu e-mail.'); }
    if (email.length > 254 || !EMAIL.test(email)) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); return msg('Esse e-mail não parece válido. Confira e tente de novo.'); }
    msg(''); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Gerando seu cupom…';
    window.KBAPI.rpc('claim_welcome_coupon', { p_email: email, p_marketing: !!f.mk.checked })
      .then(function (r) {
        write({ s: 'subscribed', at: Date.now() });
        success(r, email);
      })
      .catch(function (err) {
        btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = 'Quero meu desconto';
        var t = err && err.message;
        msg(err && (err.code === '22023' || err.code === 'P0001') && t ? t : 'Não foi possível gerar o cupom agora. Tente de novo em instantes.');
      });
  }

  function success(r, email) {
    var exp = r.expires_at ? new Date(r.expires_at).toLocaleDateString('pt-BR') : null;
    var pane = box.querySelector('#kbw-p1');
    pane.innerHTML =
      '<p class="kbw-k">Seu presente</p>' +
      '<h2 id="kbw-t" tabindex="-1">Seu cupom está pronto.</h2>' +
      '<p class="kbw-d" id="kbw-d">Use o código abaixo ao finalizar sua primeira compra.</p>' +
      '<div class="kbw-code"><span id="kbw-code">' + esc(r.code) + '</span><button type="button" class="kbw-cp" data-w="copy" aria-describedby="kbw-code">Copiar</button></div>' +
      '<ul class="kbw-rules">' +
        '<li>' + esc(r.percent) + '% de desconto na primeira compra feita com <b>' + esc(email) + '</b>.</li>' +
        '<li>Uso único' + (exp ? ', válido até ' + exp : '') + '.</li>' +
      '</ul>' +
      '<p class="kbw-live" role="status" aria-live="polite"></p>' +
      '<button type="button" class="kbw-btn" data-w="done">Continuar navegando</button>';
    pane.querySelector('#kbw-t').focus();
  }

  function copy(b) {
    var code = box.querySelector('#kbw-code').textContent, live = box.querySelector('.kbw-live');
    var done = function () { b.textContent = 'Copiado'; live.textContent = 'Código copiado.'; setTimeout(function () { b.textContent = 'Copiar'; }, 2200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, fallback); else fallback();
    function fallback() {
      var r = document.createRange(); r.selectNodeContents(box.querySelector('#kbw-code'));
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      try { document.execCommand('copy'); done(); } catch (e) { live.textContent = 'Selecione o código e copie.'; }
    }
  }

  function close(dismissed) {
    if (!box) return;
    if (dismissed && !(read() && read().s === 'subscribed')) write({ s: 'dismissed', at: Date.now() });
    box.classList.remove('on');
    document.documentElement.classList.remove('kb-lock');
    var b = box; box = null;
    setTimeout(function () { b.remove(); }, 320);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
})();
