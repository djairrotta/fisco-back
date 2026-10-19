import { useState } from "react";
import { Button, Card, ListRow } from "../ui";
import { api } from "../api";
import { avisoZonas, dataHora, erroMsg, useCarga } from "../lib";

interface Excecao { id: number; valor: string; nota: string | null }
interface Permitido { id: number; ip: string; expira: string | null; nota: string | null }
interface AsnDatacenter { asn: number; nome: string; ativo: boolean }
interface IpServidor { ip: string; vistoEm: string; rotulo: string }

/** "AS16509", "as 16509" ou "16509" → 16509; inválido → null. */
function lerAsn(t: string): number | null {
  const m = /^\s*(?:as\s*)?(\d{1,10})\s*$/i.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 4294967295 ? n : null;
}

export default function Regras() {
  const ex = useCarga<Excecao[]>("/api/excecoes");
  const pe = useCarga<Permitido[]>("/api/permitidos");
  const dc = useCarga<AsnDatacenter[]>("/api/asn-datacenter");
  const srv = useCarga<IpServidor[]>("/api/ips-servidor");
  const [asn, setAsn] = useState("");
  const [provedor, setProvedor] = useState("");
  const [caminho, setCaminho] = useState("");
  const [ip, setIp] = useState("");
  const [horas, setHoras] = useState("");
  const [nota, setNota] = useState("");
  const [msg, setMsg] = useState("");
  const [falha, setFalha] = useState("");
  const [aviso, setAviso] = useState("");

  async function rodar(fn: () => Promise<unknown>, ok: string, depois?: () => void) {
    setMsg(""); setFalha(""); setAviso("");
    try { setAviso(avisoZonas(await fn())); setMsg(ok); depois?.(); } catch (e) { setFalha(erroMsg(e)); }
  }

  return (
    <>
      <h1 className="titulo">Regras</h1>
      {falha && <p className="erro-txt" role="alert">{falha}</p>}
      {msg && <p className="sub" role="status">{msg}</p>}
      {aviso && <p className="aviso-txt" role="status">{aviso}</p>}

      <Card>
        <Button bloco onClick={() => rodar(() => api.post("/api/modo-viagem", { horas: 24 }), "Modo viagem ativado por 24 horas para este dispositivo.")}>
          Modo viagem (24 h)
        </Button>
        <p className="sub" style={{ margin: "12px 0 0" }}>
          Fora do Brasil, todos os sites ficam bloqueados, a menos que o modo viagem esteja ligado.
          Ele libera o IP deste dispositivo por 24 horas.
        </p>
      </Card>

      <h2 className="secao">Exceções de caminho</h2>
      <Card>
        {ex.dados?.length === 0 && <p className="sub" style={{ margin: 0 }}>Nenhuma exceção.</p>}
        {ex.dados?.map((e) => (
          <ListRow key={e.id} titulo={e.valor} detalhe={e.nota}
            fim={<Button className="btn--mini" variante="secundario" onClick={() => rodar(() => api.del(`/api/excecoes/${e.id}`), "Exceção removida.", ex.recarregar)}>Remover</Button>} />
        ))}
        <div className="campos">
          <input className="campo" aria-label="Novo caminho" placeholder="/webhook" value={caminho} onChange={(e) => setCaminho(e.target.value)} />
          <Button variante="secundario" disabled={!caminho} onClick={() => rodar(() => api.post("/api/excecoes", { tipo: "caminho", valor: caminho }), "Exceção adicionada.", () => { setCaminho(""); void ex.recarregar(); })}>
            Adicionar caminho
          </Button>
        </div>
      </Card>

      <h2 className="secao">IPs permitidos</h2>
      <Card>
        {pe.dados?.length === 0 && !srv.dados?.length && <p className="sub" style={{ margin: 0 }}>Nenhum IP permitido.</p>}
        {srv.dados?.map((s) => (
          <ListRow key={`srv-${s.ip}`} titulo={s.ip} detalhe={`${s.rotulo} · visto ${dataHora(s.vistoEm)}`} />
        ))}
        {pe.dados?.map((p) => (
          <ListRow key={p.id} titulo={p.ip}
            detalhe={[p.nota, p.expira ? `expira ${dataHora(p.expira)}` : "sem validade"].filter(Boolean).join(" · ")}
            fim={<Button className="btn--mini" variante="secundario" onClick={() => rodar(() => api.del(`/api/permitidos/${p.id}`), "IP removido.", pe.recarregar)}>Remover</Button>} />
        ))}
        <div className="campos">
          <input className="campo" aria-label="IP ou CIDR" placeholder="203.0.113.7 ou 203.0.113.0/24" value={ip} onChange={(e) => setIp(e.target.value)} />
          <input className="campo" aria-label="Validade (horas, opcional)" inputMode="numeric" placeholder="Validade em horas (opcional)" value={horas} onChange={(e) => setHoras(e.target.value)} />
          <input className="campo" aria-label="Nota" placeholder="Nota (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} />
          <Button variante="secundario" disabled={!ip}
            onClick={() => {
              const h = Number(horas);
              const corpo: Record<string, unknown> = { ip: ip.trim() };
              if (horas && h > 0) corpo.horas = h;
              if (nota) corpo.nota = nota;
              void rodar(() => api.post("/api/permitidos", corpo), "IP permitido.", () => { setIp(""); setHoras(""); setNota(""); void pe.recarregar(); });
            }}>
            Adicionar IP
          </Button>
        </div>
      </Card>

      <h2 className="secao">Datacenter / VPS</h2>
      <Card>
        <p className="sub" style={{ marginTop: 0 }}>
          IPs destas redes de nuvem e VPS são barrados pela regra Fora do Brasil mesmo vindos do Brasil.
          Bots verificados (Google, Bing, ChatGPT, Claude…), IPs permitidos e os caminhos de exceção (webhooks) passam.
        </p>
        {dc.dados?.length === 0 && <p className="sub" style={{ margin: 0 }}>Nenhum ASN na lista.</p>}
        {dc.dados?.map((a) => (
          <ListRow key={a.asn} titulo={`AS${a.asn}`} detalhe={a.ativo ? a.nome : `${a.nome} · inativo`}
            fim={<Button className="btn--mini" variante="secundario" aria-label={`Remover AS${a.asn}`}
              onClick={() => rodar(() => api.del(`/api/asn-datacenter/${a.asn}`), `AS${a.asn} removido.`, dc.recarregar)}>Remover</Button>} />
        ))}
        <div className="campos">
          <input className="campo" aria-label="ASN" inputMode="numeric" placeholder="AS16509" value={asn} onChange={(e) => setAsn(e.target.value)} />
          <input className="campo" aria-label="Provedor" placeholder="Provedor (ex.: Amazon AWS)" value={provedor} onChange={(e) => setProvedor(e.target.value)} />
          <Button variante="secundario" disabled={!asn || !provedor.trim()}
            onClick={() => {
              const n = lerAsn(asn);
              if (n === null) { setMsg(""); setAviso(""); setFalha("ASN inválido."); return; }
              void rodar(() => api.post("/api/asn-datacenter", { asn: n, nome: provedor.trim() }), `AS${n} adicionado.`, () => { setAsn(""); setProvedor(""); void dc.recarregar(); });
            }}>
            Adicionar ASN
          </Button>
        </div>
      </Card>
    </>
  );
}
