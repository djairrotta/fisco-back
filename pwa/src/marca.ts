import { useEffect } from "react";
import type { Caixa } from "./tipos";

export const ICONE_APP = "/icons/icon-192.png";
export const ACENTO_PADRAO = "#0a84ff";
const COR = /^#[0-9a-f]{6}$/i;

export const nomeCaixa = (c: Pick<Caixa, "nome_exibicao" | "endereco">): string =>
  c.nome_exibicao?.trim() || c.endereco;

/** Texto legível sobre o acento: escuro em cores claras (ex.: amarelo), branco nas demais. */
export function corTexto(hex: string): string {
  if (!COR.test(hex)) return "#fff";
  const canal = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
  return l > 0.45 ? "#1c1c1e" : "#fff";
}

/** URL do favicon da caixa (com versão para furar o cache após upload), ou o ícone do app. */
export function urlFavicon(c: Pick<Caixa, "id" | "tem_favicon"> | null, versao = 0): string {
  if (!c || !c.tem_favicon) return ICONE_APP;
  return `/api/marca/${c.id}/favicon${versao ? `?v=${versao}` : ""}`;
}

export function urlLogo(c: Pick<Caixa, "id" | "tem_logo">, versao = 0): string | null {
  return c.tem_logo ? `/api/marca/${c.id}/logo${versao ? `?v=${versao}` : ""}` : null;
}

/**
 * Aplica a marca da caixa ativa ao documento: `--acento` (e `--acento-texto`),
 * `document.title` e o `<link rel=icon>`. Sem caixa, volta ao Correio neutro.
 */
export function aplicarMarca(c: Caixa | null, versao = 0, doc: Document = document): void {
  const raiz = doc.documentElement;
  const acento = c?.cor && COR.test(c.cor) ? c.cor.toLowerCase() : ACENTO_PADRAO;
  raiz.style.setProperty("--acento", acento);
  raiz.style.setProperty("--acento-texto", corTexto(acento));
  doc.title = c ? `${nomeCaixa(c)} — Correio` : "Correio";
  let link = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = doc.createElement("link");
    link.rel = "icon";
    doc.head.appendChild(link);
  }
  const href = urlFavicon(c, versao);
  link.href = href;
  // favicon da caixa pode faltar/falhar: o navegador cai no ícone do app
  link.onerror = href === ICONE_APP ? null : () => { link!.href = ICONE_APP; };
}

/** Hook de marca: reaplica ao trocar de caixa ou quando cor/nome/favicon mudam. */
export function useMarca(c: Caixa | null, versao = 0): void {
  const chave = c ? `${c.id}|${c.cor}|${c.nome_exibicao}|${c.endereco}|${c.tem_favicon}` : "";
  useEffect(() => {
    aplicarMarca(c, versao);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, versao]);
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/**
 * Cor dominante de pixels RGBA: ignora transparentes, quase brancos/pretos e
 * cinzas; agrupa em baldes (4 bits por canal) ponderados pela saturação e
 * devolve a média do balde vencedor. Sem pixels coloridos, usa o tom
 * opaco mais frequente; null se a imagem for vazia/branca.
 */
export function corDominanteDePixels(d: Uint8ClampedArray | Uint8Array): string | null {
  const baldes = new Map<number, { peso: number; r: number; g: number; b: number }>();
  const neutros = new Map<number, { peso: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a < 128) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (min > 235) continue; // branco/fundo
    const chave = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const sat = max === 0 ? 0 : (max - min) / max;
    const alvo = max - min < 28 || max < 24 ? neutros : baldes;
    const peso = alvo === baldes ? 0.4 + sat : 1;
    const x = alvo.get(chave) ?? { peso: 0, r: 0, g: 0, b: 0 };
    x.peso += peso; x.r += r * peso; x.g += g * peso; x.b += b * peso;
    alvo.set(chave, x);
  }
  const fonte = baldes.size ? baldes : neutros;
  let melhor: { peso: number; r: number; g: number; b: number } | null = null;
  for (const v of fonte.values()) if (!melhor || v.peso > melhor.peso) melhor = v;
  if (!melhor) return null;
  return `#${hex2(melhor.r / melhor.peso)}${hex2(melhor.g / melhor.peso)}${hex2(melhor.b / melhor.peso)}`;
}

/** Carrega a imagem (mesma origem) num canvas e calcula a cor dominante. */
export function corDoLogo(url: string): Promise<string | null> {
  return new Promise((ok, falha) => {
    const img = new Image();
    img.onload = () => {
      try {
        const lado = 64;
        const cv = document.createElement("canvas");
        cv.width = lado; cv.height = lado;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) return ok(null);
        ctx.drawImage(img, 0, 0, lado, lado);
        ok(corDominanteDePixels(ctx.getImageData(0, 0, lado, lado).data));
      } catch (e) {
        falha(e);
      }
    };
    img.onerror = () => falha(new Error("Não foi possível carregar o logo"));
    img.src = url;
  });
}
