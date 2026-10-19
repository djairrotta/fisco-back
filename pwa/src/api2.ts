// Cliente tipado das rotas do Correio 2.0, conforme correio/docs/API.md.
// Erros chegam como ApiError (corpo `{erro}` em pt-BR).
import { api } from "./api";
import type { Endereco, ItemLista } from "./tipos";

// ------------------------------------------------------------------ tipos

export type TipoPasta = "entrada" | "rascunhos" | "enviados" | "arquivo" | "spam" | "lixeira";

export interface PastaContada {
  caminho: string;
  nome: string;
  tipo: TipoPasta | null;
  specialUse?: string | null;
  delimitador?: string;
  pai?: string | null;
  protegida?: boolean;
  total?: number | null;
  naoLidas?: number | null;
}

export type Ref = { pasta: string; uid: number };

export type AcaoLote = "lida" | "nao_lida" | "estrela" | "sem_estrela" | "mover" | "arquivar" | "excluir" | "spam" | "nao_spam";

export interface PedidoLote { pasta: string; uids: number[]; acao: AcaoLote; destino?: string }
export interface RespostaLote {
  ok: true; acao: AcaoLote; afetadas: number; naoEncontradas: number[];
  destino?: string; novosUids?: Record<string, number>; resultado?: "lixeira" | "apagadas";
}

export type ItemBusca = ItemLista & { pasta: string };

export interface FiltrosBusca {
  /** Busca em todas as pastas (todas=1). Não combina com `pasta`. */
  todas?: boolean;
  /** Uma pasta só (padrão do servidor: INBOX). Uma pasta chamada "todas" é só uma pasta. */
  pasta?: string;
  de?: string;
  para?: string;
  assunto?: string;
  texto?: string;
  temAnexo?: boolean;
  naoLidas?: boolean;
  /** AAAA-MM-DD, inclusivo. */
  desde?: string;
  ate?: string;
}

/** Valor de `assinaturaId`: id, "nenhuma", ou ausente (padrão do servidor). */
export type EscolhaAssinatura = number | "nenhuma" | null;

export interface RascunhoServidor {
  para: string; cc: string; cco: string; assunto: string; html: string;
  incluirAssinatura: boolean;
  assinaturaId?: EscolhaAssinatura;
  substituiUid?: number | null;
  anexosRascunho?: string[];
  respondendoA?: Ref | null;
  encaminhando?: Ref | null;
  files?: File[];
}

export interface AnexoServidor { parte: string; nome: string | null; tipo: string; tamanho: number; cid: string | null }

export interface RascunhoLido {
  uid: number; pasta: string; para: Endereco[]; cc: Endereco[]; cco: Endereco[]; assunto: string;
  html: string | null; texto: string | null; respondendoA: Ref | null; encaminhando: Ref | null;
  incluirAssinatura: boolean; assinaturaId?: number | null; anexos: AnexoServidor[]; data: string | null;
}

export interface ItemSaida {
  id: number; caixaId: number;
  estado: "pendente" | "enviando" | "falhou";
  origem: "agendado" | "falha";
  para: string[]; cc: string[]; cco: string[]; assunto: string;
  respondendoA: Ref | null; encaminhando: Ref | null; incluirAssinatura: boolean;
  agendarPara: string | null; proximaTentativa: string; tentativas: number; ultimoErro: string | null;
  anexos: { nome: string; tipo: string; tamanho: number }[];
  criadoEm: string; atualizadoEm: string;
}
export type ItemSaidaCompleto = ItemSaida & { html: string; texto: string | null };

export interface EdicaoSaida {
  para?: string | string[]; cc?: string | string[]; cco?: string | string[]; assunto?: string; html?: string;
  texto?: string | null; incluirAssinatura?: boolean; agendarPara?: string;
}

