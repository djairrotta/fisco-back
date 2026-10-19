import type { ReactNode } from "react";

export default function Badge({ tom = "neutro", children }: { tom?: "neutro" | "ok" | "aviso" | "perigo"; children: ReactNode }) {
  return <span className={`badge${tom === "neutro" ? "" : ` badge--${tom}`}`}>{children}</span>;
}
