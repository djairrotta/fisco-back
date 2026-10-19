import { useEffect, useState } from "react";
import { Badge, Button, Card } from "../../ui";
import { api } from "../../api";
import { erroMsg, useCarga } from "../../lib";
import { PAPEIS, ROTULO_PAPEL } from "./rotulos";
import DiagnosticoIa, { type Diagnostico } from "../comum/DiagnosticoIa";

interface Ia extends Diagnostico { papel: string; modelo: string; timeoutMs: number; degradado: boolean }
interface Teste { ok: boolean; latenciaMs: number; modelo: string; motivo?: string }

function Linha({ ia, recarregar }: { ia: Ia; recarregar: () => Promise<void> }) {
  const [modelo, setModelo] = useState(ia.modelo);
  const [seg, setSeg] = useState(String(Math.round(ia.timeoutMs / 1000)));
  const [teste, setTeste] = useState<Teste | null>(null);
  const [ok, setOk] = useState("");
  const [msg, setMsg] = useState("");
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { setModelo(ia.modelo); setSeg(String(Math.round(ia.timeoutMs / 1000))); }, [ia.modelo, ia.timeoutMs]);
  const segN = Number(seg);
  const segValido = Number.isFinite(segN) && segN >= 1 && segN <= 120;
  const sujo = modelo !== ia.modelo || Number(seg) * 1000 !== ia.timeoutMs;

  async function salvar() {
    if (!segValido) throw new Error("Timeout deve ficar entre 1 e 120 segundos");
    await api.put("/api/config/ia", [{ papel: ia.papel, modelo: modelo.trim(), timeoutMs: Math.round(Number(seg) * 1000) }]);
    await recarregar();
  }
  async function rodar(fn: () => Promise<void>) {
    setOcupado(true); setMsg(""); setOk("");
    try { await fn(); } catch (e) { setMsg(erroMsg(e)); } finally { setOcupado(false); }
  }

  return (
    <Card>
      <div className="row" style={{ borderBottom: 0, padding: 0 }}>
        <div className="row__main row__titulo">{ROTULO_PAPEL[ia.papel] ?? ia.papel}</div>
        {ia.degradado && <Badge tom="perigo">degradado</Badge>}
      </div>
      <DiagnosticoIa d={ia} />
      <div className="campos">
        <input className="campo" aria-label={`Modelo (${ia.papel})`} value={modelo} onChange={(e) => setModelo(e.target.value)} />
        <input className="campo" aria-invalid={!segValido} aria-label={`Timeout em segundos (${ia.papel})`} inputMode="numeric" value={seg} onChange={(e) => setSeg(e.target.value)} />
        <div className="grade">
          <Button className="btn--mini" variante="secundario" disabled={!sujo || ocupado}
            onClick={() => rodar(async () => { await salvar(); setOk("Salvo."); })}>Salvar</Button>
          <Button className="btn--mini" variante="secundario" disabled={ocupado}
            onClick={() => rodar(async () => {
              if (sujo) await salvar();
              setTeste(await api.post<Teste>(`/api/config/ia/${ia.papel}/testar`));
            })}>Testar</Button>
        </div>
      </div>
      {teste && (
        <p className={teste.ok ? "sub" : "erro-txt"} role="status" style={{ margin: "8px 0 0" }}>
          {teste.ok ? `ok · ${teste.latenciaMs} ms` : `falhou · ${teste.latenciaMs} ms${teste.motivo ? ` · ${teste.motivo}` : ""}`}
        </p>
      )}
      {ok && <p className="sub" role="status" style={{ margin: "8px 0 0" }}>{ok}</p>}
      {msg && <p className="erro-txt" role="alert">{msg}</p>}
    </Card>
  );
}

export default function IaConfig() {
  const { dados, recarregar } = useCarga<Ia[]>("/api/config/ia");
  if (!dados) return null;
  const ordenado = [...dados].sort((a, b) => PAPEIS.indexOf(a.papel) - PAPEIS.indexOf(b.papel));
  return (
    <>
      <h2 className="secao">IAs (OpenRouter)</h2>
      {ordenado.map((ia) => <Linha key={ia.papel} ia={ia} recarregar={recarregar} />)}
    </>
  );
}
