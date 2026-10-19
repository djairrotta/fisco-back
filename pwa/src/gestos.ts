// Física dos gestos (Designing Fluid Interfaces, WWDC 2018), sem React:
// resistência nas bordas, projeção de momento e a decisão do deslize de linhas.

/** Borracha: quanto mais passa do limite, menos acompanha. */
export function resistencia(excesso: number, dimensao: number, c = 0.55): number {
  return (excesso * dimensao * c) / (dimensao + c * Math.abs(excesso));
}

/** Para onde o gesto vai parar (decaimento exponencial, como a rolagem). */
export function projetar(velocidade: number, desaceleracao = 0.99): number {
  return ((velocidade / 1000) * desaceleracao) / (1 - desaceleracao);
}

/** Direção dominante após o limiar de 10 px (null = ainda indeciso). */
export function direcaoGesto(dx: number, dy: number, limiar = 10): "h" | "v" | null {
  if (Math.abs(dx) < limiar && Math.abs(dy) < limiar) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "h" : "v";
}

export const LARGURA_ACAO = 74;

export type LadoArrasto = "inicio" | "fim";
export interface DecisaoArrasto {
  /** Lado que fica aberto ("inicio" = ações à esquerda, puxando para a direita). */
  aberto: LadoArrasto | null;
  /** Deslize completo: executa a primeira ação daquele lado. */
  executar: LadoArrasto | null;
}

/**
 * Ao soltar a linha: projeta o momento e escolhe entre fechar, deixar as
 * ações à mostra ou executar a principal (deslize longo).
 */
export function decidirArrasto(dx: number, velocidade: number, largura: number, nAcoes = 2): DecisaoArrasto {
  const destino = dx + projetar(velocidade, 0.985);
  const lado: LadoArrasto = destino > 0 ? "inicio" : "fim";
  const d = Math.abs(destino);
  // o deslize completo exige que o próprio dedo tenha ido longe (não só o momento)
  if (d > largura * 0.62 && Math.abs(dx) > largura * 0.4) return { aberto: null, executar: lado };
  if (d > (nAcoes * LARGURA_ACAO) / 2) return { aberto: lado, executar: null };
  return { aberto: null, executar: null };
}

/** Deslocamento visual enquanto arrasta: 1:1 até o fim das ações, depois resiste (sem deslize completo). */
export function deslocamento(dx: number, largura: number, nAcoes = 2, permitirCompleto = true): number {
  const lim = nAcoes * LARGURA_ACAO;
  if (permitirCompleto || Math.abs(dx) <= lim) return Math.max(-largura, Math.min(largura, dx));
  const s = Math.sign(dx);
  return s * (lim + resistencia(Math.abs(dx) - lim, largura));
}
