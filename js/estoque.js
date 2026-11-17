/* Korboly — produtos esgotados e "Me avise quando voltar".
   Lê o estoque real do banco, marca os esgotados e atualiza sozinho quando o estoque muda. */
(function () {
  if (!window.KBAPI || !window.KBAPI.ok) return;
  var STOCK = {}, NAMES = {}, loaded = false, timer;
  var d6 = document.getElementById('d6'), box = document.getElementById('oos'), frt = document.getElementById('frt');
  var btn = document.getElementById('oos-b'), form = document.getElementById('oos-f'), inp = document.getElementById('oos-e'),
      hp = document.getElementById('oos-hp'), m = document.getElementById('oos-m');
  var EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

  function isOut(slug) { var p = STOCK[slug]; return !!(p && (p.available === false || (p.stock !== null && p.stock <= 0))); }
  window.KBStock = { isOut: isOut, data: function () { return STOCK; } };

  function badge(el, out) {
    var b = el.querySelector(':scope > .kb-out');
    if (out && !b) { b = document.createElement('span'); b.className = 'kb-out'; b.textContent = 'Esgotado'; el.appendChild(b); }
    if (!out && b) b.remove();
  }
  function paint() {
    [].forEach.call(document.querySelectorAll('.pc[data-slug]'), function (a) {
      var out = isOut(a.getAttribute('data-slug')), img = a.querySelector('.pci');
      a.classList.toggle('is-out', out); if (img) badge(img, out);
      var t = a.querySelector('.pct h3'); if (t) a.setAttribute('aria-label', t.textContent + (out ? ', esgotado' : ''));
    });
    [].forEach.call(document.querySelectorAll('.pl[data-slug]'), function (pl) {
      var out = isOut(pl.getAttribute('data-slug')); pl.classList.toggle('is-out', out); badge(pl, out);
    });
    detail();
  }
  var lastSlug = '';
  function detail() {
    if (!d6 || !box) return;
    var slug = d6.getAttribute('data-slug') || '', out = loaded && isOut(slug);
    if (slug !== lastSlug) { lastSlug = slug; reset(); }
    d6.hidden = out; d6.parentNode.classList.toggle('m-off', out);
    box.hidden = !out;
    if (frt) frt.classList.toggle('frt-off', out);
  }
  function reset() {
    if (!form) return;
    form.hidden = true; btn.hidden = false; btn.setAttribute('aria-expanded', 'false');
    m.textContent = ''; m.className = 'oos-m'; inp.value = ''; inp.removeAttribute('aria-invalid');
  }

  function load() {
    return window.KBAPI.get('products?select=slug,name,stock,available,description,price_cents,volume_ml').then(function (rows) {
      var before = JSON.stringify(STOCK); STOCK = {};
      var prod = {};
      (rows || []).forEach(function (r) { STOCK[r.slug] = { stock: r.stock, available: r.available }; NAMES[r.slug] = r.name; prod[r.slug] = r; });
      var changed = JSON.stringify(prod) !== JSON.stringify(window.KBPROD || null);
      window.KBPROD = prod; loaded = true;
      if (changed) { cards(); try { window.dispatchEvent(new CustomEvent('kb:products')); } catch (e) { /* */ } }
      if (JSON.stringify(STOCK) !== before) paint(); else detail();
    }).catch(function () { /* sem conexão: mantém o último estado; a compra é barrada no servidor */ });
  }
  function brl(c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' '); }
  // textos dos cards ("Escolha a sua") com os dados do painel
  function cards() {
    [].forEach.call(document.querySelectorAll('.pc[data-slug]'), function (a) {
      var p = window.KBPROD[a.getAttribute('data-slug')]; if (!p) return;
      var h = a.querySelector('.pct h3'), t = a.querySelector('.pct p');
      if (h && p.name) h.textContent = p.name;
      if (t && p.price_cents != null) t.textContent = (p.volume_ml ? p.volume_ml + ' ML · ' : '') + brl(p.price_cents);
      var im = a.querySelector('.pci img'); if (im && p.name) im.alt = 'Frasco ' + p.name;
    });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(function () { if (!document.hidden) load(); schedule(); }, 60000); }

  if (d6) new MutationObserver(function () { lastSlug = null; detail(); }).observe(d6, { attributes: true, attributeFilter: ['data-slug'] });
  // o carrossel cria as capas depois: repinta quando novas capas surgirem
  var stage = document.querySelector('.pl') && document.querySelector('.pl').parentNode && document.querySelector('.pl').parentNode.parentNode;
  if (stage) new MutationObserver(function () { if (loaded) paint(); }).observe(stage, { childList: true });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  // impede adicionar ao carrinho um produto esgotado
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('#d6');
    if (a && isOut(a.getAttribute('data-slug'))) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  if (btn) btn.addEventListener('click', function () {
    form.hidden = false; btn.hidden = true; btn.setAttribute('aria-expanded', 'true'); inp.focus();
  });
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var em = inp.value.trim().toLowerCase(), slug = d6.getAttribute('data-slug');
    m.className = 'oos-m';
    if (hp && hp.value) return; // robô
    if (!EMAIL.test(em) || em.length > 254) { inp.setAttribute('aria-invalid', 'true'); m.className = 'oos-m err'; m.textContent = 'Informe um e-mail válido.'; inp.focus(); return; }
    inp.removeAttribute('aria-invalid');
    var b = form.querySelector('button'); b.disabled = true; b.textContent = 'Enviando…';
    window.KBAPI.rpc('request_restock_alert', { p_product: slug, p_email: em }).then(function (r) {
      form.hidden = true;
      m.className = 'oos-m ok';
      var nome = (r && r.produto) || NAMES[slug] || 'este perfume';
      m.textContent = r && r.status === 'ja_cadastrado'
        ? 'Você já está na lista. Vamos avisar em ' + em + ' assim que ' + nome + ' voltar.'
        : 'Pronto! Vamos avisar em ' + em + ' assim que ' + nome + ' voltar ao estoque.';
    }).catch(function (err) {
      m.className = 'oos-m err';
      m.textContent = err && err.message && err.message.length < 160 ? err.message : 'Não foi possível cadastrar agora. Tente de novo em instantes.';
      if (err && /disponível/.test(err.message || '')) load();
    }).then(function () { b.disabled = false; b.textContent = 'Avisar-me'; });
  });

  load().then(schedule);
})();