export type Modelo = "classico" | "executivo" | "moderno" | "minimalista";
export interface Redes { linkedin?: string; instagram?: string; facebook?: string; x?: string; youtube?: string }
export interface CamposAssinatura2 {
  nome?: string; cargo?: string; empresa?: string; registro?: string;
  telefone?: string; whatsapp?: string; email?: string; site?: string; endereco?: string;
  redes?: Redes; aviso?: string;
  logo?: "caixa" | "propria" | "nenhum";
  corDestaque?: string;
  divisor?: "linha" | "nenhum" | "barra";
}
export interface Assinatura {
  id: number; caixaId: number; nome: string; modelo: Modelo; campos: CamposAssinatura2;
  temLogoPropria: boolean; padraoNova: boolean; padraoResposta: boolean; criadoEm: string; atualizadoEm: string;
}
export interface Padroes { nova: number | null; resposta: number | null }
export interface ListaAssinaturas { assinaturas: Assinatura[]; padroes: Padroes; avisoPadrao: string; modelos: { id: Modelo; nome: string }[] }

export interface Regras {
  encaminhar: { ativo: boolean; para: string[]; manterCopia: boolean };
  ferias: { ativo: boolean; assunto: string; mensagem: string; inicio?: string; fim?: string; dias: number };
}
export interface Recursos { ferias: boolean; datas: boolean; copia: boolean; maxEncaminhamentos: number }
export type RegrasLidas =
  | (Regras & { suportado: true; outroScriptAtivo?: string; recursos: Recursos })
  | (Regras & { suportado: false; motivo: string });
export type RegrasSalvas = Regras & { ok: true; suportado: true; recursos: Recursos; avisos?: string[]; outroScriptAtivo?: string };

// --------------------------------------------------------------- funções

const base = (id: number) => `/api/caixas/${id}`;
const qPasta = (p: string) => `pasta=${encodeURIComponent(p)}`;

/** ISO 8601 com o fuso local (ex.: 2026-10-04T18:00:00-03:00), como o servidor exige. */
export function isoComFuso(d: Date): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

function formRascunho(r: RascunhoServidor): FormData {
  const f = new FormData();
  f.set("para", r.para); f.set("cc", r.cc); f.set("cco", r.cco);
  f.set("assunto", r.assunto); f.set("html", r.html);
  f.set("incluirAssinatura", r.incluirAssinatura ? "true" : "false");
  if (r.assinaturaId !== undefined && r.assinaturaId !== null) f.set("assinaturaId", String(r.assinaturaId));
  if (r.respondendoA) f.set("respondendoA", JSON.stringify(r.respondendoA));
  if (r.encaminhando) f.set("encaminhando", JSON.stringify(r.encaminhando));
  if (r.substituiUid) {
    f.set("substituiUid", String(r.substituiUid));
    if (r.anexosRascunho?.length) f.set("anexosRascunho", JSON.stringify(r.anexosRascunho));
  }
  for (const a of r.files ?? []) f.append("files", a, a.name);
  return f;
}

