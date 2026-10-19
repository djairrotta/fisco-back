import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BotaoIcone, Icone } from "../ui";
import { useShell } from "../shell/contexto";

/** Moldura das telas de ajustes: título em serifa, voltar opcional, largura de leitura. */
export default function Pagina({ titulo, sub, voltar, children, acao, largura }: {
  titulo: ReactNode; sub?: ReactNode; voltar?: { rotulo: string; href: string }; children: ReactNode; acao?: ReactNode; largura?: "larga";
}) {
  const { layout, abrirGaveta } = useShell();
  return (
    <div className={`pagina${largura ? " pagina--larga" : ""}`}>
      <div className="pagina__rolagem">
        <div className="pagina__barra">
          {layout === "duas" && <BotaoIcone icone="lateral" rotulo="Mostrar pastas" onClick={abrirGaveta} />}
          {voltar && <Link className="voltar" to={voltar.href}><Icone nome="voltar" tam={22} /><span>{voltar.rotulo}</span></Link>}
          <span className="barra-esp" />
          {acao}
        </div>
        <header className="pagina__cab">
          <h1 className="pagina__titulo">{titulo}</h1>
          {sub && <p className="pagina__sub">{sub}</p>}
        </header>
        <div className="pagina__corpo">{children}</div>
      </div>
    </div>
  );
}
