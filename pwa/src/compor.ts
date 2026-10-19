// Regras puras do "Escrever": limite de anexos, ordem da prévia,
// destinatários de resposta, prefixos, rascunho e endereços vistos.
import { escaparHtml } from "./assinatura";
import { armazenamento } from "./lib";
import type { Endereco, Mensagem } from "./tipos";

export const LIMITE_ANEXOS = 25 * 1024 * 1024;
export const MAX_ARQUIVOS = 50;
export const MSG_LIMITE = "Os anexos passam do limite de 25 MB por mensagem.";

export const totalBytes = (arqs: { size: number }[]) => arqs.reduce((s, a) => s + a.size, 0);

/** Guarda dos 25 MB: aceita os novos só se o total continuar ≤ 25 MB. */
export function adicionarAnexos<T extends { size: number }>(
  atuais: T[],
  novos: T[],
): { anexos: T[]; erro: string } {
  const todos = [...atuais, ...novos];
  if (todos.length > MAX_ARQUIVOS) return { anexos: atuais, erro: `No máximo ${MAX_ARQUIVOS} arquivos por mensagem.` };
  if (totalBytes(todos) > LIMITE_ANEXOS) return { anexos: atuais, erro: MSG_LIMITE };
  return { anexos: todos, erro: "" };
}

export type Modo = "nova" | "responder" | "todos" | "encaminhar";

/**
 * Prévia do que será enviado, na ordem do servidor: corpo, "-- " +
 * assinatura (se incluída), e a citação/encaminhamento abaixo.
 * Só para exibir: o `html` enviado é apenas o corpo — o servidor monta o resto.
 */
export function montarPrevia(p: { corpo: string; assinatura: string; incluirAssinatura: boolean; citacao: string }): string {
  const partes = [`<div data-parte="corpo">${p.corpo}</div>`];
  if (p.incluirAssinatura && p.assinatura) partes.push(`<div data-parte="assinatura">-- <br>${p.assinatura}</div>`);
  if (p.citacao) partes.push(`<div data-parte="citacao">${p.citacao}</div>`);
  return partes.join("");
}

const lista = (es: Endereco[]) => es.map((e) => (e.nome ? `${escaparHtml(e.nome)} &lt;${escaparHtml(e.endereco)}&gt;` : escaparHtml(e.endereco))).join(", ");

/** Prévia da citação (o servidor gera a real com o HTML sanitizado do original). */
export function previaCitacao(m: Mensagem, modo: Modo, corpoSeguro: string): string {
  if (modo === "nova") return "";
  const data = m.data ? new Date(m.data).toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" }) : "";
  const de = m.de ? lista([m.de]) : "";
  if (modo === "encaminhar") {
    return `<div>---------- Mensagem encaminhada ----------<br>De: ${de}<br>Data: ${escaparHtml(data)}<br>Assunto: ${escaparHtml(m.assunto)}<br>Para: ${lista(m.para)}${m.cc.length ? `<br>Cc: ${lista(m.cc)}` : ""}</div><br>${corpoSeguro}`;
  }
  return `<div>Em ${escaparHtml(data)}, ${de} escreveu:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${corpoSeguro}</blockquote>`;
}

/** Prefixo do assunto sem duplicar Re:/Enc:/Fwd:/Tr:. */
export function assuntoCom(modo: Modo, original: string): string {
  const o = (original ?? "").trim();
  if (modo === "nova") return "";
  if (modo === "encaminhar") return /^(enc|fwd?|tr):/i.test(o) ? o : `Enc: ${o}`;
  return /^re:/i.test(o) ? o : `Re: ${o}`;
}

/** Destinatários iniciais de uma resposta; "todos" inclui para/cc menos a própria caixa. */
export function destinatariosResposta(m: Mensagem, modo: Modo, propria: string): { para: string; cc: string } {
  if (modo !== "responder" && modo !== "todos") return { para: "", cc: "" };
  const eu = propria.toLowerCase();
  const base = m.responderPara.length ? m.responderPara : m.de ? [m.de] : [];
  const para = uniq(base.map((e) => e.endereco)).filter((e) => e !== eu);
  if (modo === "responder") return { para: para.join(", "), cc: "" };
  const visto = new Set([...para, eu]);
  const outros = uniq([...m.para, ...m.cc].map((e) => e.endereco)).filter((e) => !visto.has(e));
  return { para: para.join(", "), cc: outros.join(", ") };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

// ---------------------------------------------------------------- rascunho
export interface Rascunho {
  ref: string; // "nova" | "<modo>:<pasta>:<uid>"
  para: string;
  cc: string;
  cco: string;
  assunto: string;
  html: string;
  incluirAssinatura: boolean;
  salvoEm: number;
}

export const chaveRascunho = (caixaId: number) => `correio:rascunho:${caixaId}`;

export const lerRascunho = (caixaId: number) => armazenamento.ler<Rascunho>(chaveRascunho(caixaId));
export const gravarRascunho = (caixaId: number, r: Rascunho) => armazenamento.gravar(chaveRascunho(caixaId), r);
export const apagarRascunho = (caixaId: number) => armazenamento.apagar(chaveRascunho(caixaId));

// ------------------------------------------------------- endereços vistos
const CHAVE_ENDERECOS = "correio:enderecos";
const MAX_ENDERECOS = 500;

/** Guarda endereços das mensagens carregadas (autocompletar para/cc/cco). */
export function lembrarEnderecos(es: (Endereco | null | undefined)[]): void {
  const atuais = armazenamento.ler<Endereco[]>(CHAVE_ENDERECOS) ?? [];
  const mapa = new Map(atuais.map((e) => [e.endereco.toLowerCase(), e]));
  let mudou = false;
  for (const e of es) {
    if (!e?.endereco || !e.endereco.includes("@")) continue;
    const k = e.endereco.toLowerCase();
    const ant = mapa.get(k);
    if (!ant || (!ant.nome && e.nome)) {
      mapa.delete(k);
      mapa.set(k, { nome: e.nome ?? "", endereco: k });
      mudou = true;
    }
  }
  if (mudou) armazenamento.gravar(CHAVE_ENDERECOS, [...mapa.values()].slice(-MAX_ENDERECOS));
}

export const enderecosVistos = (): Endereco[] => armazenamento.ler<Endereco[]>(CHAVE_ENDERECOS) ?? [];

/** Sugestões para o último item digitado de um campo "a@x, b@" . */
export function sugerir(valor: string, vistos: Endereco[], max = 5): Endereco[] {
  const ultimo = valor.split(/[,;]/).pop()!.trim().toLowerCase();
  if (ultimo.length < 2) return [];
  const ja = new Set(valor.split(/[,;]/).map((s) => s.trim().toLowerCase()));
  return vistos
    .filter((e) => !ja.has(e.endereco) && (e.endereco.includes(ultimo) || e.nome.toLowerCase().includes(ultimo)))
    .slice(0, max);
}

/** Troca o último item pelo endereço escolhido e prepara o próximo. */
export function completar(valor: string, endereco: string): string {
  const partes = valor.split(/[,;]/).map((s) => s.trim());
  partes[partes.length - 1] = endereco;
  return partes.filter(Boolean).join(", ") + ", ";
}
