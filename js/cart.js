/* Korboly — carrinho (fica só no navegador do cliente; é um recurso essencial, não é cookie de rastreamento) */
(function () {
  var KEY = 'kb_cart', MAX = 10;
  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (i) { return i && /^[a-z0-9-]{1,60}$/.test(i.slug) && i.qty >= 1; })
        .map(function (i) { return { slug: i.slug, qty: Math.min(MAX, Math.trunc(i.qty)) }; }) : [];
    } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* navegação privada */ }
    paint(); try { window.dispatchEvent(new CustomEvent('kb:cart', { detail: list })); } catch (e) { /* */ }
  }
  function count() { return read().reduce(function (a, i) { return a + i.qty; }, 0); }
  function paint() {
    var n = count();
    [].forEach.call(document.querySelectorAll('[data-cart-count]'), function (el) {
      el.textContent = n ? String(n) : ''; el.hidden = !n;
    });
    [].forEach.call(document.querySelectorAll('[data-cart-link]'), function (el) {
      el.setAttribute('aria-label', n ? 'Carrinho, ' + n + (n > 1 ? ' itens' : ' item') : 'Carrinho vazio');
    });
  }
  window.KBCart = {
    items: read,
    count: count,
    add: function (slug, qty) {
      var l = read(), it = l.find(function (i) { return i.slug === slug; });
      if (it) it.qty = Math.min(MAX, it.qty + (qty || 1)); else l.push({ slug: slug, qty: Math.min(MAX, qty || 1) });
      write(l);
    },
    set: function (slug, qty) {
      var l = read().map(function (i) { return i.slug === slug ? { slug: slug, qty: Math.max(0, Math.min(MAX, qty)) } : i; })
        .filter(function (i) { return i.qty > 0; });
      write(l);
    },
    remove: function (slug) { write(read().filter(function (i) { return i.slug !== slug; })); },
    clear: function () { write([]); }
  };
  window.addEventListener('storage', function (e) { if (e.key === KEY) paint(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();
