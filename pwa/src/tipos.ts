// Formas JSON do backend do Correio (correio/backend, Tasks 1–5).

export type EstadoCaixa = "ok" | "precisa_senha" | "erro";

export interface CamposAssinatura {
  nome?: string;
  cargo?: string;
  telefone?: string;
  site?: string;
  extra?: string;
  incluirLogo?: boolean;
}

export interface Caixa {
  id: number;
  endereco: string;
  dominio: string;
  nome_exibicao: string;
  estado: EstadoCaixa;
  /** Observação do servidor sobre o estado (ex.: "senha precisa ser digitada de novo"). */
  estado_motivo?: string | null;
  cor: string | null;
  tem_logo: boolean;
  tem_favicon: boolean;
  assinatura: CamposAssinatura;
  ordem: number;
  criado_em: string;
}

export interface ResultadoTeste {
  imap: boolean;
  smtp: boolean;
  erro?: string;
  falhaAutenticacao?: true;
}

export interface Pasta {
  caminho: string;
  nome: string;
  tipo: "entrada" | "enviados" | "lixeira" | "spam" | "rascunhos" | "arquivo" | null;
}

export interface Endereco {
  nome: string;
  endereco: string;
}

export interface ItemLista {
  uid: number;
  de: Endereco | null;
  assunto: string;
  data: string | null;
  lida: boolean;
  temAnexo: boolean;
  tamanho: number;
  /** ~160 caracteres do corpo em texto puro ("" se não houver). */
  previa?: string;
  /** \\Flagged (2.0). */
  estrela?: boolean;
}

export interface PaginaMensagens {
  mensagens: ItemLista[];
  pagina: number;
  porPagina: number;
  total: number;
}

export interface Anexo {
  parte: string;
  nome: string | null;
  tipo: string;
  tamanho: number;
  cid: string | null;
}

export interface Suspeita {
  classe: "spam" | "phishing";
  confianca: number;
  motivo: string;
}

export interface Mensagem {
  uid: number;
  pasta: string;
  de: Endereco | null;
  para: Endereco[];
  cc: Endereco[];
  responderPara: Endereco[];
  assunto: string;
  data: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  html: string | null;
  texto: string | null;
  anexos: Anexo[];
  lida: boolean;
  estrela?: boolean;
  tamanho: number;
  suspeita?: Suspeita | null;
}

export interface ResultadoEnvio {
  ok: true;
  messageId: string;
  enviados: { pasta: string; uid: number | null } | null;
  aviso?: string;
  rejeitados?: string[];
  rascunhoApagado?: boolean;
}

/** 202 de /enviar: agendada, ou falha passageira que foi para a Caixa de saída. */
export type RespostaEnvio =
  | ResultadoEnvio
  | { ok: true; agendado: true; saida: { id: number; agendarPara: string | null }; rascunhoApagado?: boolean }
  | { ok: false; enfileirado: true; erro: string; aviso: string; saida: { id: number }; rascunhoApagado?: boolean };
