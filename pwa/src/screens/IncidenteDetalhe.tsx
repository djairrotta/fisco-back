import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, ConfirmDialog, ListaIps } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";
import Pareceres, { type Parecer } from "./incidente/Pareceres";
import Relatorio, { type RelatorioDados } from "./incidente/Relatorio";
import BotoesBloqueio, { ROTULO_DURACAO, type Duracao } from "./comum/BotoesBloqueio";
import LocalizarIp from "./comum/LocalizarIp";
import { type EstadoIp, EstadoIpDetalhe } from "./comum/EstadoIp";

interface Sinal { tipo: string; ip: string; host: string; severidade: string; amostra: string[]; contagem: number; ts: string }
interface Detalhe {
  id: number; ips: string[]; hosts: string[]; inicio: string | null; fim: string | null;
  classeFinal: string | null; status: string; severidadeMax: string; totalSinais: number; contagemTotal: number;
  decisao: { acao: string; motivo: string; classe: string; observacao: boolean; naoBloqueou?: string } | null;
  sinais: Sinal[]; investigacao: RelatorioDados | null; investigadoEm: string | null;
  pareceres: Parecer[];
  estadoIps?: EstadoIp[];
}

const ROTULO_SINAL: Record<string, string> = {
  geo: "Acesso estrangeiro", geo_passou: "Acesso estrangeiro que passou", datacenter: "Datacenter/VPS", bruteforce: "Força bruta", scan: "Varredura", rate: "Volume alto", ua: "User-agent suspeito", scrape: "Raspagem",
};

