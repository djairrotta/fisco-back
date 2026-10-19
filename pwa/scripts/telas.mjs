// Capturas de tela para revisão visual (Playwright + API simulada).
// Uso: npm run build && node scripts/telas.mjs [saida]
// Sobe o `vite preview`, intercepta /api/* com dados de exemplo em pt-BR
// e grava as telas em correio/docs/telas/.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/npm-tools/node_modules/playwright")); }

const SAIDA = resolve(process.argv[2] ?? resolve(aqui, "../../docs/telas"));

// gerador real das assinaturas do backend (Deno/TS), empacotado para Node
const { buildSync } = require("esbuild");
const destinoGerador = resolve(aqui, "../node_modules/.telas-gerador.mjs");
buildSync({ entryPoints: [resolve(aqui, "../../backend/src/caixas/modelos_assinatura.ts")], bundle: true, format: "esm", platform: "neutral", outfile: destinoGerador, logLevel: "silent" });
const { gerarAssinaturaModelo, AVISO_PADRAO } = await import(destinoGerador);
mkdirSync(SAIDA, { recursive: true });
const PORTA = 4179;

// ------------------------------------------------------------------ dados
const agora = new Date();
const h = (horas, min = 0, diasAtras = 0) => {
  const d = new Date(agora);
  d.setDate(d.getDate() - diasAtras);
  d.setHours(horas, min, 0, 0);
  return d.toISOString();
};

const CAIXAS = [
  { id: 1, endereco: "contato@peritobancario.com.br", dominio: "peritobancario.com.br", nome_exibicao: "Perito Bancário", cor: "#1d3f6e", sigla: "PB" },
  { id: 2, endereco: "contato@icheck.com.br", dominio: "icheck.com.br", nome_exibicao: "iCheck", cor: "#0f7a63", sigla: "iC" },
  { id: 3, endereco: "contato@seguramultas.com.br", dominio: "seguramultas.com.br", nome_exibicao: "Segura Multas", cor: "#c2410c", sigla: "SM" },
  { id: 4, endereco: "contato@datagateway.com.br", dominio: "datagateway.com.br", nome_exibicao: "DataGateway", cor: "#3451b2", sigla: "DG" },
].map((c, i) => ({
  ...c, estado: "ok", estado_motivo: null, tem_logo: true, tem_favicon: false,
  assinatura: { nome: "Djair Rotta", cargo: "Perícia contábil bancária", telefone: "(19) 3656-0000", site: "https://peritobancario.com.br" },
  ordem: i, criado_em: "2026-09-01T12:00:00Z",
}));

