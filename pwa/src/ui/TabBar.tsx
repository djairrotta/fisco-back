import { NavLink } from "react-router-dom";
import type { ReactElement } from "react";

const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24" } as const;
const abas: { to: string; rotulo: string; end?: boolean; icone: ReactElement; classe?: string }[] = [
  { to: "/", rotulo: "Painel", end: true, icone: <svg {...p}><path d="M4 13a8 8 0 1 1 16 0M12 13l4-4M5 20h14" /></svg> },
  { to: "/incidentes", rotulo: "Incidentes", icone: <svg {...p}><path d="M12 3 2.5 20h19L12 3zM12 10v4M12 17.2v.1" /></svg> },
  { to: "/bloqueios", rotulo: "Bloqueios", icone: <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg> },
  { to: "/regras", rotulo: "Regras", icone: <svg {...p}><path d="M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6l8-3z" /></svg> },
  { to: "/apps", rotulo: "Apps", icone: <svg {...p}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg> },
  { to: "/servidor", rotulo: "Servidor", icone: <svg {...p}><rect x="4" y="3" width="16" height="7" rx="1.5" /><rect x="4" y="14" width="16" height="7" rx="1.5" /><path d="M8 6.5h4M8 17.5h4M16 6.5h.01M16 17.5h.01" /></svg> },
  { to: "/auditoria", rotulo: "Auditoria", icone: <svg {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21M7.8 10.6l1.9 1.9 3.6-3.8" /></svg> },
  { to: "/codigo", rotulo: "Código", icone: <svg {...p}><path d="M8 7l-4 5 4 5M16 7l4 5-4 5M13 5l-2 14" /></svg> },
  { to: "/conector", rotulo: "Conector", icone: <svg {...p}><path d="M7 8V5a2 2 0 0 1 2-2h0M17 8V5a2 2 0 0 0-2-2M5 8h14v3a7 7 0 0 1-14 0zM12 18v3" /></svg> },
  {
    to: "/ataque", rotulo: "Ataque", classe: "aba-ataque",
    icone: (
      <svg {...p} style={{ color: "var(--crimson)" }}>
        <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
    ),
  },
  { to: "/config", rotulo: "Config", icone: <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg> },
];

export default function TabBar() {
  return (
    <nav className="tabbar" aria-label="Navegação principal">
      {abas.map((a) => (
        <NavLink key={a.to} to={a.to} end={a.end} className={a.classe}>
          {a.icone}
          <span>{a.rotulo}</span>
        </NavLink>
      ))}
    </nav>
  );
}
