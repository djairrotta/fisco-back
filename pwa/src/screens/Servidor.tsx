import { useState } from "react";
import { Badge, Button, Card } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";

interface Telemetria {
  em: string;
  avisos: string[];
  cpu: { usoPct: number; iowaitPct: number; nucleos: number; carga: { min1: number; min5: number; min15: number }; cargaPorNucleo: number; saturado: boolean };
  memoria: { totalMb: number; usadaMb: number; disponivelMb: number; cacheMb: number; swapTotalMb: number; swapUsadaMb: number; usadaPct: number; swapUsadaPct: number };
  discos: { nome: string; leituraMbs: number; escritaMbs: number; iops: number; utilPct: number }[];
  volumes: { ponto: string; totalGb: number; usadoGb: number; usadoPct: number }[];
  rede: { iface: string; rxMbs: number; txMbs: number }[];
  temperaturas: { sensor: string; rotulo: string; celsius: number }[];
  tempoLigadoHoras: number | null;
}
interface Bench { tamanhoMb: number; escritaMbs: number | null; leituraMbs: number | null; cacheado: boolean; erro?: string }
interface Resumo {
  telemetria: Telemetria;
  alertas: { chave: string; titulo: string; corpo: string }[];
  ssh: { configurado: boolean; host: string | null; usuario: string; porta: number };
  ultimoTesteDisco: { em: string; resultado: Bench } | null;
}
interface Smart {
  dispositivo: string; modelo?: string | null; tipo?: string; capacidadeGb?: number | null; saudeOk?: boolean | null;
  temperaturaC?: number | null; desgastePct?: number | null; dadosGravadosTb?: number | null; ligadoHoras?: number | null;
  realocados?: number | null; avisos?: string[]; erro?: string;
}
interface Chave { configurado: boolean; host: string | null; usuario: string; chavePublica: string; authorizedKeys: string; instrucoes: string[] }
interface Comando { nome: string; descricao: string; parametros: Record<string, string>; precisaSudo: boolean }
interface Saida { comando: string; ok: boolean; saida: string; erro: string | null; cortado: boolean; ms: number }

const n = (v: number, casas = 1) => v.toLocaleString("pt-BR", { maximumFractionDigits: casas });
const gb = (mb: number) => (mb >= 1024 ? `${n(mb / 1024)} GB` : `${mb} MB`);
const tomPct = (p: number, aviso: number, perigo: number) => (p >= perigo ? "perigo" : p >= aviso ? "warn" : "ok");

