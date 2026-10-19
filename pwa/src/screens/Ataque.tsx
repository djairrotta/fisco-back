import { useState } from "react";
import { Badge, Button, Card, Folha, ListRow } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";

type Tipo = "enumeracao" | "fuzz_leve" | "forca_bruta_simulada";
type Estado = "rascunho" | "autorizada" | "concluida" | "cancelada";
interface Campanha {
  id: number; alvo: string; host: string; tipo: Tipo; estado: Estado;
  config: Record<string, unknown>; autorizadoPor: string | null; autorizadoEm: string | null;
  resultado: unknown; criadoEm: string | null;
}
type Ambiente = "producao" | "teste";
interface Alvo { host: string; estado: "sugerido" | "confirmado"; ambiente?: Ambiente }
interface Auditoria { alvos: Alvo[] }

const ESTADO: Record<Estado, { rotulo: string; tom: "neutro" | "aviso" | "ok" | "crimson" }> = {
  rascunho: { rotulo: "rascunho", tom: "neutro" },
  autorizada: { rotulo: "autorizada", tom: "crimson" },
  concluida: { rotulo: "concluída", tom: "ok" },
  cancelada: { rotulo: "cancelada", tom: "neutro" },
};
const TIPOS: { tipo: Tipo; nome: string; desc: string }[] = [
  { tipo: "enumeracao", nome: "Enumeração", desc: "Varredura profunda com lista de caminhos mais agressiva (.env.production, .git/HEAD…). Só leitura." },
  { tipo: "fuzz_leve", nome: "Fuzz leve", desc: "GETs com query malformada nos caminhos que você indicar; registra só o status. Sem corpo, sem bypass de auth." },
  { tipo: "forca_bruta_simulada", nome: "Força bruta simulada", desc: "25 tentativas de login com credenciais FALSAS em ~10 s, para testar o SEU rate limit. Para no primeiro 429/403." },
];

function SeloEstado({ e }: { e: { rotulo: string; tom: "neutro" | "aviso" | "ok" | "crimson" } }) {
  if (e.tom === "crimson") {
    return <span className="badge badge--crimson"><span className="campanha__estado">{e.rotulo}</span></span>;
  }
  return <Badge tom={e.tom}><span className="campanha__estado">{e.rotulo}</span></Badge>;
}