export default function IncidenteDetalhe() {
  const { id } = useParams();
  const [q, setQ] = useSearchParams();
  const { dados, erro, recarregar } = useCarga<Detalhe>(`/api/incidentes/${id}`);
  const [relatorio, setRelatorio] = useState<RelatorioDados | null>(null);
  const [ocupado, setOcupado] = useState("");
  const [falha, setFalha] = useState("");
  const [aviso, setAviso] = useState("");
  const disparou = useRef(false);
  const bloqueioIds = [...new Set(
    q.getAll("bloqueio").flatMap((v) => v.split(",")).filter((s) => /^\d+$/.test(s)),
  )];
  const [desfeitos, setDesfeitos] = useState<string[]>([]);
  const [confirmarDesfazer, setConfirmarDesfazer] = useState<string | null>(null);

  async function investigar() {
    setOcupado("investigar"); setFalha("");
    try {
      setRelatorio(await api.post<RelatorioDados>(`/api/incidentes/${id}/investigar`));
    } catch (e) {
      setFalha(erroMsg(e));
    } finally {
      setOcupado("");
    }
  }

  useEffect(() => {
    if (q.get("investigar") === "1" && !disparou.current) {
      disparou.current = true;
      const n = new URLSearchParams(q); n.delete("investigar");
      setQ(n, { replace: true });
      void investigar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function agir(acao: "bloquear" | "ignorar", duracao: Duracao = "7d") {
    setOcupado(acao); setFalha(""); setAviso("");
    try {
      await api.post(`/api/incidentes/${id}/${acao}`, acao === "bloquear" ? { duracao } : {});
      setAviso(acao === "bloquear" ? `IP bloqueado por ${ROTULO_DURACAO[duracao]}.` : "Incidente ignorado.");
      await recarregar();
    } catch (e) {
      setFalha(erroMsg(e)); // 409: motivo do backend (IPs protegidos)
    } finally {
      setOcupado("");
    }
  }

  async function desfazer(b: string) {
    setFalha("");
    try {
      await api.post(`/api/bloqueios/${b}/desfazer`);
      setDesfeitos((d) => [...d, b]);
      await recarregar();
    } catch (e) {
      setFalha(erroMsg(e));
    }
  }

  const ativos = bloqueioIds.filter((b) => !desfeitos.includes(b));
  const rel = relatorio ?? dados?.investigacao ?? null;

  return (
    <>
      <h1 className="titulo">Incidente #{id}</h1>
      {erro && <p className="erro-txt" role="alert">{erro}</p>}
      {ativos.length > 0 && (
        <div className="banner" role="status">
          <strong>Bloqueado automaticamente</strong>
          <span className="grade">
            {ativos.map((b) => (
              <Button key={b} className="btn--mini" variante="secundario" onClick={() => setConfirmarDesfazer(b)}>Desfazer</Button>
            ))}
          </span>
        </div>
      )}
      {confirmarDesfazer && (
        <ConfirmDialog
          titulo="Desfazer bloqueio?"
          texto="O IP voltará a acessar os sites."
          onCancelar={() => setConfirmarDesfazer(null)}
          onConfirmar={() => { const b = confirmarDesfazer; setConfirmarDesfazer(null); void desfazer(b); }}
        />
      )}
      {desfeitos.length > 0 && <p className="sub" role="status">Bloqueio desfeito.</p>}
      {falha && <p className="erro-txt" role="alert">{falha}</p>}
      {aviso && <p className="sub" role="status">{aviso}</p>}
      {dados && (
        <>
          <Card>
            <div className="grade" style={{ marginBottom: 8 }}>
              <Badge tom={dados.severidadeMax === "alta" ? "perigo" : dados.severidadeMax === "media" ? "aviso" : "neutro"}>{dados.severidadeMax}</Badge>
              <Badge>{dados.status}</Badge>
              {dados.classeFinal && <Badge>{dados.classeFinal}</Badge>}
            </div>
            <div className="row__titulo"><ListaIps ips={dados.ips} /></div>
            <div className="row__detalhe">{dados.hosts.join(", ")} · {dataHora(dados.inicio)} a {dataHora(dados.fim)} · {dados.contagemTotal} requisições</div>
            <div className="grade" style={{ marginTop: 12 }}>
              <BotoesBloqueio alvo={dados.ips.join(", ")} disabled={!!ocupado} onBloquear={(d) => void agir("bloquear", d)} />
              {dados.ips.slice(0, 5).map((ip) => (
                <LocalizarIp key={ip} ip={ip} rotulo={dados.ips.length > 1 ? `Localizar ${ip}` : "Localizar"} />
              ))}
              <Button className="btn--mini" variante="secundario" disabled={!!ocupado} onClick={investigar}>
                {ocupado === "investigar" ? "Investigando…" : "Investigar"}
              </Button>
              <Button className="btn--mini" variante="secundario" disabled={!!ocupado} onClick={() => agir("ignorar")}>Ignorar</Button>
            </div>
          </Card>
          {(dados.estadoIps ?? []).length > 0 && (
            <Card>
              <h2 className="secao" style={{ margin: "0 0 4px" }}>IPs</h2>
              {dados.estadoIps!.map((e) => <EstadoIpDetalhe key={e.ip} e={e} />)}
            </Card>
          )}
          {dados.decisao && (
            <Card>
              <h2 className="secao" style={{ margin: "0 0 8px" }}>Decisão</h2>
              <div className="row__titulo">{dados.decisao.acao}{dados.decisao.observacao ? " (modo observação)" : ""}</div>
              {dados.decisao.acao !== "bloquear" && dados.decisao.naoBloqueou && (
                <div className="row__detalhe aviso-passou">⚠️ Não bloqueado — {dados.decisao.naoBloqueou}</div>
              )}
              <div className="row__detalhe">{dados.decisao.motivo}</div>
            </Card>
          )}
          <h2 className="secao">Pareceres</h2>
          <Pareceres itens={dados.pareceres} />
          {rel && <Relatorio r={rel} em={relatorio ? null : dados.investigadoEm} />}
          <h2 className="secao">Linha do tempo</h2>
          <Card>
            <ol className="linha-tempo">
              {dados.sinais.map((s, i) => (
                <li key={i}>
                  <strong>{ROTULO_SINAL[s.tipo] ?? s.tipo}</strong> · {s.severidade} · {s.contagem}x
                  <div className="row__detalhe">{dataHora(s.ts)} · {s.ip} · {s.host}</div>
                  {s.amostra.slice(0, 3).map((a) => <div key={a} className="row__detalhe">{a}</div>)}
                </li>
              ))}
            </ol>
          </Card>
        </>
      )}
    </>
  );
}
