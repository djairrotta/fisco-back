import { Link } from "react-router-dom";

export interface Tile {
  rotulo: string;
  valor: number | null;
  to?: string;
  tom?: "ok" | "warn" | "perigo";
  /** Mosaico de severidade (achados abertos). */
  sev?: { alta: number; media: number; baixa: number };
}

function Conteudo({ t }: { t: Tile }) {
  return (
    <>
      <span className={`tile__num${t.tom ? ` tile__num--${t.tom}` : ""}`}>
        {t.valor == null ? "—" : t.valor.toLocaleString("pt-BR")}
      </span>
      <span className="tile__rot">{t.rotulo}</span>
      {t.sev && (t.sev.alta + t.sev.media + t.sev.baixa > 0) && (
        <span className="tile__sev">
          {t.sev.alta > 0 && <span className="sevdot sevdot--alta"><i />{t.sev.alta}</span>}
          {t.sev.media > 0 && <span className="sevdot sevdot--media"><i />{t.sev.media}</span>}
          {t.sev.baixa > 0 && <span className="sevdot sevdot--baixa"><i />{t.sev.baixa}</span>}
        </span>
      )}
    </>
  );
}

export default function StatTiles({ tiles, carregando }: { tiles: Tile[]; carregando?: boolean }) {
  if (carregando) {
    return (
      <div className="tiles" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="sk sk-tile" />)}
      </div>
    );
  }
  return (
    <div className="tiles">
      {tiles.map((t) => (
        t.to
          ? <Link key={t.rotulo} to={t.to} className="tile"><Conteudo t={t} /></Link>
          : <div key={t.rotulo} className="tile"><Conteudo t={t} /></div>
      ))}
    </div>
  );
}
