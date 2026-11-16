/* Korboly — formatação simples e segura para textos editados no painel.
   Suporta: ## título {#ancora}, ### subtítulo, listas com "- ", parágrafos,
   **negrito**, [texto](link) e variáveis {{email}}, {{empresa}}, {{cnpj}}, {{endereco}}, {{encarregado}}, {{whatsapp}}.
   Todo HTML digitado é escapado: o texto nunca vira código. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) {
    u = String(u || '').trim();
    if (/^(https?:\/\/|mailto:|tel:|#|\/)/i.test(u) || /^[a-z0-9_-]+\.html(#[\w-]+)?$/i.test(u)) return u;
    return null;
  }
  function slug(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  function token(name, tk) {
    var v = (tk && tk[name] || '').trim();
    if (!v) return '<mark class="kb-tbd" title="Preencha no painel: Admin › Privacidade">[a preencher]</mark>';
    if (name === 'email') return '<a href="mailto:' + esc(v) + '">' + esc(v) + '</a>';
    if (name === 'whatsapp') { var n = v.replace(/\D/g, ''); return '<a href="https://wa.me/55' + esc(n.replace(/^55/, '')) + '" rel="noopener">' + esc(v) + '</a>'; }
    return esc(v);
  }

  function inline(s, tk) {
    var keep = [];
    function hold(html) { keep.push(html); return '\u0000' + (keep.length - 1) + '\u0000'; }
    s = esc(s);
    s = s.replace(/\{\{\s*(email|empresa|cnpj|endereco|encarregado|whatsapp)\s*\}\}/g, function (_, n) { return hold(token(n, tk)); });
    s = s.replace(/\[([^\]]{1,200})\]\(([^)\s]{1,500})\)/g, function (m, t, u) {
      var url = safeUrl(u.replace(/&amp;/g, '&'));
      if (!url) return t;
      var ext = /^https?:/i.test(url);
      return hold('<a href="' + esc(url) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + t + '</a>');
    });
    s = s.replace(/\*\*([^*]{1,400})\*\*/g, '<strong>$1</strong>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return keep[+i]; });
  }

  window.kbmd = function (src, tk) {
    var lines = String(src || '').replace(/\r/g, '').split('\n'), out = [], para = [], list = null;
    function flushP() { if (para.length) { out.push('<p>' + inline(para.join(' '), tk) + '</p>'); para = []; } }
    function flushL() { if (list) { out.push('<ul>' + list.map(function (li) { return '<li>' + inline(li, tk) + '</li>'; }).join('') + '</ul>'); list = null; } }
    lines.forEach(function (raw) {
      var l = raw.trim(), m;
      if (!l) { flushP(); flushL(); return; }
      if ((m = l.match(/^(#{2,3})\s+(.+?)(?:\s*\{#([a-z0-9-]{1,40})\})?$/i))) {
        flushP(); flushL();
        var tag = m[1].length === 2 ? 'h2' : 'h3', id = m[3] || slug(m[2]);
        out.push('<' + tag + ' id="' + esc(id) + '">' + inline(m[2], tk) + '</' + tag + '>');
        return;
      }
      if ((m = l.match(/^[-*]\s+(.+)$/))) { flushP(); (list = list || []).push(m[1]); return; }
      flushL(); para.push(l);
    });
    flushP(); flushL();
    return out.join('\n');
  };
  /* texto puro (para busca e dados estruturados) */
  window.kbmdText = function (src, tk) {
    var d = document.createElement('div'); d.innerHTML = window.kbmd(src, tk);
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  };
})();
