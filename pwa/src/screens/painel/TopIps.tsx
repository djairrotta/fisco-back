import { useState } from "react";
import { Card, Ip } from "../../ui";
import { api } from "../../api";
import { erroMsg } from "../../lib";
import BotoesBloqueio, { ROTULO_DURACAO, type Duracao } from "../comum/BotoesBloqueio";
import LocalizarIp from "../comum/LocalizarIp";
import { AvisoPassou, type EstadoIp, SelosIp } from "../comum/EstadoIp";

export interface TopIp extends Partial<Pick<EstadoIp, "bloqueado" | "bloqueadoAte" | "geo">> { ip: string; n: number; pais: string }

/** Top IPs das últimas 24 h, com ações por linha. */
export default function TopIps({ itens }: { itens: TopIp[] }) {
  const [msg, setMsg] = useState("");
  const [falha, setFalha] = useState("");
  const max = Math.max(1, ...itens.map((i) => i.n));

  async function bloquear(ip: string, duracao: Duracao) {
    setMsg(""); setFalha("");
    try {
      await api.post("/api/bloqueios", { ip, duracao });
      setMsg(`${ip} bloqueado por ${ROTULO_DURACAO[duracao]}.`);
    } catch (e) {
      setFalha(erroMsg(e));
    }
  }

  return (
    <Card>
      <h2 className="secao" style={{ margin: "0 0 8px" }}>Top IPs</h2>
      {itens.length === 0 && <p className="sub" style={{ margin: 0 }}>Sem dados nas últimas 24 h.</p>}
      {falha && <p className="erro-txt" role="alert">{falha}</p>}
      {msg && <p className="sub" role="status" style={{ margin: "0 0 8px" }}>{msg}</p>}
      {itens.map((i) => (
        <div className="row row--ip" key={i.ip}>
          <div className="row__main">
            <div className="barra" style={{ margin: 0 }}>
              <span className="row__titulo" style={{ minWidth: 0, flex: "0 1 55%" }}><Ip ip={i.ip} />{i.pais ? ` (${i.pais})` : ""}</span>
              <span className="barra__trilho"><span className="barra__preench" style={{ width: `${(i.n / max) * 100}%`, display: "block" }} /></span>
              <span>{Math.round(i.n).toLocaleString("pt-BR")}</span>
            </div>
            <AvisoPassou e={{ geo: i.geo ?? null }} />
            <div className="grade" style={{ marginTop: 8 }}>
              <SelosIp e={{ bloqueado: !!i.bloqueado, bloqueadoAte: i.bloqueadoAte ?? null, geo: i.geo ?? null }} />
              <LocalizarIp ip={i.ip} />
              <BotoesBloqueio alvo={i.ip} onBloquear={(d) => void bloquear(i.ip, d)} />
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}
