// Validação de logo e favicon pelos bytes iniciais (magic bytes), nunca pela
// extensão ou pelo Content-Type enviado. SVG é recusado (pode conter script).

export type TipoImagem = "logo" | "favicon";

/** Regra do Djair (2.0): logo e favicon até 2 MB cada. */
export const LIMITE_IMAGEM = 2 * 1024 * 1024;
export const LIMITE_LOGO = LIMITE_IMAGEM;
export const LIMITE_FAVICON = LIMITE_IMAGEM;

export const LIMITES: Record<TipoImagem, number> = {
  logo: LIMITE_LOGO,
  favicon: LIMITE_FAVICON,
};

const ACEITOS: Record<TipoImagem, string[]> = {
  logo: ["image/png", "image/jpeg", "image/webp"],
  // ICO continua aceito no favicon (compatibilidade com 1.0)
  favicon: ["image/png", "image/jpeg", "image/webp", "image/x-icon"],
};

export const MENSAGEM: Record<TipoImagem, string> = {
  logo: "O logo deve ser PNG, JPEG ou WebP, até 2 MB.",
  favicon:
    "O favicon deve ser PNG, JPEG ou WebP, até 2 MB (ICO também é aceito).",
};

const comeca = (b: Uint8Array, sig: number[], desde = 0) =>
  b.length >= desde + sig.length && sig.every((x, i) => b[desde + i] === x);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** MIME pelo cabeçalho do arquivo, ou null se não for um formato aceito. */
export function detectarMime(b: Uint8Array): string | null {
  if (comeca(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (comeca(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (comeca(b, ascii("RIFF")) && comeca(b, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  // ICONDIR: reservado 0, tipo 1 (ícone), quantidade ≥ 1
  if (comeca(b, [0, 0, 1, 0]) && b.length >= 6 && (b[4] | (b[5] << 8)) > 0) {
    return "image/x-icon";
  }
  return null;
}

export function validarImagem(
  bytes: Uint8Array,
  tipo: TipoImagem,
): { ok: true; mime: string } | { ok: false; motivo: string } {
  if (bytes.length === 0 || bytes.length > LIMITES[tipo]) {
    return { ok: false, motivo: MENSAGEM[tipo] };
  }
  const mime = detectarMime(bytes);
  if (mime === null || !ACEITOS[tipo].includes(mime)) {
    return { ok: false, motivo: MENSAGEM[tipo] };
  }
  return { ok: true, mime };
}
