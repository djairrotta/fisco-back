import { Link } from "react-router-dom";
import { Badge, Card } from "../ui";
import { dataHora, useCarga } from "../lib";
import Sparkline from "./painel/Sparkline";
import StatTiles, { type Tile } from "./painel/StatTiles";
import TopIps, { type TopIp } from "./painel/TopIps";
import Ranking from "./painel/Ranking";
import { type AppApp, EstadoProtecoes, FaixaApps, FaixaAuditoria, type Protecoes } from "./painel/Faixas";
import DiagnosticoIa, { type Diagnostico } from "./comum/DiagnosticoIa";

interface PainelDados {
  ataquesHora: { h: string; n: number }[];
  topIps: TopIp[];
  paises: { pais: string; n: number }[];
  hosts: { host: string; n: number }[];
  coletor: { ok: boolean; ultimo: string };
  ias: ({ papel: string; modelo: string; degradado: boolean } & Diagnostico)[];
}
type Sev = "baixa" | "media" | "alta";
interface AuditoriaDados {
  grupos: { host: string; achados: { id: number; severidade: Sev; titulo: string; firstSeen: string | null }[] }[];
  alvos: { host: string; zona: string | null }[];
}
interface AppsDados { configurado: boolean; apps: AppApp[] }

export default function Painel() {
  const { dados, erro } = useCarga<PainelDados>("/api/painel", 60_000);
  const apps = useCarga<AppsDados>("/api/apps", 60_000);
  const aud = useCarga<AuditoriaDados>("/api/auditoria", 120_000);
  const ger = useCarga<Protecoes>("/api/config/geral", 60_000);
  const blo = useCarga<unknown[]>("/api/bloqueios", 60_000);

  const incidentes24h = dados ? dados.ataquesHora.reduce((s, d) => s + d.n, 0) : null;
  const bloqueiosAtivos = Array.isArray(blo.dados) ? blo.dados.length : null;
  const zonas = aud.dados
    ? new Set(aud.dados.alvos.map((a) => a.zona).filter(Boolean)).size
    : null;
  const appsNoAr = apps.dados ? apps.dados.apps.filter((a) => a.status === "running").length : null;
  const achados = aud.dados?.grupos.flatMap((g) => g.achados) ?? null;
  const sev = achados
    ? {
      alta: achados.filter((a) => a.severidade === "alta").length,
      media: achados.filter((a) => a.severidade === "media").length,
      baixa: achados.filter((a) => a.severidade === "baixa").length,
    }
    : undefined;

  const tiles: Tile[] = [
    { rotulo: "Incidentes 24h", valor: incidentes24h, to: "/incidentes", tom: incidentes24h ? "warn" : undefined },
    { rotulo: "IPs bloqueados", valor: bloqueiosAtivos, to: "/bloqueios" },
    { rotulo: "Zonas", valor: zonas },
    { rotulo: "Apps no ar", valor: appsNoAr, to: "/apps", tom: "ok" },
    {
      rotulo: "Achados abertos", valor: achados ? achados.length : null, to: "/auditoria",
      tom: sev && sev.alta > 0 ? "perigo" : sev && sev.media > 0 ? "warn" : undefined, sev,
    },
  ];

  return (
    <>
      <h1 className="titulo">Painel</h1>
      {erro && <p className="erro-txt" role="alert">{erro}</p>}

      <StatTiles tiles={tiles} carregando={!dados && !erro} />

      <div className="grade-painel" style={{ marginTop: 12 }}>
        <Card className="span-3">
          <h2 className="secao" style={{ margin: "0 0 2px" }}>
            Ao vivo · incidentes por hora
            <span className="sub" style={{ float: "right", margin: 0 }}>
              {incidentes24h != null ? `${incidentes24h} em 24 h` : ""}
            </span>
          </h2>
          {dados ? <Sparkline dados={dados.ataquesHora} /> : <div className="sk sk-linha" style={{ height: 64 }} />}
        </Card>

        {/* Coletor + saúde das IAs */}
        <Card className="span-2">
          <h2 className="secao" style={{ margin: "0 0 8px" }}>Coletor e IAs</h2>
          <div className="estado-linha">
            <span className="estado-linha__rot">Coletor</span>
            {dados
              ? <Badge tom={dados.coletor.ok ? "ok" : "perigo"}>{dados.coletor.ok ? "ok" : "com falhas"}</Badge>
              : <span className="sub" style={{ margin: 0 }}>—</span>}
          </div>
          {dados && <p className="sub" style={{ margin: "4px 0 10px" }}>Último ciclo: {dataHora(dados.coletor.ultimo)}</p>}
          {dados?.ias.map((ia) => (
            <div className="row" key={ia.papel}>
              <div className="row__main">
                <div className="row__titulo">{ia.papel}</div>
                <div className="row__detalhe">{ia.modelo}</div>
                <DiagnosticoIa d={ia} />
              </div>
              <div className="row__fim">
                <Badge tom={ia.degradado ? "perigo" : "ok"}>{ia.papel}: {ia.degradado ? "degradado" : "ok"}</Badge>
                {ia.degradado && <Link to="/config">Substituir modelo</Link>}
              </div>
            </div>
          ))}
        </Card>

        {ger.dados && <EstadoProtecoes p={ger.dados} />}

        {dados && <div className="span-2"><TopIps itens={dados.topIps} /></div>}

        {dados && <Ranking titulo="Países (24 h)" itens={dados.paises.map((p) => ({ rotulo: p.pais, n: p.n }))} />}

        <div className="span-2">
          {apps.dados && <FaixaApps apps={apps.dados.apps} configurado={apps.dados.configurado} />}
        </div>
        {aud.dados && <FaixaAuditoria grupos={aud.dados.grupos} />}
      </div>
    </>
  );
}
