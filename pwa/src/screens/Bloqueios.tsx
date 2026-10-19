import { useState } from "react";
import { Button, Card, ConfirmDialog, Ip, ListRow, Segmented } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";
import { DURACOES, ROTULO_DURACAO, type Duracao } from "./comum/BotoesBloqueio";

type Origem = "jev" | "reserva" | "djair" | "api" | "sistema";
interface Bloqueio {
  id: number; ip: string; motivo: string; criado: string; expira: string | null; removido: string | null;
  /** Quem criou (Vigia 1.2). */
  origem?: Origem;
  /** Duração escolhida: 1 = 24 h, 7 = 7 dias. */
  dias?: number | null;
}

const ROTULO_ORIGEM: Record<Origem, string> = {
  jev: "Jev automático",
  reserva: "Reserva automática",
  djair: "Djair manual",
  api: "API (token)",
  sistema: "Sistema",
};
const rotuloDias = (d: number) => (d === 1 ? "24 h" : `${d} dias`);

/** "Jev automático · 7 dias · expira 10/10 22:35". */
function resumoBloqueio(b: Bloqueio): string {
  const partes: string[] = [];
  if (b.origem) partes.push(ROTULO_ORIGEM[b.origem] ?? b.origem);
  if (b.dias) partes.push(rotuloDias(b.dias));
  partes.push(b.expira ? `expira ${dataHora(b.expira)}` : "sem validade");
  return partes.join(" · ");
}

export default function Bloqueios() {
  const { dados, erro, recarregar } = useCarga<Bloqueio[]>("/api/bloqueios");
  const [falha, setFalha] = useState("");
  const [msg, setMsg] = useState("");
  const [ip, setIp] = useState("");
  const [duracao, setDuracao] = useState<Duracao>("7d");
  const [confirmar, setConfirmar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [desfazer, setDesfazer] = useState<Bloqueio | null>(null);

  async function rodar(fn: () => Promise<unknown>, ok = "") {
    setFalha(""); setMsg("");
    try {
      await fn();
      setMsg(ok);
      await recarregar();
    } catch (e) {
      setFalha(erroMsg(e));
    }
  }

  async function bloquearIp() {
    setConfirmar(false);
    setOcupado(true);
    const alvo = ip.trim();
    await rodar(async () => {
      await api.post("/api/bloqueios", { ip: alvo, duracao });
      setIp("");
    }, `${alvo} bloqueado por ${ROTULO_DURACAO[duracao]}.`);
    setOcupado(false);
  }

  return (
    <>
      <h1 className="titulo">Bloqueios</h1>
      {(erro || falha) && <p className="erro-txt" role="alert">{falha || erro}</p>}
      {msg && <p className="sub" role="status">{msg}</p>}

      <h2 className="secao">Bloquear IP</h2>
      <Card>
        <div className="campos" style={{ marginTop: 0 }}>
          <input className="campo" aria-label="IP a bloquear" placeholder="203.0.113.7 ou 2001:db8::7" autoCapitalize="off" autoCorrect="off"
            value={ip} onChange={(e) => setIp(e.target.value)} />
          <Segmented opcoes={DURACOES.map((d) => ({ valor: d, rotulo: ROTULO_DURACAO[d] }))} valor={duracao} onChange={setDuracao} />
          <Button variante="perigo" disabled={!ip.trim() || ocupado} onClick={() => setConfirmar(true)}>Bloquear IP</Button>
        </div>
      </Card>

      <h2 className="secao">Ativos</h2>
      {dados && dados.length === 0 && <p className="sub">Nenhum bloqueio ativo.</p>}
      {dados && dados.length > 0 && (
        <Card>
          {dados.map((b) => (
            <ListRow
              key={b.id}
              fimAbaixo
              titulo={<Ip ip={b.ip} />}
              detalhe={<>
                <span className="bloqueio__origem">{resumoBloqueio(b)}</span>
                <span className="bloqueio__motivo">{b.motivo}</span>
              </>}
              fim={<>
                {DURACOES.map((d) => (
                  <Button key={d} className="btn--mini" variante="secundario"
                    onClick={() => rodar(() => api.post(`/api/bloqueios/${b.id}/prorrogar`, { duracao: d }), `Prorrogado por ${ROTULO_DURACAO[d]}.`)}>
                    Prorrogar +{ROTULO_DURACAO[d]}
                  </Button>
                ))}
                <Button className="btn--mini" variante="perigo" onClick={() => setDesfazer(b)}>Desfazer</Button>
              </>}
            />
          ))}
        </Card>
      )}
      {desfazer && (
        <ConfirmDialog
          titulo="Desfazer bloqueio?"
          texto={`${desfazer.ip} voltará a acessar os sites.`}
          onCancelar={() => setDesfazer(null)}
          onConfirmar={() => {
            const b = desfazer;
            setDesfazer(null);
            void rodar(() => api.post(`/api/bloqueios/${b.id}/desfazer`), "Bloqueio desfeito.");
          }}
        />
      )}
      {confirmar && (
        <ConfirmDialog
          titulo={`Bloquear por ${ROTULO_DURACAO[duracao]}?`}
          texto={`${ip.trim()} ficará bloqueado em todos os sites por ${ROTULO_DURACAO[duracao]}.`}
          onCancelar={() => setConfirmar(false)}
          onConfirmar={() => void bloquearIp()}
        />
      )}
    </>
  );
}
