/* Alpha Produções — receptor de vendas da Lotou Pass (Cloudflare Pages Function)
   Endereço: https://alphaproducoes.app.br/api/lotoupass

   A Lotou Pass ENVIA (POST) as vendas para cá. O sistema da Alpha LÊ (GET) o resumo por evento.
   Precisa no Cloudflare (Pages > projeto > Settings):
     - KV namespace ligado com o nome  VENDAS
     - Variável secreta  LOTOU_SECRET  (senha que a Lotou Pass usa para enviar)
     - Variável secreta  LOTOU_READ    (senha que o sistema Alpha usa para ler)
*/
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra) });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-alpha-key', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const keyOf = (id) => 'ev:' + String(id || '').trim();
const r2 = (n) => Math.round(n * 100) / 100;

function totals(s) {
  const L = s.lotes || [];
  s.ingressos_vendidos = L.reduce((t, l) => t + num(l.vendidos), 0);
  s.total_bruto = r2(L.reduce((t, l) => t + num(l.bruto), 0));
  s.total_liquido = r2(L.reduce((t, l) => t + num(l.liquido), 0));
  s.taxas = r2(s.total_bruto - s.total_liquido);
  return s;
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

/* ---------- Leitura pelo sistema Alpha ---------- */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const k = request.headers.get('x-alpha-key') || url.searchParams.get('k') || '';
  if (!env.LOTOU_READ || k !== env.LOTOU_READ) return J({ ok: false, erro: 'Chave de leitura inválida' }, 401, CORS);
  if (!env.VENDAS) return J({ ok: false, erro: 'KV VENDAS não configurado no Cloudflare' }, 500, CORS);
  const ev = url.searchParams.get('evento');
  if (!ev) return J({ ok: false, erro: 'Informe ?evento=ID' }, 400, CORS);
  const s = await env.VENDAS.get(keyOf(ev), 'json');
  if (!s) return J({ ok: true, evento_id: ev, vazio: true, lotes: [], ingressos_vendidos: 0, total_bruto: 0, taxas: 0, total_liquido: 0 }, 200, CORS);
  delete s.ids;
  return J(Object.assign({ ok: true }, s), 200, CORS);
}

/* ---------- Envio pela Lotou Pass ---------- */
export async function onRequestPost({ request, env }) {
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!env.LOTOU_SECRET || auth !== env.LOTOU_SECRET) return J({ ok: false, erro: 'Token inválido' }, 401, CORS);
  if (!env.VENDAS) return J({ ok: false, erro: 'KV VENDAS não configurado' }, 500, CORS);
  let b; try { b = await request.json(); } catch (e) { return J({ ok: false, erro: 'JSON inválido' }, 400, CORS); }
  const list = Array.isArray(b) ? b : [b];
  const out = [];
  for (const p of list) {
    const ev = String(p.evento_id || p.event_id || '').trim();
    if (!ev) { out.push({ ok: false, erro: 'evento_id ausente' }); continue; }
    const k = keyOf(ev);
    let s = (await env.VENDAS.get(k, 'json')) || { evento_id: ev, lotes: [], ids: [] };
    s.ids = s.ids || [];
    const tipo = String(p.tipo || (Array.isArray(p.lotes) ? 'resumo' : 'venda')).toLowerCase();

    if (tipo === 'resumo') {
      /* Formato 1 (recomendado): a Lotou Pass manda o RESUMO completo do evento — substitui tudo */
      s.lotes = (p.lotes || []).map(l => ({ nome: String(l.nome || 'Ingresso'), preco: num(l.preco), vendidos: num(l.vendidos), disponiveis: l.disponiveis == null ? null : num(l.disponiveis), bruto: r2(num(l.bruto != null ? l.bruto : num(l.preco) * num(l.vendidos))), liquido: r2(num(l.liquido != null ? l.liquido : l.bruto != null ? l.bruto : num(l.preco) * num(l.vendidos))) }));
      totals(s);
      if (p.total_bruto != null) s.total_bruto = r2(num(p.total_bruto));
      if (p.total_liquido != null) s.total_liquido = r2(num(p.total_liquido));
      if (p.taxas != null) s.taxas = r2(num(p.taxas));
      if (p.ingressos_vendidos != null) s.ingressos_vendidos = num(p.ingressos_vendidos);
      if (p.cortesias != null) s.cortesias = num(p.cortesias);
    } else {
      /* Formato 2: uma VENDA (ou ESTORNO) por vez — soma no lote */
      const vid = String(p.venda_id || p.order_id || '');
      if (vid && s.ids.indexOf(vid + ':' + tipo) >= 0) { out.push({ ok: true, evento_id: ev, repetida: true }); continue; }
      const sign = (tipo === 'estorno' || tipo === 'cancelamento' || tipo === 'reembolso') ? -1 : 1;
      const nome = String(p.lote || p.ingresso || 'Ingresso');
      let l = s.lotes.find(x => x.nome === nome);
      if (!l) { l = { nome, preco: num(p.preco), vendidos: 0, disponiveis: null, bruto: 0, liquido: 0 }; s.lotes.push(l); }
      const q = num(p.quantidade || 1); const bruto = num(p.valor_bruto != null ? p.valor_bruto : num(p.preco) * q); const liq = num(p.valor_liquido != null ? p.valor_liquido : bruto - num(p.taxa));
      if (p.preco != null) l.preco = num(p.preco);
      l.vendidos = Math.max(0, l.vendidos + sign * q); l.bruto = r2(l.bruto + sign * bruto); l.liquido = r2(l.liquido + sign * liq);
      if (vid) { s.ids.push(vid + ':' + tipo); if (s.ids.length > 20000) s.ids = s.ids.slice(-20000); }
      totals(s);
    }
    if (p.evento_nome) s.evento_nome = String(p.evento_nome);
    s.atualizado_em = new Date().toISOString();
    await env.VENDAS.put(k, JSON.stringify(s));
    out.push({ ok: true, evento_id: ev, ingressos_vendidos: s.ingressos_vendidos, total_liquido: s.total_liquido });
  }
  return J(list.length === 1 ? out[0] : { ok: true, resultados: out }, 200, CORS);
}