export const api2 = {
  // pastas
  listarPastas: async (id: number) => (await api.get<{ pastas: PastaContada[] }>(`${base(id)}/pastas`)).pastas,
  criarPasta: (id: number, nome: string, pai?: string | null) =>
    api.post<{ ok: true; caminho: string; pasta: PastaContada | null }>(`${base(id)}/pastas`, pai ? { nome, pai } : { nome }),
  renomearPasta: (id: number, caminho: string, nome: string) =>
    api.patch<{ ok: true; caminho: string; pasta: PastaContada | null }>(`${base(id)}/pastas?${qPasta(caminho)}`, { nome }),
  excluirPasta: (id: number, caminho: string) => api.del<{ ok: true }>(`${base(id)}/pastas?${qPasta(caminho)}`),
  listarFavoritos: (id: number, limite = 200) => api.get<{ mensagens: ItemBusca[]; limitado: boolean }>(`${base(id)}/favoritos?limite=${limite}`),

  // mensagens
  acaoLote: (id: number, p: PedidoLote) => api.post<RespostaLote>(`${base(id)}/mensagens/lote`, p),
  marcar: (id: number, pasta: string, uid: number, v: { lida?: boolean; estrela?: boolean }) =>
    api.patch<{ ok: true; lida?: boolean; estrela?: boolean }>(`${base(id)}/mensagens/${uid}?${qPasta(pasta)}`, v),
  redirecionar: (id: number, pasta: string, uid: number, para: string[]) =>
    api.post<{ ok: true; messageId: string; rejeitados: string[]; aviso?: string }>(`${base(id)}/mensagens/${uid}/redirecionar`, { pasta, para }),
  buscar: (id: number, f: FiltrosBusca) => {
    // todas=1 e pasta não andam juntos (400): "todas" vence
    const q = new URLSearchParams(f.todas ? { todas: "1" } : f.pasta ? { pasta: f.pasta } : {});
    for (const k of ["de", "para", "assunto", "texto"] as const) if (f[k]?.trim()) q.set(k, f[k]!.trim());
    if (f.temAnexo) q.set("temAnexo", "1");
    if (f.naoLidas) q.set("naoLidas", "1");
    if (f.desde) q.set("desde", f.desde);
    if (f.ate) q.set("ate", f.ate);
    return api.get<{ mensagens: ItemBusca[]; limitado: boolean }>(`${base(id)}/busca?${q}`);
  },

  // rascunhos
  salvarRascunho: (id: number, r: RascunhoServidor) =>
    api.form<{ ok: true; pasta: string; uid: number | null; substituido: boolean }>("PUT", `${base(id)}/rascunhos`, formRascunho(r)),
  lerRascunho: async (id: number, uid: number) => (await api.get<{ rascunho: RascunhoLido }>(`${base(id)}/rascunhos/${uid}`)).rascunho,
  apagarRascunho: (id: number, uid: number) => api.del<{ ok: true }>(`${base(id)}/rascunhos/${uid}`),

  // caixa de saída
  listarSaida: async (id: number) => (await api.get<{ itens: ItemSaida[] }>(`${base(id)}/saida`)).itens,
  lerSaida: async (id: number, sid: number) => (await api.get<{ item: ItemSaidaCompleto }>(`${base(id)}/saida/${sid}`)).item,
  editarSaida: (id: number, sid: number, e: EdicaoSaida) => api.patch<{ ok: true; item: ItemSaidaCompleto }>(`${base(id)}/saida/${sid}`, e),
  cancelarSaida: (id: number, sid: number) => api.del<{ ok: true }>(`${base(id)}/saida/${sid}`),
  reenviarSaida: (id: number, sid: number) => api.post<{ ok: true; enviado: boolean; item: ItemSaida | null }>(`${base(id)}/saida/${sid}/reenviar`, {}),

  // assinaturas
  listarAssinaturas: (id: number) => api.get<ListaAssinaturas>(`${base(id)}/assinaturas`),
  criarAssinatura: (id: number, a: { nome?: string; modelo?: Modelo; campos?: CamposAssinatura2 }) =>
    api.post<{ assinatura: Assinatura }>(`${base(id)}/assinaturas`, a),
  editarAssinatura: (id: number, aid: number, a: { nome?: string; modelo?: Modelo; campos?: CamposAssinatura2 }) =>
    api.patch<{ assinatura: Assinatura }>(`${base(id)}/assinaturas/${aid}`, a),
  excluirAssinatura: (id: number, aid: number) => api.del<{ ok: true; padroes: Padroes }>(`${base(id)}/assinaturas/${aid}`),
  definirPadroes: (id: number, p: Padroes) => api.put<{ ok: true; padroes: Padroes }>(`${base(id)}/assinaturas/padroes`, p),
  previaAssinatura: (id: number, p: { modelo?: Modelo; campos?: CamposAssinatura2; assinaturaId?: number }) =>
    api.post<{ html: string; texto: string }>(`${base(id)}/assinaturas/previa`, p),
  urlHtmlAssinatura: (id: number, aid: number) => `${base(id)}/assinaturas/${aid}/html`,
  enviarLogoAssinatura: (id: number, aid: number, arquivo: File) => {
    const f = new FormData();
    f.set("arquivo", arquivo, arquivo.name);
    return api.form<{ assinatura: Assinatura }>("PUT", `${base(id)}/assinaturas/${aid}/logo`, f);
  },
  removerLogoAssinatura: (id: number, aid: number) => api.del<{ assinatura: Assinatura }>(`${base(id)}/assinaturas/${aid}/logo`),

  // regras (Sieve)
  lerRegras: (id: number) => api.get<RegrasLidas>(`${base(id)}/regras`),
  salvarRegras: (id: number, r: Regras, substituir = false) =>
    api.put<RegrasSalvas>(`${base(id)}/regras`, substituir ? { ...r, substituir: true } : r),
};
