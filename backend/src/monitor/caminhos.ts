/** Caminho sem query string nem fragmento. */
export function soCaminho(c: string): string {
  const i = c.search(/[?#]/);
  return i < 0 ? c : c.slice(0, i);
}

/** Glob simples: só `*` no fim (prefixo); caso contrário, igualdade exata. */
export function casaExcecao(caminho: string, padrao: string): boolean {
  const c = soCaminho(caminho);
  if (padrao.endsWith("*")) return c.startsWith(padrao.slice(0, -1));
  return c === padrao;
}
