import type { ReactNode } from "react";
import Icone, { type NomeIcone } from "./Icone";

/** Esqueleto da lista de mensagens (mesma forma das linhas reais). */
export function EsqueletoLista({ n = 8 }: { n?: number }) {
  const larguras = [62, 48, 70, 55, 66, 44, 58, 50, 64, 52];
  return (
    <ul className="esq-lista" aria-label="Carregando mensagens" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="esq-linha">
          <span className="esq esq--avatar" />
          <span className="esq-linha__txt">
            <span className="esq-linha__l1"><span className="esq" style={{ width: `${larguras[i % 10] - 18}%` }} /><span className="esq esq--hora" /></span>
            <span className="esq" style={{ width: `${larguras[(i + 3) % 10]}%` }} />
            <span className="esq esq--fraco" style={{ width: `${larguras[(i + 5) % 10] + 20}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EsqueletoLeitura() {
  return (
    <div className="esq-leitura" aria-busy="true" aria-label="Carregando mensagem">
      <span className="esq esq--titulo" />
      <div className="esq-leitura__de"><span className="esq esq--avatar-g" /><span className="esq-leitura__l"><span className="esq" style={{ width: 180 }} /><span className="esq esq--fraco" style={{ width: 240 }} /></span></div>
      {[92, 86, 95, 70, 0, 88, 93, 60].map((w, i) => w ? <span key={i} className="esq esq--fraco" style={{ width: `${w}%` }} /> : <br key={i} />)}
    </div>
  );
}

/** Estado vazio: convite a agir, não humor. */
export function Vazio({ icone, titulo, texto, acao }: { icone: NomeIcone; titulo: string; texto?: ReactNode; acao?: ReactNode }) {
  return (
    <div className="vazio">
      <span className="vazio__ic"><Icone nome={icone} tam={26} /></span>
      <h2 className="vazio__titulo">{titulo}</h2>
      {texto && <p className="vazio__texto">{texto}</p>}
      {acao}
    </div>
  );
}
