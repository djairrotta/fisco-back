import type { ButtonHTMLAttributes } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: "primario" | "secundario" | "perigo";
  bloco?: boolean;
}

export default function Button({ variante = "primario", bloco, className = "", ...rest }: Props) {
  const cls = ["btn", variante !== "primario" && `btn--${variante}`, bloco && "btn--block", className]
    .filter(Boolean)
    .join(" ");
  return <button type="button" className={cls} {...rest} />;
}
