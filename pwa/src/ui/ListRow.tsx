import type { ReactNode } from "react";

export default function ListRow({
  titulo, detalhe, fim, onClick, fimAbaixo = false,
}: {
  titulo: ReactNode; detalhe?: ReactNode; fim?: ReactNode; onClick?: () => void;
  /** Selos/botões numa linha própria, abaixo do texto (que fica com a largura toda). */
  fimAbaixo?: boolean;
}) {
  const cls = `row${onClick ? " row--click" : ""}${fimAbaixo ? " row--selos" : ""}`;
  const corpo = (
    <>
      <div className="row__main">
        <div className="row__titulo">{titulo}</div>
        {detalhe != null && <div className="row__detalhe">{detalhe}</div>}
      </div>
      {fim != null && <div className="row__fim">{fim}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>{corpo}</button>
  ) : (
    <div className={cls}>{corpo}</div>
  );
}