export default function Ataque() {
  const camp = useCarga<Campanha[]>("/api/ataque", 20_000);
  const aud = useCarga<Auditoria>("/api/auditoria", 60_000);
  const [msg, setMsg] = useState("");
  const [falha, setFalha] = useState("");
  const [tokens, setTokens] = useState<Record<number, string>>({});

  // formulário
  const [alvo, setAlvo] = useState("");
  const [tipo, setTipo] = useState<Tipo>("enumeracao");
  const [caminho, setCaminho] = useState("/api/login");
  const [caminhos, setCaminhos] = useState("/");

  // diálogo de autorização
  const [aAutorizar, setAAutorizar] = useState<Campanha | null>(null);
  const [digitado, setDigitado] = useState("");

  const hostsTeste = (aud.dados?.alvos ?? []).filter((a) => a.estado === "confirmado" && a.ambiente === "teste");
  const hostsProd = (aud.dados?.alvos ?? []).filter((a) => a.estado === "confirmado" && a.ambiente !== "teste");

  async function acao(fn: () => Promise<unknown>, ok: string, depois?: (r: unknown) => void) {
    setMsg(""); setFalha("");
    try {
      const r = await fn();
      setMsg(ok);
      depois?.(r);
      void camp.recarregar();
    } catch (e) { setFalha(erroMsg(e)); }
  }

  function criar() {
    const config = tipo === "forca_bruta_simulada"
      ? { caminho: caminho.trim() }
      : tipo === "fuzz_leve"
      ? { caminhos: caminhos.split(/[\n,]/).map((c) => c.trim()).filter(Boolean) }
      : undefined;
    void acao(
      () => api.post<{ campanha: Campanha; confirmToken: string }>("/api/ataque", { alvo: alvo.trim(), tipo, config }),
      "Campanha criada em rascunho. Guarde o token de confirmação abaixo para autorizar.",
      (r) => {
        const { campanha, confirmToken } = r as { campanha: Campanha; confirmToken: string };
        setTokens((t) => ({ ...t, [campanha.id]: confirmToken }));
        setAlvo("");
      },
    );
  }

  function autorizar() {
    if (!aAutorizar) return;
    const token = tokens[aAutorizar.id];
    const id = aAutorizar.id;
    void acao(
      () => api.post(`/api/ataque/${id}/autorizar`, { confirmar: token }),
      "Campanha autorizada. Rode quando quiser.",
      () => { setAAutorizar(null); setDigitado(""); },
    );
  }

  function rodar(c: Campanha) {
    void acao(async () => {
      try {
        return await api.post(`/api/ataque/${c.id}/rodar`);
      } catch (e) {
        // 503: runner isolado ausente — estado "sem executor", tratado com calma.
        const err = e as { status?: number };
        if (err.status === 503) {
          setFalha("Sem executor: a execução real exige um runner isolado, à parte, que você aciona por conta própria. O Vigia só mantém o plano de controle.");
          return null;
        }
        throw e;
      }
    }, "Campanha executada.");
  }

  return (
    <>
      <div className="ataque-topo">
        <h1 className="titulo" style={{ margin: 0 }}>Ataque</h1>
        <span className="ataque-chip">teste ofensivo</span>
      </div>

      <div className="banner-ataque" role="note">
        <svg className="banner-ataque__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 2.5 20h19L12 3zM12 10v4M12 17.2v.1" />
        </svg>
        <div className="banner-ataque__txt">
          Checagens ativas rodam <strong>apenas contra os seus próprios hosts de teste/staging</strong> — nunca
          produção, nunca terceiros. A exploração real (exploits, metasploit, sqlmap) <strong>não roda aqui</strong>:
          exige um runner isolado, à parte, que você aciona por conta própria. Marque um host como teste em Auditoria
          para liberá-lo como alvo.
        </div>
      </div>

      {falha && <p className="erro-txt" role="alert">{falha}</p>}
      {msg && <p className="sub" role="status">{msg}</p>}

      <h2 className="secao">Nova campanha</h2>
      <Card>
        <div className="row__titulo" style={{ marginBottom: 8 }}>Alvo (host de teste)</div>
        {hostsTeste.length === 0 && (
          <p className="sub" style={{ marginTop: 0 }}>
            Nenhum host de teste. Marque um site como teste/staging em Auditoria para liberá-lo como alvo.
          </p>
        )}
        {hostsTeste.map((h) => (
          <label className="host-op" key={h.host}>
            <span className="host-op__nome">{h.host}</span>
            <input type="radio" name="alvo" value={h.host} checked={alvo === h.host}
              aria-label={`Selecionar ${h.host}`} onChange={() => setAlvo(h.host)} style={{ accentColor: "var(--crimson)" }} />
          </label>
        ))}
        {hostsProd.map((h) => (
          <div className="host-op host-op--off" key={h.host}>
            <span className="host-op__nome">{h.host}<br /><span className="host-op__dica">marque como teste em Auditoria</span></span>
            <input type="radio" name="alvo" disabled aria-label={`${h.host} (produção, indisponível)`} />
          </div>
        ))}

        <div className="row__titulo" style={{ margin: "14px 0 6px" }}>Tipo</div>
        <div className="radio-tipos">
          {TIPOS.map((t) => (
            <label key={t.tipo} className={`radio-tipo${tipo === t.tipo ? " radio-tipo--on" : ""}`}>
              <input type="radio" name="tipo" checked={tipo === t.tipo} onChange={() => setTipo(t.tipo)} aria-label={t.nome} />
              <span>
                <span className="radio-tipo__nome">{t.nome}</span>
                <span className="radio-tipo__desc">{t.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {tipo === "forca_bruta_simulada" && (
          <input className="campo" aria-label="Caminho do login" placeholder="/api/login"
            value={caminho} onChange={(e) => setCaminho(e.target.value)} />
        )}
        {tipo === "fuzz_leve" && (
          <input className="campo" aria-label="Caminhos para fuzz" placeholder="/ , /busca , /api"
            value={caminhos} onChange={(e) => setCaminhos(e.target.value)} />
        )}

        <Button bloco className="btn--crimson" style={{ marginTop: 12 }}
          disabled={!alvo || (tipo === "forca_bruta_simulada" && !caminho.trim())}
          onClick={criar}>
          Criar campanha
        </Button>
      </Card>

      <h2 className="secao">Campanhas</h2>
      {camp.erro && <p className="erro-txt" role="alert">{camp.erro}</p>}
      {camp.dados && camp.dados.length === 0 && (
        <Card><p className="sub" style={{ margin: 0 }}>Nenhuma campanha ainda.</p></Card>
      )}
      {camp.dados?.map((c) => {
        const token = tokens[c.id];
        const e = ESTADO[c.estado];
        return (
          <section key={c.id} aria-label={`Campanha ${c.id}`}>
            <Card>
              <div className="host-cab">
                <span className="host-cab__nome">{c.alvo}</span>
                <SeloEstado e={e} />
              </div>
              <p className="sub" style={{ margin: "0 0 4px" }}>
                {TIPOS.find((t) => t.tipo === c.tipo)?.nome ?? c.tipo}
                {typeof c.config?.caminho === "string" ? ` · ${c.config.caminho}` : ""}
                {Array.isArray(c.config?.caminhos) ? ` · ${(c.config.caminhos as string[]).join(", ")}` : ""}
                {" · criada "}{dataHora(c.criadoEm)}
              </p>

              {c.estado === "rascunho" && token && (
                <div className="token-novo">
                  <span className="sub" style={{ margin: 0 }}>Token de confirmação (aparece só agora):</span>
                  <code className="token-novo__valor mono">{token}</code>
                </div>
              )}
              {c.estado === "rascunho" && !token && (
                <p className="aviso-txt">O token de confirmação só é devolvido na criação. Sem ele não dá para autorizar — crie outra campanha.</p>
              )}

              {c.resultado != null && (
                <pre className="resultado-bloco" aria-label={`Resultado da campanha ${c.id}`}>
                  {JSON.stringify(c.resultado, null, 2)}
                </pre>
              )}

              <div className="botoes-linha">
                {c.estado === "rascunho" && token && (
                  <Button className="btn--mini btn--crimson" onClick={() => { setAAutorizar(c); setDigitado(""); }}>Autorizar</Button>
                )}
                {c.estado === "autorizada" && (
                  <Button className="btn--mini btn--crimson" onClick={() => rodar(c)}>Rodar</Button>
                )}
                {(c.estado === "rascunho" || c.estado === "autorizada") && (
                  <Button className="btn--mini" variante="secundario"
                    onClick={() => acao(() => api.post(`/api/ataque/${c.id}/cancelar`), "Campanha cancelada.")}>Cancelar</Button>
                )}
              </div>
            </Card>
          </section>
        );
      })}

      {aAutorizar && (
        <Folha rotulo="Autorizar campanha" papel="alertdialog" onFechar={() => setAAutorizar(null)}>
          <h2 className="dialog__titulo">Autorizar campanha</h2>
          <p className="dialog__texto">
            Vai autorizar <strong>{TIPOS.find((t) => t.tipo === aAutorizar.tipo)?.nome}</strong> contra{" "}
            <span className="mono">{aAutorizar.host}</span>. Isto roda apenas checagens ativas seguras contra o seu
            host de teste. Para confirmar, digite o host exatamente.
          </p>
          <input className="campo confirmar-alvo" aria-label="Confirme o host" placeholder={aAutorizar.host}
            value={digitado} onChange={(e) => setDigitado(e.target.value)} />
          <div className="dialog__acoes" style={{ marginTop: 12 }}>
            <Button variante="secundario" onClick={() => setAAutorizar(null)}>Cancelar</Button>
            <Button className="btn--crimson" disabled={digitado.trim() !== aAutorizar.host} onClick={autorizar}>
              Autorizar
            </Button>
          </div>
        </Folha>
      )}
    </>
  );
}
