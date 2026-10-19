import { useEffect, useState } from "react";
import { Button, Card, ConfirmDialog, ListRow, Toggle } from "../../ui";
import { api } from "../../api";
import { avisoZonas, erroMsg, useCarga } from "../../lib";

interface Geral {
  modoObservacao: boolean;
  geoAtivo: boolean;
  bloqueioAutoAtivo: boolean;
  bloquearDatacenter: boolean;
  jevExigeSegunda: boolean;
  /** Certeza mínima do Jev (0,3–0,95) para bloquear 7 dias. */
  jevLimiar: number;
}
type Campo = "modoObservacao" | "geoAtivo" | "bloqueioAutoAtivo" | "bloquearDatacenter" | "jevExigeSegunda";

const TEXTO_CONFIRMA = "Isto altera regras de segurança das suas zonas no Cloudflare";
const ITENS: { campo: Campo; rotulo: string; confirmar: boolean }[] = [
  { campo: "modoObservacao", rotulo: "Modo observação", confirmar: false },
  { campo: "bloqueioAutoAtivo", rotulo: "Bloqueio automático", confirmar: true },
  { campo: "geoAtivo", rotulo: "Bloquear fora do Brasil", confirmar: true },
  { campo: "bloquearDatacenter", rotulo: "Bloquear datacenter/VPS", confirmar: true },
];
const LIMIAR_MIN = 30;
const LIMIAR_MAX = 95;
const pct = (x: number | undefined) => String(Math.round((x ?? 0.5) * 100));

export default function GeralConfig() {
  const { dados } = useCarga<Geral>("/api/config/geral");
  const [g, setG] = useState<Geral | null>(null);
  const [limiar, setLimiar] = useState("50");
  const [pendente, setPendente] = useState<{ campo: Campo; valor: boolean; rotulo: string } | null>(null);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  useEffect(() => {
    if (dados) { setG(dados); setLimiar(pct(dados.jevLimiar)); }
  }, [dados]);

  async function aplicar(mudanca: Partial<Geral>) {
    setErro(""); setAviso("");
    try {
      const r = await api.put<Partial<Geral> & { zonasComFalha?: string[] }>("/api/config/geral", mudanca);
      setAviso(avisoZonas(r));
      setG((x) => {
        if (!x) return x;
        const n = { ...x };
        for (const [k, v] of Object.entries(mudanca) as [keyof Geral, never][]) {
          const doServidor = r?.[k];
          n[k] = (doServidor !== undefined && typeof doServidor === typeof v ? doServidor : v) as never;
        }
        return n;
      });
    } catch (e) {
      setErro(erroMsg(e));
    }
  }

  function salvarLimiar() {
    const n = Number(limiar.replace(",", "."));
    if (!Number.isFinite(n) || n < LIMIAR_MIN || n > LIMIAR_MAX) {
      setAviso(""); setErro(`Use um valor entre ${LIMIAR_MIN}% e ${LIMIAR_MAX}%.`);
      return;
    }
    void aplicar({ jevLimiar: Math.round(n) / 100 });
  }

  if (!g) return null;
  return (
    <>
      <h2 className="secao">Geral</h2>
      <Card>
        {erro && <p className="erro-txt" role="alert">{erro}</p>}
        {aviso && <p className="aviso-txt" role="status">{aviso}</p>}
        {ITENS.map((i) => (
          <ListRow key={i.campo} titulo={i.rotulo}
            detalhe={i.campo === "bloquearDatacenter" ? "Nuvem e VPS, inclusive do Brasil (lista em Regras)" : undefined}
            fim={<Toggle rotulo={i.rotulo} ligado={g[i.campo] === true}
              onChange={(v) => (i.confirmar ? setPendente({ campo: i.campo, valor: v, rotulo: i.rotulo }) : void aplicar({ [i.campo]: v }))} />} />
        ))}
      </Card>

      <h2 className="secao">Regra do Jev</h2>
      <Card>
        <p className="sub" style={{ marginTop: 0 }}>
          Jev classificou ataque com certeza a partir de {pct(g.jevLimiar)}%: bloqueia o IP por 7 dias
          {g.jevExigeSegunda ? ", se a 2ª opinião concordar com a mesma certeza." : ", sem esperar 2ª opinião."}
        </p>
        <div className="campos">
          <input className="campo" aria-label="Certeza mínima do Jev (%)" inputMode="numeric"
            value={limiar} onChange={(e) => setLimiar(e.target.value)} />
          <Button variante="secundario" onClick={salvarLimiar}>Salvar certeza</Button>
        </div>
        <ListRow titulo="Exigir 2ª opinião" detalhe="Regra antiga: Jev e 2ª opinião na mesma classe"
          fim={<Toggle rotulo="Exigir 2ª opinião" ligado={g.jevExigeSegunda === true}
            onChange={(v) => void aplicar({ jevExigeSegunda: v })} />} />
      </Card>

      {pendente && (
        <ConfirmDialog titulo={pendente.rotulo} texto={TEXTO_CONFIRMA}
          onCancelar={() => setPendente(null)}
          onConfirmar={() => { const p = pendente; setPendente(null); void aplicar({ [p.campo]: p.valor }); }} />
      )}
    </>
  );
}
