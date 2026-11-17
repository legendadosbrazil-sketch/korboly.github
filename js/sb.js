(function(){
  var c = window.KORBOLY || {};
  window.KB_READY = /^https:\/\//.test(c.SUPABASE_URL||'') && (c.SUPABASE_ANON_KEY||'').length > 40;
  window.sb = window.KB_READY && window.supabase
    ? window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}})
    : null;
  window.brl = function(cents){ return (cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) };
  window.esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]}) };
  window.STATUS = {novo:'Novo',em_preparo:'Em preparo',enviado:'Enviado',entregue:'Entregue',cancelado:'Cancelado'};
  window.PAY = {pendente:'Aguardando pagamento',em_analise:'Em análise',pago:'Pago',recusado:'Recusado',reembolsado:'Reembolsado'};
  window.dt = function(s){ return new Date(s).toLocaleDateString('pt-BR') };
})();
