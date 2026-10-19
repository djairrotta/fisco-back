// Regras da caixa (encaminhamento e resposta automática) como script Sieve
// "correio". O formulário vai também numa linha de comentário (JSON em
// base64url) para ser lido de volta sem interpretar o Sieve.
export const NOME_SCRIPT = "correio";
const MARCA = "# correio-dados: ";

export interface RegrasEncaminhar {
  ativo: boolean;
  para: string[];
  manterCopia: boolean;
}

export interface RegrasFerias {
  ativo: boolean;
  assunto: string;
  mensagem: string;
  /** AAAA-MM-DD, inclusive (fuso de Brasília). */
  inicio?: string;
  fim?: string;
  /** Intervalo mínimo entre respostas ao mesmo remetente, em dias. */
  dias: number;
}

export interface Regras {
  encaminhar: RegrasEncaminhar;
  ferias: RegrasFerias;
}

export function regrasPadrao(): Regras {
  return {
    encaminhar: { ativo: false, para: [], manterCopia: true },
    ferias: { ativo: false, assunto: "", mensagem: "", dias: 1 },
  };
}

/** Sem DDS: o Brasil não tem horário de verão desde 2019. */
export const FUSO_SIEVE = "-0300";
/** Teto padrão de redirecionamentos do Pigeonhole (sieve_max_redirects). */
export const MAX_REDIRECTS_PADRAO = 4;

const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export function emailValido(s: string): boolean {
  return s.length <= 254 && EMAIL.test(s);
}

// deno-lint-ignore no-control-regex
const CONTROLE_LINHA = /[\x00-\x1f\x7f]+/g;
// deno-lint-ignore no-control-regex
const CONTROLE_TEXTO = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** String Sieve entre aspas: só \ e " precisam de escape (RFC 5228 §2.4.2). */
export function stringSieve(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Texto de uma linha (assunto): sem controles nem quebras. */
export function umaLinha(s: string): string {
  return s.replace(CONTROLE_LINHA, " ").replace(/\s+/g, " ").trim();
}

/** Texto multilinha (mensagem): quebras viram CRLF; outros controles somem. */
export function multilinha(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(CONTROLE_TEXTO, "").trim()
    .replace(/\n/g, "\r\n");
}

function b64url(s: string): string {
  const b = new TextEncoder().encode(s);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deB64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export interface ScriptGerado {
  script: string;
  avisos: string[];
  /** Há alguma regra ligada (o script deve ficar ativo). */
  temRegra: boolean;
}

/**
 * Gera o script. `extensoes` são as do servidor (capacidades SIEVE). Sem
 * date/relational, a resposta automática sai sem período (com aviso); sem
 * copy, "manter cópia" vira redirect + keep. Quem chama já validou
 * endereços e exige "vacation" quando as férias estão ligadas.
 */
export function gerarScript(
  r: Regras,
  o: { extensoes: Set<string>; endereco: string },
): ScriptGerado {
  const avisos: string[] = [];
  const req = new Set<string>();
  const corpo: string[] = [];
  const f = r.ferias;
  const enc = r.encaminhar;

  if (f.ativo) {
    req.add("vacation");
    const conds: string[] = [];
    if (f.inicio || f.fim) {
      if (o.extensoes.has("date") && o.extensoes.has("relational")) {
        req.add("date");
        req.add("relational");
        if (f.inicio) {
          conds.push(
            `currentdate :zone ${stringSieve(FUSO_SIEVE)} :value "ge" "date" ${
              stringSieve(f.inicio)
            }`,
          );
        }
        if (f.fim) {
          conds.push(
            `currentdate :zone ${stringSieve(FUSO_SIEVE)} :value "le" "date" ${
              stringSieve(f.fim)
            }`,
          );
        }
      } else {
        avisos.push(
          "O servidor não aceita datas no filtro (extensões date/relational); a resposta automática fica ligada até você desligá-la.",
        );
      }
    }
    const acao = [
      "vacation",
      `:days ${Math.max(1, Math.min(30, Math.trunc(f.dias) || 1))}`,
      ...(umaLinha(f.assunto)
        ? [`:subject ${stringSieve(umaLinha(f.assunto))}`]
        : []),
      `:addresses [${stringSieve(o.endereco)}]`,
      stringSieve(multilinha(f.mensagem)),
    ].join(" ") + ";";
    if (conds.length) {
      corpo.push(
        `if ${conds.length > 1 ? `allof(${conds.join(", ")})` : conds[0]} {`,
        `  ${acao}`,
        "}",
      );
    } else corpo.push(acao);
  }

  if (enc.ativo && enc.para.length) {
    const copia = enc.manterCopia && o.extensoes.has("copy");
    if (copia) req.add("copy");
    for (const p of enc.para) {
      corpo.push(`redirect ${copia ? ":copy " : ""}${stringSieve(p)};`);
    }
    if (enc.manterCopia && !copia) corpo.push("keep;");
  }

  const dados = b64url(JSON.stringify(r));
  const linhas = [
    "# Gerado pelo Correio — alterações feitas à mão serão substituídas.",
    `${MARCA}${dados}`,
  ];
  if (req.size) {
    linhas.push(`require [${[...req].sort().map(stringSieve).join(", ")}];`);
  }
  linhas.push(...corpo);
  return {
    script: linhas.join("\r\n") + "\r\n",
    avisos,
    temRegra: corpo.length > 0,
  };
}

/** O formulário guardado no script; null se não é um script do Correio. */
export function lerDadosScript(script: string): Regras | null {
  const l = script.split(/\r?\n/).find((x) => x.startsWith(MARCA));
  if (!l) return null;
  try {
    const j = JSON.parse(deB64url(l.slice(MARCA.length).trim()));
    const p = regrasPadrao();
    const e = j?.encaminhar ?? {};
    const f = j?.ferias ?? {};
    return {
      encaminhar: {
        ativo: e.ativo === true,
        para: Array.isArray(e.para)
          ? e.para.filter((x: unknown) => typeof x === "string")
          : [],
        manterCopia: e.manterCopia !== false,
      },
      ferias: {
        ativo: f.ativo === true,
        assunto: typeof f.assunto === "string" ? f.assunto : "",
        mensagem: typeof f.mensagem === "string" ? f.mensagem : "",
        ...(typeof f.inicio === "string" ? { inicio: f.inicio } : {}),
        ...(typeof f.fim === "string" ? { fim: f.fim } : {}),
        dias: Number.isInteger(f.dias) ? f.dias : p.ferias.dias,
      },
    };
  } catch {
    return null;
  }
}
