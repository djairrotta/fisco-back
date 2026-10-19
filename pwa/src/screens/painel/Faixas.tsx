import { Link } from "react-router-dom";
import { Badge, Card } from "../../ui";
import { dataHora } from "../../lib";

type Status = "running" | "stopped" | "error" | "unknown";
export interface AppApp {
  chave: string; status: Status; cpu: number | null; memPct: number | null; dominios: string[];
}
const STATUS: Record<Status, string> = {
  running: "rodando", stopped: "parado", error: "com erro", unknown: "desconhecido",
};

/** Saúde dos apps (resumo): no ar / problemas, com as linhas que exigem atenção primeiro. */
export function FaixaApps({ apps, configurado }: { apps: AppApp[]; configurado: boolean }) {
  if (!configurado) {
    return (
      <Card>
        <h2 className="secao" style={{ margin: "0 0 8px" }}>Saúde dos apps</h2>
        <p className="sub" style={{ margin: 0 }}>
          EasyPanel não configurado. <Link to="/apps">Configurar</Link>
        </p>
      </Card>
    );
  }
  const ordenados = [...apps].sort((a, b) =>
    (a.status === "running" ? 1 : 0) - (b.status === "running" ? 1 : 0));
  return (
    <Card>
      <h2 className="secao" style={{ margin: "0 0 8px" }}>
        Saúde dos apps <Link to="/apps" style={{ float: "right", fontWeight: 400 }}>ver todos</Link>
      </h2>
      {ordenados.length === 0 && <p className="sub" style={{ margin: 0 }}>Nenhum app no EasyPanel.</p>}
      {ordenados.slice(0, 6).map((a) => (
        <div className="faixa-app" key={a.chave}>
          <span className={`ponto ponto--${a.status}`} role="img" aria-label={`Status: ${STATUS[a.status]}`} />
          <span className="faixa-app__nome">{a.chave}</span>
          <span className="faixa-app__met">
            {a.status === "running"
              ? [a.cpu != null ? `CPU ${a.cpu.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%` : null,
                 a.memPct != null ? `mem ${a.memPct.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%` : null]
                .filter(Boolean).join(" · ") || "no ar"
              : STATUS[a.status]}
          </span>
        </div>
      ))}
    </Card>
  );
}

type Sev = "baixa" | "media" | "alta";
interface Achado { id: number; severidade: Sev; titulo: string; host?: string; firstSeen: string | null }
const TOM: Record<Sev, "perigo" | "aviso" | "neutro"> = { alta: "perigo", media: "aviso", baixa: "neutro" };
const ROT: Record<Sev, string> = { alta: "Alta", media: "Média", baixa: "Baixa" };

/** Auditoria: achados abertos mais recentes, com a severidade. */
export function FaixaAuditoria({ grupos }: { grupos: { host: string; achados: Achado[] }[] }) {
  const todos = grupos.flatMap((g) => g.achados.map((a) => ({ ...a, host: g.host })));
  const recentes = [...todos].sort((a, b) =>
    (b.firstSeen ?? "").localeCompare(a.firstSeen ?? "")).slice(0, 5);
  return (
    <Card>
      <h2 className="secao" style={{ margin: "0 0 8px" }}>
        Auditoria <Link to="/auditoria" style={{ float: "right", fontWeight: 400 }}>ver tudo</Link>
      </h2>
      {recentes.length === 0 && <p className="sub" style={{ margin: 0 }}>Nenhum achado aberto.</p>}
      {recentes.map((a) => (
        <div className="estado-linha" key={a.id}>
          <span className="estado-linha__rot" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {a.titulo}<br /><span className="sub" style={{ margin: 0, fontSize: 12 }}>{a.host}</span>
          </span>
          <Badge tom={TOM[a.severidade]}>{ROT[a.severidade]}</Badge>
        </div>
      ))}
    </Card>
  );
}

export interface Protecoes {
  geoAtivo: boolean; bloqueioAutoAtivo: boolean; modoObservacao: boolean; modoObservacaoAte: string | null;
}
/** Estado das defesas: geo (fora do Brasil), bloqueio automático e observação. */
export function EstadoProtecoes({ p }: { p: Protecoes }) {
  return (
    <Card>
      <h2 className="secao" style={{ margin: "0 0 8px" }}>Defesas</h2>
      <div className="estado-linha">
        <span className="estado-linha__rot">Fora do Brasil (geo)</span>
        <Badge tom={p.geoAtivo ? "ok" : "neutro"}>{p.geoAtivo ? "ativo" : "inativo"}</Badge>
      </div>
      <div className="estado-linha">
        <span className="estado-linha__rot">Bloqueio automático</span>
        <Badge tom={p.bloqueioAutoAtivo ? "ok" : "aviso"}>{p.bloqueioAutoAtivo ? "ativo" : "desligado"}</Badge>
      </div>
      <div className="estado-linha">
        <span className="estado-linha__rot">Modo observação</span>
        <Badge tom={p.modoObservacao ? "aviso" : "neutro"}>
          {p.modoObservacao ? `até ${dataHora(p.modoObservacaoAte)}` : "desligado"}
        </Badge>
      </div>
    </Card>
  );
}
