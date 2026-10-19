import { useState } from "react";
import type { Caixa } from "../tipos";
import { urlLogo } from "../marca";

/** Logo da caixa sobre placa clara, ou monograma do domínio na cor da caixa. */
export default function Avatar({ caixa, tam = 40, versao = 0 }: { caixa: Caixa; tam?: number; versao?: number }) {
  const [falhou, setFalhou] = useState(false);
  const url = urlLogo(caixa, versao);
  const estilo = { width: tam, height: tam, borderRadius: Math.round(tam * 0.26) };
  if (url && !falhou) {
    return <img className="avatar" src={url} alt="" style={estilo} onError={() => setFalhou(true)} />;
  }
  const inicial = (caixa.dominio || caixa.endereco.split("@")[1] || "?").charAt(0).toUpperCase();
  return (
    <span className="avatar avatar--mono" aria-hidden="true"
      style={{ ...estilo, fontSize: Math.round(tam * 0.46), background: caixa.cor ?? "var(--acento)" }}>
      {inicial}
    </span>
  );
}

/** Iniciais do remetente (estilo Contatos: grafite neutro, sem cor por pessoa). */
export function Monograma({ nome, tam = 36 }: { nome: string; tam?: number }) {
  const limpo = nome.replace(/["'<>()[\]]/g, " ").trim();
  const partes = limpo.includes("@") ? [limpo.split("@")[0]] : limpo.split(/\s+/).filter((p) => /^\p{L}/u.test(p) && !/^(de|da|do|dos|das|e|dr\.?|dra\.?)$/i.test(p));
  const ini = partes.length > 1 ? partes[0][0] + partes[partes.length - 1][0] : (partes[0] ?? "?").slice(0, 1);
  return (
    <span className="mono" aria-hidden="true" style={{ width: tam, height: tam, fontSize: Math.round(tam * 0.39) }}>
      {ini.toUpperCase()}
    </span>
  );
}