function Barra({ pct, tom }: { pct: number; tom: string }) {
  return (
    <div className="srv-barra" role="img" aria-label={`${n(pct)}%`}>
      <i className={`srv-barra__fill srv-barra__fill--${tom}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function Tiles({ t }: { t: Telemetria }) {
  const tempMax = t.temperaturas.length ? Math.max(...t.temperaturas.map((x) => x.celsius)) : null;
  const vol = t.volumes[0];
  const tiles = [
    { rot: `CPU · ${t.cpu.nucleos} núcleos`, val: `${n(t.cpu.usoPct)}%`, tom: tomPct(t.cpu.usoPct, 70, 90), pct: t.cpu.usoPct },
    { rot: "Memória", val: `${n(t.memoria.usadaPct)}%`, tom: tomPct(t.memoria.usadaPct, 80, 92), pct: t.memoria.usadaPct },
    { rot: "Carga por núcleo", val: n(t.cpu.cargaPorNucleo, 2), tom: t.cpu.cargaPorNucleo >= 1.5 ? "perigo" : t.cpu.cargaPorNucleo >= 1 ? "warn" : "ok", pct: Math.min(100, t.cpu.cargaPorNucleo * 50) },
    { rot: "Espera de disco (iowait)", val: `${n(t.cpu.iowaitPct)}%`, tom: tomPct(t.cpu.iowaitPct, 15, 30), pct: t.cpu.iowaitPct },
    tempMax !== null
      ? { rot: "Temperatura máx.", val: `${n(tempMax)} °C`, tom: tempMax >= 85 ? "perigo" : tempMax >= 75 ? "warn" : "ok", pct: Math.min(100, tempMax) }
      : vol
      ? { rot: "Disco dos volumes", val: `${n(vol.usadoPct)}%`, tom: tomPct(vol.usadoPct, 80, 90), pct: vol.usadoPct }
      : null,
  ].filter(Boolean) as { rot: string; val: string; tom: string; pct: number }[];
  return (
    <div className="tiles">
      {tiles.map((x) => (
        <div className="tile" key={x.rot}>
          <span className={`tile__num tile__num--${x.tom}`}>{x.val}</span>
          <span className="tile__rot">{x.rot}</span>
          <Barra pct={x.pct} tom={x.tom} />
        </div>
      ))}
    </div>
  );
}

function SecaoSmart({ sshOk }: { sshOk: boolean }) {
  const [dados, setDados] = useState<{ ok: boolean; erro?: string; discos: Smart[] } | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  async function ler() {
    setCarregando(true); setErro("");
    try { setDados(await api.get("/api/servidor/smart")); } catch (e) { setErro(erroMsg(e)); } finally { setCarregando(false); }
  }
  return (
    <Card>
      <h2 className="card__titulo">Saúde dos discos (SMART)</h2>
      <p className="sub" style={{ marginTop: 0 }}>Modelo, desgaste, dados gravados, temperatura e sinais de falha. Lido pelo SSH do Vigia.</p>
      <Button variante="secundario" className="btn--mini" disabled={carregando || !sshOk} onClick={ler}>
        {carregando ? "Lendo os discos…" : "Ler SMART agora"}
      </Button>
      {!sshOk && <p className="sub">Configure o SSH abaixo para ler o SMART.</p>}
      {erro && <p className="erro-txt" role="alert">{erro}</p>}
      {dados?.erro && <p className="erro-txt">{dados.erro}</p>}
      {dados?.discos.map((d) => (
        <div className="row" key={d.dispositivo}>
          <div className="row__main">
            <div className="row__titulo">{d.dispositivo} {d.modelo ? `· ${d.modelo}` : ""}</div>
            {d.erro ? <div className="row__detalhe">{d.erro}</div> : (
              <div className="row__detalhe">
                {[d.tipo, d.capacidadeGb ? `${d.capacidadeGb} GB` : null,
                  d.desgastePct != null ? `desgaste ${d.desgastePct}%` : null,
                  d.dadosGravadosTb != null ? `${n(d.dadosGravadosTb, 2)} TB gravados` : null,
                  d.temperaturaC != null ? `${d.temperaturaC} °C` : null,
                  d.ligadoHoras != null ? `${n(d.ligadoHoras / 24, 0)} dias ligado` : null,
                  d.realocados ? `${d.realocados} setores realocados` : null].filter(Boolean).join(" · ")}
              </div>
            )}
            {d.avisos?.map((a) => <div className="row__detalhe" key={a} style={{ color: "var(--warn)" }}>⚠ {a}</div>)}
          </div>
          <div className="row__fim">
            {d.saudeOk === true && <Badge tom="ok">saudável</Badge>}
            {d.saudeOk === false && <Badge tom="perigo">em risco</Badge>}
          </div>
        </div>
      ))}
    </Card>
  );
}

function SecaoTesteDisco({ ultimo }: { ultimo: Resumo["ultimoTesteDisco"] }) {
  const [r, setR] = useState<Bench | null>(ultimo?.resultado ?? null);
  const [rodando, setRodando] = useState(false);
  const [erro, setErro] = useState("");
  async function testar() {
    setRodando(true); setErro("");
    try {
      const x = await api.post<Bench & { erro?: string }>("/api/servidor/teste-disco", { mb: 512 });
      if (x.erro) setErro(x.erro); else setR(x);
    } catch (e) { setErro(erroMsg(e)); } finally { setRodando(false); }
  }
  return (
    <Card>
      <h2 className="card__titulo">Velocidade do disco</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Grava e lê 512 MB num arquivo temporário no disco dos volumes, apagado ao final. Pesa no disco de produção: no máximo 1 teste a cada 10 minutos.
      </p>
      <Button variante="secundario" className="btn--mini" disabled={rodando} onClick={testar}>
        {rodando ? "Testando… (até 1 min)" : "Testar velocidade"}
      </Button>
      {erro && <p className="erro-txt" role="alert">{erro}</p>}
      {r && !r.erro && (
        <div className="estado-linha" style={{ marginTop: 8 }}>
          <span>Gravação <strong>{r.escritaMbs != null ? `${n(r.escritaMbs)} MB/s` : "—"}</strong></span>
          <span>Leitura <strong>{r.leituraMbs != null ? `${n(r.leituraMbs)} MB/s` : "—"}</strong></span>
          {r.cacheado && <Badge tom="aviso">com cache</Badge>}
        </div>
      )}
      {ultimo && <p className="sub">Último teste: {dataHora(ultimo.em)}</p>}
    </Card>
  );
}

function SecaoSsh({ configurado }: { configurado: boolean }) {
  const chave = useCarga<Chave>("/api/servidor/ssh");
  const cmds = useCarga<Comando[]>("/api/servidor/comandos");
  const [sel, setSel] = useState("uptime");
  const [container, setContainer] = useState("");
  const [saida, setSaida] = useState<Saida | null>(null);
  const [rodando, setRodando] = useState(false);
  const [erro, setErro] = useState("");
  const atual = cmds.dados?.find((c) => c.nome === sel);
  async function rodar() {
    setRodando(true); setErro(""); setSaida(null);
    try {
      const corpo: Record<string, unknown> = { comando: sel };
      if (atual?.parametros.container) corpo.container = container.trim();
      if (atual?.parametros.disco) corpo.disco = container.trim();
      setSaida(await api.post<Saida>("/api/servidor/comando", corpo));
    } catch (e) { setErro(erroMsg(e)); } finally { setRodando(false); }
  }
  return (
    <Card>
      <h2 className="card__titulo">
        SSH do Vigia <Badge tom={configurado ? "ok" : "neutro"}>{configurado ? "configurado" : "não configurado"}</Badge>
      </h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Só comandos de leitura, de uma lista fechada; não existe terminal livre. O Claude usa os mesmos comandos pelo MCP. Tudo fica na auditoria.
      </p>
      {chave.dados && !configurado && (
        <>
          <ol className="sub app-card__passos">{chave.dados.instrucoes.map((i) => <li key={i}>{i}</li>)}</ol>
          <div className="sub">Linha para o authorized_keys:</div>
          <pre className="bloco-codigo mono">{chave.dados.authorizedKeys}</pre>
        </>
      )}
      {chave.erro && <p className="erro-txt">{chave.erro}</p>}
      {configurado && cmds.dados && (
        <>
          <div className="grade" style={{ alignItems: "center" }}>
            <select className="campo" style={{ width: "auto", flex: "1 1 220px" }} value={sel} onChange={(e) => { setSel(e.target.value); setSaida(null); }} aria-label="Comando">
              {cmds.dados.map((c) => <option key={c.nome} value={c.nome}>{c.descricao}</option>)}
            </select>
            {(atual?.parametros.container || atual?.parametros.disco) && (
              <input className="campo" style={{ width: "auto", flex: "1 1 160px" }} value={container} onChange={(e) => setContainer(e.target.value)}
                placeholder={atual.parametros.container ? "nome do container" : "/dev/sda"} aria-label="Parâmetro" />
            )}
            <Button className="btn--mini" disabled={rodando} onClick={rodar}>{rodando ? "Rodando…" : "Rodar"}</Button>
          </div>
          {erro && <p className="erro-txt" role="alert">{erro}</p>}
          {saida && (
            <>
              {saida.erro && <p className="erro-txt">{saida.erro}</p>}
              <pre className="bloco-codigo mono srv-saida">{saida.saida || "(sem saída)"}</pre>
              <p className="sub">{saida.ms} ms{saida.cortado ? " · saída cortada" : ""}</p>
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default function Servidor() {
  const d = useCarga<Resumo>("/api/servidor", 10_000);
  const t = d.dados?.telemetria;
  return (
    <>
      <h1 className="titulo">Servidor</h1>
      <p className="sub">
        CPU, memória, discos, rede e temperaturas do servidor, atualizados a cada 10 segundos. Avisa por push quando algo passa do limite por mais de 2 leituras seguidas.
      </p>
      {d.erro && <p className="erro-txt" role="alert">{d.erro}</p>}
      {!t && !d.erro && <div className="sk sk-linha" style={{ height: 76 }} />}
      {t && (
        <>
          {d.dados!.alertas.map((a) => (
            <p className="erro-txt" role="alert" key={a.chave}><strong>{a.titulo}.</strong> {a.corpo}</p>
          ))}
          <Tiles t={t} />
          {t.avisos.map((a) => <p className="sub" key={a}>ℹ {a}</p>)}

          <div className="grade-painel" style={{ marginTop: 12 }}>
            <Card>
              <h2 className="card__titulo">Memória</h2>
              <div className="estado-linha"><span>Em uso</span><strong>{gb(t.memoria.usadaMb)} de {gb(t.memoria.totalMb)}</strong></div>
              <div className="estado-linha"><span>Disponível</span><strong>{gb(t.memoria.disponivelMb)}</strong></div>
              <div className="estado-linha"><span>Cache</span><span>{gb(t.memoria.cacheMb)}</span></div>
              <div className="estado-linha"><span>Swap</span><span>{t.memoria.swapTotalMb ? `${gb(t.memoria.swapUsadaMb)} de ${gb(t.memoria.swapTotalMb)}` : "sem swap"}</span></div>
            </Card>
            <Card>
              <h2 className="card__titulo">CPU e carga</h2>
              <div className="estado-linha"><span>Uso</span><strong>{n(t.cpu.usoPct)}%</strong></div>
              <div className="estado-linha"><span>Carga 1/5/15 min</span><span>{n(t.cpu.carga.min1, 2)} · {n(t.cpu.carga.min5, 2)} · {n(t.cpu.carga.min15, 2)}</span></div>
              <div className="estado-linha"><span>Saturado</span><Badge tom={t.cpu.saturado ? "perigo" : "ok"}>{t.cpu.saturado ? "sim" : "não"}</Badge></div>
              <div className="estado-linha"><span>Ligado há</span><span>{t.tempoLigadoHoras != null ? `${n(t.tempoLigadoHoras / 24)} dias` : "—"}</span></div>
            </Card>
            <Card>
              <h2 className="card__titulo">Temperaturas</h2>
              {t.temperaturas.length ? t.temperaturas.slice(0, 12).map((x) => (
                <div className="estado-linha" key={x.sensor + x.rotulo}>
                  <span>{x.sensor} · {x.rotulo}</span>
                  <strong style={{ color: x.celsius >= 85 ? "var(--danger)" : x.celsius >= 75 ? "var(--warn)" : undefined }}>{n(x.celsius)} °C</strong>
                </div>
              )) : <p className="sub" style={{ margin: 0 }}>Nenhum sensor visível (monte /sys em /host/sys).</p>}
            </Card>
            <Card className="span-2">
              <h2 className="card__titulo">Discos agora</h2>
              {t.discos.map((x) => (
                <div className="row" key={x.nome}>
                  <div className="row__main">
                    <div className="row__titulo mono">{x.nome}</div>
                    <div className="row__detalhe">leitura {n(x.leituraMbs)} MB/s · escrita {n(x.escritaMbs)} MB/s · {x.iops} IOPS</div>
                    <Barra pct={x.utilPct} tom={tomPct(x.utilPct, 70, 95)} />
                  </div>
                  <div className="row__fim"><span className="sub" style={{ margin: 0 }}>{n(x.utilPct)}% ocupado</span></div>
                </div>
              ))}
              {t.volumes.map((v) => (
                <div className="estado-linha" key={v.ponto}><span>{v.ponto}</span><strong>{v.usadoGb} de {v.totalGb} GB ({n(v.usadoPct)}%)</strong></div>
              ))}
            </Card>
            <Card>
              <h2 className="card__titulo">Rede</h2>
              {t.rede.length ? t.rede.map((r) => (
                <div className="estado-linha" key={r.iface}>
                  <span className="mono">{r.iface}</span>
                  <span>↓ {n(r.rxMbs, 2)} · ↑ {n(r.txMbs, 2)} MB/s</span>
                </div>
              )) : <p className="sub" style={{ margin: 0 }}>Sem interfaces.</p>}
            </Card>
          </div>

          <div className="grade-painel" style={{ marginTop: 12 }}>
            <div className="span-2"><SecaoSmart sshOk={d.dados!.ssh.configurado} /></div>
            <SecaoTesteDisco ultimo={d.dados!.ultimoTesteDisco} />
            <div className="span-3"><SecaoSsh configurado={d.dados!.ssh.configurado} /></div>
          </div>
          <p className="sub">Leitura de {dataHora(t.em)}.</p>
        </>
      )}
    </>
  );
}
