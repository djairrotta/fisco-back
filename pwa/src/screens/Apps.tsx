import { Badge, Card } from "../ui";
import { dataHora, useCarga } from "../lib";

type Status = "running" | "stopped" | "error" | "unknown";
interface App {
  chave: string; projeto: string; servico: string; tipo: string; status: Status;
  replicas: number | null; cpu: number | null; memBytes: number | null; memPct: number | null;
  dominios: string[]; ultimaMudanca: string | null; reinicios: number; vistoEm: string | null;
}
interface Estado {
  ultimoOk: string | null; ultimaTentativa: string; falhasSeguidas: number;
  ultimoErro: string | null; procedimentos: Record<string, string | null>;
  transporte?: string | null; autenticacao?: string | null;
}
type Situacao = "nao_configurado" | "token_invalido" | "erro" | "ok" | "aguardando";
interface Dados { configurado: boolean; situacao?: Situacao; instrucoes?: string; estado: Estado | null; apps: App[] }

const SITUACAO: Record<Situacao, { rotulo: string; tom: "ok" | "aviso" | "perigo" | "neutro" }> = {
  ok: { rotulo: "ok", tom: "ok" },
  token_invalido: { rotulo: "token inválido", tom: "perigo" },
  nao_configurado: { rotulo: "não configurado", tom: "neutro" },
  erro: { rotulo: "sem resposta", tom: "aviso" },
  aguardando: { rotulo: "aguardando", tom: "neutro" },
};

const STATUS: Record<Status, string> = {
  running: "rodando", stopped: "parado", error: "com erro", unknown: "desconhecido",
};

const pct = (n: number) => `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
function memoria(b: number | null, p: number | null): string | null {
  if (b === null && p === null) return null;
  const partes: string[] = [];
  if (b !== null) {
    partes.push(b >= 1024 ** 3
      ? `${(b / 1024 ** 3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`
      : `${Math.round(b / 1024 ** 2)} MB`);
  }
  if (p !== null) partes.push(`(${pct(p)})`);
  return partes.join(" ");
}

function CardApp({ a }: { a: App }) {
  const mem = memoria(a.memBytes, a.memPct);
  const metricas = [
    a.cpu !== null ? `CPU ${pct(a.cpu)}` : null,
    mem ? `mem ${mem}` : null,
    a.replicas !== null ? `${a.replicas} réplica(s)` : null,
  ].filter(Boolean).join(" · ");
  return (
    <section aria-label={a.chave}>
      <Card>
        <div className="app-card__topo">
          <span className={`ponto ponto--${a.status}`} role="img" aria-label={`Status: ${STATUS[a.status]}`} />
          <div className="row__titulo">{a.chave}</div>
          <span className="app-card__tipo">{a.tipo}</span>
        </div>
        <p className="sub app-card__linha">{metricas || "Sem métricas do EasyPanel"}</p>
        {a.dominios.length > 0 ? (
          <ul className="app-card__dominios">
            {a.dominios.map((d) => <li key={d} className="mono">{d}</li>)}
          </ul>
        ) : (
          <p className="sub app-card__linha">Sem domínio</p>
        )}
        <p className="sub app-card__linha">
          {STATUS[a.status]} desde {dataHora(a.ultimaMudanca)} · {a.reinicios} reinício(s)
        </p>
      </Card>
    </section>
  );
}

export default function Apps() {
  const d = useCarga<Dados>("/api/apps", 30_000);
  const e = d.dados?.estado;
  return (
    <>
      <h1 className="titulo">Apps</h1>
      <p className="sub">
        Apps do EasyPanel, atualizados a cada 2 minutos. Avisa por push quando um app cai ou volta,
        quando reinicia demais e quando o painel para de responder.
      </p>
      {d.erro && <p className="erro-txt" role="alert">{d.erro}</p>}
      {d.dados && (() => {
        const s = SITUACAO[d.dados.situacao ?? (d.dados.configurado ? "aguardando" : "nao_configurado")];
        return <p className="sub">EasyPanel: <Badge tom={s.tom}>{s.rotulo}</Badge></p>;
      })()}
      {d.dados?.situacao === "token_invalido" && (
        <p className="erro-txt" role="alert">
          O EasyPanel recusou o token. Gere outro em Settings → API e atualize EASYPANEL_TOKEN no app do Vigia (Environment → Deploy).
        </p>
      )}

      {d.dados && !d.dados.configurado && (
        <Card>
          <div className="row__titulo" style={{ marginBottom: 8 }}>EasyPanel não configurado</div>
          <ol className="sub app-card__passos">
            <li>No EasyPanel, abra Settings → API e crie um token.</li>
            <li>
              No app do Vigia (EasyPanel → projeto → vigia) → Environment, defina{" "}
              <code>EASYPANEL_URL</code> (ex.: https://painel.judinfo.com.br) e <code>EASYPANEL_TOKEN</code>.
            </li>
            <li>Clique em Deploy. Os apps aparecem aqui em até 2 minutos.</li>
          </ol>
        </Card>
      )}

      {e && e.falhasSeguidas > 0 && d.dados?.situacao !== "token_invalido" && (
        <p className="erro-txt" role="alert">
          EasyPanel sem resposta: {e.ultimoErro ?? "erro desconhecido"} ({e.falhasSeguidas} falha(s) seguida(s)).
        </p>
      )}
      {d.dados?.configurado && (
        <p className="sub">
          {e?.ultimoOk ? `Última leitura ${dataHora(e.ultimoOk)}.` : "Aguardando a primeira leitura do EasyPanel."}
        </p>
      )}
      {d.dados?.configurado && d.dados.apps.length === 0 && !e?.falhasSeguidas && e?.ultimoOk && (
        <Card><p className="sub" style={{ margin: 0 }}>Nenhum app encontrado no EasyPanel.</p></Card>
      )}
      {d.dados?.apps.map((a) => <CardApp key={a.chave} a={a} />)}
    </>
  );
}
