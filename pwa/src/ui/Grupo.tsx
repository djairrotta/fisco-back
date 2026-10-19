import type { HTMLAttributes, ReactNode } from "react";
import Icone, { type NomeIcone } from "./Icone";

/** Grupo de linhas em cartão (estilo Ajustes): título opcional acima e nota abaixo. */
export function Grupo({ titulo, nota, children, className = "", ...rest }:
  { titulo?: ReactNode; nota?: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`grupo ${className}`.trim()} {...rest}>
      {titulo != null && <h2 className="grupo__titulo">{titulo}</h2>}
      <div className="grupo__corpo">{children}</div>
      {nota != null && <p className="grupo__nota">{nota}</p>}
    </section>
  );
}

/** Cartão neutro (compatibilidade): um grupo sem título. */
export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`grupo__corpo grupo__corpo--solto ${className}`.trim()} {...rest} />;
}

/** Linha de lista de ajustes: ícone opcional, título, detalhe e conteúdo à direita. */
export function ListRow({ titulo, detalhe, fim, onClick, icone, seta }: {
  titulo: ReactNode; detalhe?: ReactNode; fim?: ReactNode; onClick?: () => void; icone?: ReactNode | NomeIcone; seta?: boolean;
}) {
  const ic = typeof icone === "string" ? <span className="row__ic"><Icone nome={icone as NomeIcone} tam={17} /></span> : icone;
  const corpo = (
    <>
      {ic}
      <div className="row__main">
        <div className="row__titulo">{titulo}</div>
        {detalhe != null && <div className="row__detalhe">{detalhe}</div>}
      </div>
      {fim != null && <div className="row__fim">{fim}</div>}
      {seta && <Icone nome="avancar" tam={16} className="row__seta" />}
    </>
  );
  return onClick ? (
    <button type="button" className="row row--click" onClick={onClick}>{corpo}</button>
  ) : (
    <div className="row">{corpo}</div>
  );
}

export function Badge({ tom = "neutro", children }: { tom?: "neutro" | "ok" | "aviso" | "perigo"; children: ReactNode }) {
  return <span className={`selo selo--${tom}`}>{children}</span>;
}

/** Campo com rótulo acima, ajuda e erro abaixo. */
export function Campo({ rotulo, ajuda, erro, children }: { rotulo: ReactNode; ajuda?: ReactNode; erro?: ReactNode; children: ReactNode }) {
  return (
    <label className="campo-bloco">
      <span className="campo-bloco__rotulo">{rotulo}</span>
      {children}
      {ajuda != null && <span className="campo-bloco__ajuda">{ajuda}</span>}
      {erro ? <span className="campo-bloco__erro" role="alert">{erro}</span> : null}
    </label>
  );
}
