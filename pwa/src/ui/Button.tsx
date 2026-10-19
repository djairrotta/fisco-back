import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import Icone, { type NomeIcone } from "./Icone";

type Variante = "liquido" | "cinza" | "simples" | "perigo" | "primario" | "secundario";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * liquido: metal líquido no acento (só ações primárias: Escrever, Enviar);
   * cinza: preenchimento neutro; simples: só texto/ícone; perigo: destrutiva.
   * "primario"/"secundario" são nomes antigos (= liquido / cinza).
   */
  variante?: Variante;
  tam?: "p" | "m" | "g";
  bloco?: boolean;
  icone?: NomeIcone;
  children?: ReactNode;
}

const NORMAL: Record<Variante, string> = {
  liquido: "liquido", primario: "liquido", cinza: "cinza", secundario: "cinza", simples: "simples", perigo: "perigo",
};

const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variante = "cinza", tam = "m", bloco, icone, className = "", children, ...rest }, ref,
) {
  const cls = ["btn", `btn--${NORMAL[variante]}`, `btn--${tam}`, bloco && "btn--bloco", className].filter(Boolean).join(" ");
  return (
    <button ref={ref} type="button" className={cls} {...rest}>
      {icone && <Icone nome={icone} tam={tam === "p" ? 15 : 17} />}
      {children != null && <span className="btn__txt">{children}</span>}
    </button>
  );
});
export default Button;

/** Botão só de ícone (barras de ferramentas). O rótulo vira aria-label e dica. */
export const BotaoIcone = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  icone: NomeIcone; rotulo: string; tam?: number; ativo?: boolean; atalho?: string;
}>(function BotaoIcone({ icone, rotulo, tam = 18, ativo, atalho, className = "", ...rest }, ref) {
  return (
    <button ref={ref} type="button" aria-label={rotulo} title={atalho ? `${rotulo} (${atalho})` : rotulo}
      className={`bico${ativo ? " bico--ativo" : ""} ${className}`.trim()} {...rest}>
      <Icone nome={icone} tam={tam} />
    </button>
  );
});
