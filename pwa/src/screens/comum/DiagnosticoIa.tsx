import { dataHora } from "../../lib";

export interface Diagnostico { ultimoOkEm?: string | null; ultimoErroEm?: string | null; ultimoErro?: string | null }

/** Última chamada bem-sucedida e último erro (com o motivo preciso) de um papel de IA. */
export default function DiagnosticoIa({ d }: { d: Diagnostico }) {
  if (!d.ultimoOkEm && !d.ultimoErroEm) {
    return <div className="row__detalhe">Diagnóstico: sem chamadas registradas</div>;
  }
  return (
    <>
      {d.ultimoOkEm && <div className="row__detalhe">Último ok: {dataHora(d.ultimoOkEm)}</div>}
      {d.ultimoErroEm && (
        <div className="row__detalhe diag-erro">Último erro: {dataHora(d.ultimoErroEm)} · {d.ultimoErro ?? "?"}</div>
      )}
    </>
  );
}