const logo = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.cor}" stop-opacity=".86"/><stop offset="1" stop-color="${c.cor}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="41.5" text-anchor="middle" font-family="Georgia, 'Bitstream Charter', serif" font-size="25" font-weight="700" fill="#fff" letter-spacing="-0.5">${c.sigla}</text></svg>`;

const P = (caminho, nome, tipo, extra = {}) => ({ caminho, nome, tipo, specialUse: null, delimitador: ".", pai: null, protegida: !!tipo, total: null, naoLidas: null, ...extra });
const PASTAS = [
  P("INBOX", "Entrada", "entrada", { naoLidas: 4, total: 1284 }),
  P("Drafts", "Rascunhos", "rascunhos", { total: 2, naoLidas: 0 }),
  P("Sent", "Enviados", "enviados"),
  P("Archive", "Arquivo", "arquivo"),
  P("Junk", "Spam", "spam", { naoLidas: 12 }),
  P("Trash", "Lixeira", "lixeira"),
  P("INBOX.Clientes", "Clientes", null, { naoLidas: 3, pai: "INBOX" }),
  P("INBOX.Financeiro", "Financeiro", null, { pai: "INBOX" }),
  P("INBOX.Processos 2026", "Processos 2026", null, { pai: "INBOX" }),
  P("INBOX.Tribunais", "Tribunais", null, { naoLidas: 1, pai: "INBOX" }),
];

const LISTA = [
  { uid: 4182, de: ["Dra. Helena Vasconcelos", "helena@vasconcelosadv.com.br"], assunto: "Laudo pericial do processo 1003458-21.2026.8.26.0360", previa: "Prezado Dr. Djair, segue a minuta do laudo com o recálculo da capitalização mensal. Peço atenção especial aos quesitos 4 e 7 antes do protocolo.", data: h(9, 42), lida: false, temAnexo: true, favorita: true },
  { uid: 4181, de: ["2ª Vara Cível de Mococa", "mococa2cv@tjsp.jus.br"], assunto: "Intimação: prazo de 15 dias para manifestação sobre o laudo", previa: "Fica Vossa Senhoria intimado a se manifestar sobre o laudo pericial juntado às fls. 412/468, no prazo legal.", data: h(8, 15), lida: false, temAnexo: true },
  { uid: 4180, de: ["Rafael Monteiro", "rafael.monteiro@gmail.com"], assunto: "Dúvida sobre a tabela Price no meu financiamento", previa: "Boa tarde! Recebi o parecer preliminar e fiquei com uma dúvida sobre a diferença entre a taxa contratada e a efetivamente cobrada.", data: h(7, 3), lida: false, temAnexo: false },
  { uid: 4179, de: ["Juliana Prado", "juliana@pradocontabil.com.br"], assunto: "Planilha de evolução da dívida (versão revisada)", previa: "Djair, ajustei as parcelas de março a agosto conforme conversamos. A diferença acumulada ficou em R$ 18.437,92.", data: h(18, 26, 1), lida: true, temAnexo: true, favorita: true },
  { uid: 4178, de: ["Marcos Tavares", "marcos.tavares@tavaresadvogados.com"], assunto: "Re: Honorários periciais e cronograma", previa: "Perfeito. Confirmo o depósito dos honorários até sexta e a entrega do laudo complementar em 20 dias úteis.", data: h(16, 50, 1), lida: true, temAnexo: false },
  { uid: 4177, de: ["Fernanda Lima", "fernanda.lima@outlook.com"], assunto: "Extratos de 2019 a 2023 do contrato de consignado", previa: "Conforme solicitado, envio os extratos completos. Alguns meses de 2020 vieram em imagem, espero que sirvam.", data: h(11, 12, 2), lida: false, temAnexo: true },
  { uid: 4176, de: ["Carla Nogueira", "carla@nogueiraeassociados.adv.br"], assunto: "Reunião sobre a revisional do Banco Atlântico", previa: "Podemos conversar na quinta às 15h? Quero alinhar a estratégia antes da audiência de conciliação.", data: h(9, 5, 3), lida: true, temAnexo: false },
  { uid: 4175, de: ["Asaas", "nao-responda@asaas.com"], assunto: "Pagamento confirmado: Perícia contábil (fatura 0921)", previa: "O pagamento de R$ 3.800,00 referente à fatura 0921 foi confirmado e já está disponível no seu saldo.", data: h(14, 31, 4), lida: true, temAnexo: false },
  { uid: 4174, de: ["Paulo Henrique Souza", "paulohsouza@yahoo.com.br"], assunto: "Orçamento para revisão de empréstimo consignado", previa: "Bom dia, sou servidor estadual e gostaria de um orçamento para revisar três contratos de consignado.", data: h(10, 2, 5), lida: true, temAnexo: false },
  { uid: 4173, de: ["Associação Paulista de Peritos", "eventos@appjudiciais.org.br"], assunto: "Convite: webinar sobre juros remuneratórios e o Tema 27", previa: "Na próxima terça, às 19h, debateremos os parâmetros do STJ para limitação de juros em contratos bancários.", data: h(17, 0, 8), lida: true, temAnexo: false },
  { uid: 4172, de: ["Cloudflare", "noreply@notify.cloudflare.com"], assunto: "Resumo semanal de peritobancario.com.br", previa: "Seu domínio recebeu 2.914 visitas únicas nos últimos 7 dias, um aumento de 12% em relação à semana anterior.", data: h(6, 0, 9), lida: true, temAnexo: false },
  { uid: 4171, de: ["Roberto Almeida", "roberto.almeida@uol.com.br"], assunto: "Contrato de leasing de veículo: segunda opinião", previa: "Indicação do Dr. Marcos. Tenho um leasing com VRG diluído e gostaria de saber se cabe revisão.", data: h(15, 44, 11), lida: true, temAnexo: true },
];

const item = (m) => ({ uid: m.uid, de: { nome: m.de[0], endereco: m.de[1] }, assunto: m.assunto, data: m.data, lida: m.lida, temAnexo: m.temAnexo, tamanho: 48000, estrela: !!m.favorita, previa: m.previa });

const CORPO = `
<p>Prezado Dr. Djair,</p>
<p>Segue em anexo a minuta do laudo pericial referente ao processo <strong>1003458-21.2026.8.26.0360</strong>, com o recálculo integral da evolução do saldo devedor pelo método de juros simples, conforme determinado na decisão saneadora.</p>
<p>Alguns pontos merecem sua atenção antes do protocolo:</p>
<ul>
  <li>No quesito 4, a capitalização mensal ficou demonstrada a partir da 13ª parcela, com diferença acumulada de R$ 18.437,92;</li>
  <li>No quesito 7, a tarifa de avaliação do bem foi cobrada sem a respectiva prestação do serviço;</li>
  <li>A taxa efetiva anual praticada (31,4%) supera a média de mercado divulgada pelo Bacen para o período (22,9%).</li>
