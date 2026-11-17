/* Korboly — calculadora de frete (Melhor Envio) no detalhe do produto.
   Só aparece quando o cálculo está ligado no painel. O token fica no servidor (função "frete"). */
(function () {
  var box = document.getElementById('frt');
  if (!box || !window.KBAPI || !window.KBAPI.ok) return;
  var form = box.querySelector('form'), inp = document.getElementById('frt-cep'),
      btn = form.querySelector('button'), msg = document.getElementById('frt-msg'), res = document.getElementById('frt-res');
  var brl = function (c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };

  window.KBAPI.settings().then(function (s) { if (s && s.ship_enabled) box.hidden = false; }).catch(function () {});

  function clear() { msg.textContent = ''; msg.className = ''; res.innerHTML = ''; }
  new MutationObserver(clear).observe(box, { attributes: true, attributeFilter: ['data-slug'] });

  inp.addEventListener('input', function () {
    var d = inp.value.replace(/\D/g, '').slice(0, 8);
    inp.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
    inp.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var cep = inp.value.replace(/\D/g, ''), slug = box.getAttribute('data-slug');
    clear();
    if (!/^\d{8}$/.test(cep)) { inp.setAttribute('aria-invalid', 'true'); msg.className = 'err'; msg.textContent = 'Digite um CEP com 8 números.'; inp.focus(); return; }
    if (!slug) return;
    btn.disabled = true; btn.textContent = 'Calculando…'; box.setAttribute('aria-busy', 'true');
    window.KBAPI.fn((window.KORBOLY && (window.KORBOLY.LOJA_FUNCTION || window.KORBOLY.FRETE_FUNCTION)) || 'loja', { cep: cep, items: [{ slug: slug, qty: 1 }] }).then(function (r) {
      var ops = (r && r.opcoes) || [];
      if (!ops.length) { msg.textContent = (r && r.aviso) || 'Nenhuma opção de entrega para este CEP.'; return; }
      msg.textContent = ops.length + (ops.length > 1 ? ' opções' : ' opção') + ' de entrega para ' + cep.slice(0, 5) + '-' + cep.slice(5) + ':';
      if (r.desconto_centavos > 0) {
        var dn = document.createElement('span'); dn.className = 'frt-dc';
        dn.textContent = 'A Korboly paga ' + brl(r.desconto_centavos) + ' do seu frete.';
        msg.appendChild(document.createElement('br')); msg.appendChild(dn);
      }
      ops.forEach(function (o) {
        var li = document.createElement('li');
        var a = document.createElement('span'); a.className = 'frt-s';
        a.textContent = o.servico + (o.transportadora && o.transportadora.toLowerCase() !== o.servico.toLowerCase() ? ' · ' + o.transportadora : '');
        var b = document.createElement('span'); b.className = 'frt-p';
        if (o.preco_original_centavos && o.preco_original_centavos > o.preco_centavos) {
          var del = document.createElement('s'); del.textContent = brl(o.preco_original_centavos);
          del.setAttribute('aria-label', 'de ' + brl(o.preco_original_centavos));
          b.appendChild(del); b.appendChild(document.createTextNode(' '));
          var now = document.createElement('span');
          now.textContent = o.preco_centavos === 0 ? 'Grátis' : brl(o.preco_centavos);
          now.setAttribute('aria-label', 'por ' + now.textContent);
          b.appendChild(now);
        } else b.textContent = brl(o.preco_centavos);
        var c = document.createElement('span'); c.className = 'frt-d';
        c.textContent = o.prazo_min === o.prazo_max ? 'até ' + o.prazo_max + (o.prazo_max === 1 ? ' dia útil' : ' dias úteis') : o.prazo_min + ' a ' + o.prazo_max + ' dias úteis';
        li.appendChild(a); li.appendChild(b); li.appendChild(c); res.appendChild(li);
      });
    }).catch(function (err) {
      msg.className = 'err';
      msg.textContent = (err && err.status === 400 && err.message) ? err.message
        : (err && err.status === 429) ? err.message
        : 'Não foi possível calcular o frete agora. Tente de novo em instantes.';
    }).finally(function () { btn.disabled = false; btn.textContent = 'Calcular'; box.removeAttribute('aria-busy'); });
  });
})();
