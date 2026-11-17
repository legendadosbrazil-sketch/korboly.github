// Configuração pública do Supabase (Settings -> API no painel do Supabase).
// A chave publicável (publishable) é feita para ficar no navegador: quem protege os dados são as regras (RLS) do banco.
// NUNCA coloque aqui a "service_role key".
window.KORBOLY = {
  SUPABASE_URL: "https://brcepymlgicqgyiapxdj.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_RGj67nMLRfApxKR6Yx8Leg_08OB7Igg",
  // Nome da função da loja no Supabase (Edge Functions): frete, pagamento e avisos do Mercado Pago.
  // Ela foi publicada com o nome "smooth-task". Se um dia criar outra com outro nome, troque aqui.
  LOJA_FUNCTION: "smooth-task"
};