</ul>
<p>A planilha de cálculo segue em formato editável, caso queira conferir as fórmulas. Se estiver de acordo, protocolamos até quinta-feira, dentro do prazo concedido pelo juízo.</p>
<p>Fico à disposição para conversarmos por telefone, se preferir.</p>
<p>Atenciosamente,<br><strong>Helena Vasconcelos</strong><br>OAB/SP 287.114<br>Vasconcelos Advocacia</p>`;

const MENSAGEM = {
  uid: 4182, pasta: "INBOX", de: { nome: "Dra. Helena Vasconcelos", endereco: "helena@vasconcelosadv.com.br" },
  para: [{ nome: "Djair Rotta", endereco: "contato@peritobancario.com.br" }], cc: [{ nome: "Juliana Prado", endereco: "juliana@pradocontabil.com.br" }], responderPara: [],
  assunto: LISTA[0].assunto, data: LISTA[0].data, messageId: "<laudo-1003458@vasconcelosadv.com.br>", inReplyTo: null, references: [],
  html: CORPO, texto: null, lida: true, estrela: true, tamanho: 1480000, suspeita: null,
  anexos: [
    { parte: "2", nome: "Minuta_laudo_1003458.pdf", tipo: "application/pdf", tamanho: 1258291, cid: null },
    { parte: "3", nome: "Planilha_recalculo_saldo.xlsx", tipo: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", tamanho: 253952, cid: null },
  ],
};

let LOGO_PNG = null; // preenchido em main() (o gerador só aceita PNG/JPEG/WebP)
const CAMPOS_1 = {
  nome: "Djair Rotta", cargo: "Perito em contratos bancários", empresa: "Perito Bancário", registro: "OAB/SP 341.378",
  telefone: "(19) 3656-4120", whatsapp: "(19) 99812-3344", email: "contato@peritobancario.com.br", site: "www.peritobancario.com.br",
  endereco: "Rua Barão do Rio Branco, 412, Mococa/SP", redes: { linkedin: "https://www.linkedin.com/in/djairrotta", instagram: "https://instagram.com/peritobancario" },
  aviso: AVISO_PADRAO, logo: "caixa", corDestaque: "#1d3f6e", divisor: "linha",
};
const ASSINATURAS = [
  { id: 11, caixaId: 1, nome: "Escritório", modelo: "moderno", campos: CAMPOS_1, temLogoPropria: false, padraoNova: true, padraoResposta: false, criadoEm: "2026-10-01T12:00:00Z", atualizadoEm: "2026-10-03T12:00:00Z" },
  { id: 12, caixaId: 1, nome: "Resposta curta", modelo: "minimalista", campos: { nome: "Djair Rotta", cargo: "Perito em contratos bancários", telefone: "(19) 3656-4120", aviso: "", logo: "nenhum", divisor: "nenhum" }, temLogoPropria: false, padraoNova: false, padraoResposta: true, criadoEm: "2026-10-01T12:00:00Z", atualizadoEm: "2026-10-02T12:00:00Z" },
  { id: 13, caixaId: 1, nome: "Perícias judiciais", modelo: "classico", campos: { ...CAMPOS_1, cargo: "Assistente técnico" }, temLogoPropria: false, padraoNova: false, padraoResposta: false, criadoEm: "2026-10-01T12:00:00Z", atualizadoEm: "2026-10-01T12:00:00Z" },
];
const gerar = (modelo, campos) => gerarAssinaturaModelo(modelo, campos, { logo: LOGO_PNG ? { bytes: LOGO_PNG, mime: "image/png" } : null, imagens: "dataUri", corPadrao: "#1d3f6e" });

const emMin = (min) => new Date(Date.now() + min * 60000).toISOString();
const S = (o) => ({ caixaId: 1, cc: [], cco: [], respondendoA: null, encaminhando: null, incluirAssinatura: true, anexos: [], criadoEm: emMin(-180), atualizadoEm: emMin(-5), ...o });
const SAIDA_ITENS = [
  S({ id: 31, estado: "falhou", origem: "falha", para: ["financeiro@bancoatlantico.com.br"], assunto: "Notificação extrajudicial: revisão do contrato 88213", agendarPara: null, proximaTentativa: emMin(-20), tentativas: 4, ultimoErro: "Falha ao enviar: 550 caixa do destinatário cheia", anexos: [{ nome: "Notificacao_88213.pdf", tipo: "application/pdf", tamanho: 312000 }] }),
  S({ id: 32, estado: "pendente", origem: "falha", para: ["rafael.monteiro@gmail.com"], assunto: "Re: Dúvida sobre a tabela Price no meu financiamento", agendarPara: null, proximaTentativa: emMin(4), tentativas: 1, ultimoErro: "Falha ao enviar: tempo esgotado" }),
  S({ id: 33, estado: "pendente", origem: "agendado", para: ["helena@vasconcelosadv.com.br"], cc: ["juliana@pradocontabil.com.br"], assunto: "Laudo pericial assinado: processo 1003458-21.2026.8.26.0360", agendarPara: (() => { const d = new Date(); d.setHours(18, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.toISOString(); })(), proximaTentativa: emMin(300), tentativas: 0, ultimoErro: null, anexos: [{ nome: "Laudo_1003458_final.pdf", tipo: "application/pdf", tamanho: 1480000 }] }),
  S({ id: 34, estado: "pendente", origem: "agendado", para: ["paulohsouza@yahoo.com.br"], assunto: "Orçamento: revisão de três contratos de consignado", agendarPara: (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString(); })(), proximaTentativa: emMin(900), tentativas: 0, ultimoErro: null }),
];
const HTML_SAIDA = `<p>Prezados,</p><p>Na qualidade de perito contratado pelo cliente, notifico Vossas Senhorias para que apresentem, no prazo de 10 dias, a planilha de evolução do saldo devedor do contrato 88213, com a discriminação da taxa de juros efetivamente aplicada.</p><p>Atenciosamente,</p>`;

const REGRAS = {
  encaminhar: { ativo: true, para: ["djair@djairrotta.adv.br"], manterCopia: true },
  ferias: { ativo: true, assunto: "Em audiência até quinta-feira", mensagem: "Olá! Estou em audiências até quinta-feira, 9/10, com acesso limitado ao e-mail. Para assuntos urgentes, ligue (19) 3656-4120.", inicio: "2026-10-06", fim: "2026-10-09", dias: 3 },
  suportado: true, recursos: { ferias: true, datas: true, copia: true, maxEncaminhamentos: 4 },
};

// --------------------------------------------------------------- servidor
function json(route, corpo, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(corpo) });
}

async function rotas(page) {
  await page.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    const m = route.request().method();
    let r;
    if (p === "/api/auth/estado") return json(route, { host: u.host, origem: u.origin });
    if (p === "/api/caixas" && m === "GET") return json(route, { caixas: CAIXAS.map(({ sigla, ...c }) => c) });
    if ((r = p.match(/^\/api\/marca\/(\d+)\/logo$/))) {
      const c = CAIXAS.find((x) => x.id === Number(r[1]));
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: logo(c) });
    }
    if ((r = p.match(/^\/api\/caixas\/(\d+)\/pastas$/))) return json(route, { pastas: PASTAS });
    if ((r = p.match(/^\/api\/caixas\/(\d+)\/saida$/))) return json(route, { itens: Number(r[1]) === 1 ? SAIDA_ITENS : [] });
    if ((r = p.match(/^\/api\/caixas\/1\/saida\/(\d+)$/))) return json(route, { item: { ...SAIDA_ITENS.find((x) => x.id === Number(r[1])), html: HTML_SAIDA, texto: null } });
    if (p === "/api/caixas/1/assinaturas") return json(route, { assinaturas: ASSINATURAS, padroes: { nova: 11, resposta: 12 }, avisoPadrao: AVISO_PADRAO, modelos: [] });
    if (p.endsWith("/assinaturas/previa")) { const b = route.request().postDataJSON(); return json(route, { html: gerar(b.modelo, b.campos).html, texto: "" }); }
    if (/\/assinaturas$/.test(p)) return json(route, { assinaturas: [], padroes: { nova: null, resposta: null }, avisoPadrao: AVISO_PADRAO, modelos: [] });
    if (p.endsWith("/regras")) return json(route, REGRAS);
    if (p.endsWith("/rascunhos") && m === "PUT") return json(route, { ok: true, pasta: "Drafts", uid: 900, substituido: false });
    if (p.endsWith("/favoritos")) return json(route, { mensagens: LISTA.filter((x) => x.favorita).map((x) => ({ ...item(x), pasta: "INBOX" })), limitado: false });
    if ((r = p.match(/^\/api\/caixas\/(\d+)\/mensagens$/))) {
      const id = Number(r[1]);
      const pag = Number(u.searchParams.get("pagina") ?? 1);
      const lista = id === 1 ? LISTA : LISTA.slice(3, 9);
      if (pag > 1) return json(route, { mensagens: [], pagina: pag, porPagina: 50, total: lista.length });
      return json(route, { mensagens: lista.map(item), pagina: 1, porPagina: 50, total: lista.length });
    }
    if ((r = p.match(/^\/api\/caixas\/(\d+)\/mensagens\/(\d+)$/)) && m === "GET") {
      const uid = Number(r[2]);
      if (uid === MENSAGEM.uid) return json(route, { mensagem: MENSAGEM });
      const x = LISTA.find((y) => y.uid === uid) ?? LISTA[1];
      return json(route, { mensagem: { ...MENSAGEM, uid, de: { nome: x.de[0], endereco: x.de[1] }, assunto: x.assunto, data: x.data, html: `<p>${x.previa}</p>`, anexos: [] } });
    }
    if (p === "/api/config/notificacoes") return json(route, { global: { recebido: true, enviado: false, falha: true }, caixa: { recebido: true, enviado: false, falha: true } });
    if (p === "/api/config/ia") return json(route, { modelo: "typesafe/jev-1.13", ativo: true, timeoutS: 20, chaveConfigurada: true });
    if (p === "/api/config/passkeys") return json(route, { passkeys: [{ id: 1, credencial: "Kq3vX9", transportes: ["internal", "hybrid"], criado: "2026-09-12T14:03:00Z" }] });
    return json(route, { erro: `sem simulação para ${m} ${p}` }, 404);
  });
}

// iPhone: barra de status e indicador de início desenhados por cima, áreas seguras do PWA
const IPHONE_CSS = `:root{--seg-topo:47px!important;--seg-base:34px!important}
#sb{position:fixed;z-index:9999;top:0;left:0;right:0;height:47px;display:flex;align-items:center;justify-content:space-between;padding:6px 30px 0 44px;font:600 16px/1 -apple-system,Inter,sans-serif;color:var(--texto);pointer-events:none}
#sb i{display:inline-block;width:25px;height:12px;border:1.5px solid currentColor;border-radius:4px;opacity:.9;position:relative}
#sb i::after{content:"";position:absolute;inset:1.5px;right:5px;background:currentColor;border-radius:1.5px}
#hi{position:fixed;z-index:9999;bottom:8px;left:50%;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:var(--texto);opacity:.85;pointer-events:none}`;

async function iphone(page) {
  await page.addStyleTag({ content: IPHONE_CSS });
  await page.evaluate(() => {
    const sb = document.createElement("div"); sb.id = "sb"; sb.innerHTML = "<span>9:41</span><i></i>"; document.body.appendChild(sb);
    const hi = document.createElement("div"); hi.id = "hi"; document.body.appendChild(hi);
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const servidor = spawn("npx", ["vite", "preview", "--port", String(PORTA), "--strictPort"], { cwd: resolve(aqui, ".."), stdio: "ignore" });
  await espera(2500);
  const base = `http://localhost:${PORTA}`;
  const browser = await chromium.launch({ args: ["--lang=pt-BR"] });
  {
    const pg = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await pg.setContent(`<body style="margin:0">${logo(CAIXAS[0]).replace("<svg ", '<svg width="128" height="128" ')}</body>`);
    LOGO_PNG = new Uint8Array(await pg.screenshot({ clip: { x: 0, y: 0, width: 128, height: 128 } }));
    await pg.close();
  }
  const tela = async (nome, { largura, altura, escuro = false, movel = false, url, antes }) => {
    const ctx = await browser.newContext({
      viewport: { width: largura, height: altura }, deviceScaleFactor: 2, colorScheme: escuro ? "dark" : "light",
      serviceWorkers: "block", hasTouch: movel, isMobile: movel, locale: "pt-BR", timezoneId: "America/Sao_Paulo",
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${nome}]`, e.message));
    await rotas(page);
    await page.goto(base + url, { waitUntil: "networkidle" });
    if (movel) await iphone(page);
    await espera(500);
    if (antes) await antes(page);
    await espera(700);
    await page.screenshot({ path: resolve(SAIDA, `${nome}.png`) });
    console.log("ok", nome);
    await ctx.close();
  };

  const msg = `/c/1/m/INBOX/${MENSAGEM.uid}`;
  const so = process.env.SO?.split(",");
  const quer = (n) => !so || so.includes(n);
  if (quer("mac-claro")) await tela("mac-claro", { largura: 1440, altura: 900, url: msg });
  if (quer("mac-escuro")) await tela("mac-escuro", { largura: 1440, altura: 900, escuro: true, url: msg });
  if (quer("mac-escrever")) await tela("mac-escrever", {
    largura: 1440, altura: 900, url: msg,
    antes: async (p) => {
      await p.click(".leitura__assunto");
      await p.keyboard.press("r");
      await p.waitForSelector(".esc-editor");
      await espera(400);
      await p.click(".esc-editor");
      await p.keyboard.type("Dra. Helena, obrigado pelo envio. Revisei a minuta e estou de acordo com os quesitos 4 e 7.");
      await p.keyboard.press("Enter");
      await p.keyboard.type("Podemos protocolar na quinta-feira. Envio ainda hoje a planilha com as fórmulas conferidas.");
    },
  });
  if (quer("iphone-lista")) await tela("iphone-lista", { largura: 390, altura: 844, movel: true, url: "/c/1" });
  if (quer("iphone-pastas")) await tela("iphone-pastas", {
    largura: 390, altura: 844, movel: true, url: "/c/1",
    antes: async (p) => { await p.click('button[aria-label="Mostrar pastas"]'); },
  });
  if (quer("iphone-mensagem")) await tela("iphone-mensagem", { largura: 390, altura: 844, movel: true, url: msg });
  if (quer("iphone-caixas")) await tela("iphone-caixas", {
    largura: 390, altura: 844, movel: true, url: "/c/1",
    antes: async (p) => { await p.click('.tabbar button:has-text("Caixas")'); },
  });
  if (quer("mac-assinatura")) await tela("mac-assinatura", { largura: 1440, altura: 900, url: "/c/1/assinaturas", antes: async () => { await espera(1500); } });
  if (quer("iphone-assinatura")) await tela("iphone-assinatura", { largura: 390, altura: 844, movel: true, url: "/c/1/assinaturas", antes: async () => { await espera(1500); } });
  if (quer("mac-saida")) await tela("mac-saida", { largura: 1440, altura: 900, url: "/c/1?pasta=__saida" });
  if (quer("mac-regras")) await tela("mac-regras", { largura: 1440, altura: 900, url: "/c/1/regras" });
  if (quer("mac-lote")) await tela("mac-lote", {
    largura: 1440, altura: 900, url: "/c/1",
    antes: async (p) => {
      await p.click('button:has-text("Selecionar")');
      for (const t of ["Dúvida sobre a tabela Price", "Planilha de evolução", "Extratos de 2019"]) await p.click(`.linha:has-text("${t}")`);
      await p.mouse.move(5, 895);
    },
  });
  if (process.env.EXECUTIVO) await tela("extra-executivo", { largura: 1440, altura: 900, url: "/c/1/assinaturas", antes: async (p) => { await espera(1200); await p.click('button[role="radio"][aria-label="Executivo"]'); await espera(1200); } });
  if (process.env.EXTRA) {
    await tela("extra-iphone-escuro", { largura: 390, altura: 844, movel: true, escuro: true, url: "/c/1" });
    await tela("extra-ipad", { largura: 900, altura: 1100, url: msg });
    await tela("extra-ajustes", { largura: 1440, altura: 900, url: "/config" });
    await tela("extra-login", { largura: 1440, altura: 900, url: "/login" });
    await tela("extra-iphone-escrever", { largura: 390, altura: 844, movel: true, url: "/c/1", antes: async (p) => { await p.click('button[aria-label="Escrever"]'); } });
  }
  await browser.close();
  servidor.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
