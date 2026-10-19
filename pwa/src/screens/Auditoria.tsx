import { useState } from "react";
import { Badge, Button, Card, ListRow, Toggle } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";
import { type AchadoTipado, porTipo, TIPO_ROTULO } from "./auditoria/tipos";

type Severidade = "baixa" | "media" | "alta";
type Ambiente = "producao" | "teste";
interface Alvo { host: string; estado: "sugerido" | "confirmado"; zona: string | null; acessos: number | null; ambiente?: Ambiente }
interface Execucao { inicio: string; fim: string; hosts: number; novos: number; resolvidos: number; falhas: number; bloqueados?: string[] }
interface Dados { ultimaExecucao: Execucao | null; rodando: boolean; grupos: { host: string; achados: AchadoTipado[] }[]; alvos: Alvo[] }

const SEV: Record<Severidade, { rotulo: string; tom: "perigo" | "aviso" | "neutro" }> = {
  alta: { rotulo: "Alta", tom: "perigo" },
  media: { rotulo: "Média", tom: "aviso" },
  baixa: { rotulo: "Baixa", tom: "neutro" },
};

export default function Auditoria() {
  const d = useCarga<Dados>("/api/auditoria", 30_000);
  const [novo, setNovo] = useState("");
  const [msg, setMsg] = useState("");
  const [falha, setFalha] = useState("");

  async function rodar(fn: () => Promise<unknown>, ok: string | ((r: unknown) => string), depois?: () => void) {
    setMsg(""); setFalha("");
    try {
      const r = await fn();
      setMsg(typeof ok === "string" ? ok : ok(r));
      depois?.();
      void d.recarregar();
    } catch (e) { setFalha(erroMsg(e)); }
  }

  /**
   * Busca o prompt e copia. Com ClipboardItem (Safari/iOS), a promessa entra
   * na cópia ainda dentro do toque; sem ele, writeText depois da busca.
   */
  async function copiarPrompt(host?: string) {
    setMsg(""); setFalha("");
    const url = `/api/auditoria/prompt${host ? `?host=${encodeURIComponent(host)}` : ""}`;
    const texto = api.get<{ texto: string }>(url).then((r) => r.texto);
    try {
      const clip = navigator.clipboard;
      if (!clip) throw new Error("este navegador não permite copiar automaticamente");
      if (typeof ClipboardItem !== "undefined" && clip.write) {
        await clip.write([new ClipboardItem({
          "text/plain": texto.then((t) => new Blob([t], { type: "text/plain" })),
        })]);
      } else {
        await clip.writeText(await texto);
      }
      setMsg(`Prompt copiado${host ? ` (${host})` : ""}. Cole no Claude Code dentro do repositório do app.`);
    } catch (e) {
      texto.catch(() => {});
      setFalha(`Não foi possível copiar o prompt: ${erroMsg(e)}`);
    }
  }

  const u = d.dados?.ultimaExecucao;
  const rodando = d.dados?.rodando ?? false;
  const confirmados = d.dados?.alvos.filter((a) => a.estado === "confirmado") ?? [];
  const sugeridos = d.dados?.alvos.filter((a) => a.estado === "sugerido") ?? [];
  const ambienteDe = (host: string): Ambiente | undefined =>
    d.dados?.alvos.find((a) => a.host === host)?.ambiente;

  return (
    <>
      <h1 className="titulo">Auditoria</h1>
      <p className="sub">
        Varredura profunda diária (06:00) dos seus sites: HTTPS e certificado, portas expostas, TLS antigo,
        cabeçalhos, arquivos que não deveriam ser públicos, segredos vazados, CORS e Supabase. Só leitura,
        no máximo 2 requisições por segundo por site. Apps do EasyPanel (projeto/serviço) entram com a
        checagem das variáveis de ambiente.
      </p>
      {d.erro && <p className="erro-txt" role="alert">{d.erro}</p>}
      {falha && <p className="erro-txt" role="alert">{falha}</p>}
      {msg && <p className="sub" role="status">{msg}</p>}

      <Card>
        <Button bloco disabled={rodando}
          onClick={() => rodar(() => api.post("/api/varredura/rodar"), (r) => (r as { mensagem?: string })?.mensagem ?? "Varredura iniciada.")}>
          {rodando ? "Rodando…" : "Rodar varredura agora"}
        </Button>
        <p className="sub" style={{ margin: "12px 0 0" }}>
          {u
            ? `Última execução ${dataHora(u.fim)}: ${u.hosts} site(s), ${u.novos} achado(s) novo(s), ${u.resolvidos} resolvido(s)` +
              (u.falhas ? `, ${u.falhas} falha(s)` : "") + "."
            : "Ainda não rodou."}
        </p>
        {u?.bloqueados && u.bloqueados.length > 0 && (
          <p className="aviso-txt">
            O Cloudflare barrou a auditoria em {u.bloqueados.join(", ")}. Libere o IP do servidor do Vigia em Regras → IPs permitidos.
          </p>
        )}
      </Card>

      <h2 className="secao">Achados</h2>
      {d.dados && d.dados.grupos.length > 0 && (
        <Card>
          <Button bloco variante="secundario" aria-label="Copiar prompt para o Claude Code (todos)"
            onClick={() => void copiarPrompt()}>
            Copiar prompt (todos)
          </Button>
          <p className="sub" style={{ margin: "12px 0 0" }}>
            Gera um texto com os achados, as recomendações e o roteiro de revisão de 8 pontos para colar no
            Claude Code dentro do repositório do app.
          </p>
        </Card>
      )}
      {d.dados && d.dados.grupos.length === 0 && (
        <Card><p className="sub" style={{ margin: 0 }}>Nenhum achado aberto.</p></Card>
      )}
      {d.dados?.grupos.map((g) => {
        const amb = ambienteDe(g.host);
        return (
          <section key={g.host} aria-label={g.host}>
            <Card>
              <div className="host-cab">
                <span className="host-cab__nome">{g.host}</span>
                {amb && (
                  <span className="amb">
                    <span className="amb__rot">{amb === "teste" ? "teste/staging" : "produção"}</span>
                    <Toggle ligado={amb === "teste"} rotulo={`Marcar ${g.host} como ${amb === "teste" ? "produção" : "teste"}`}
                      onChange={(v) => rodar(
                        () => api.put(`/api/auditoria/hosts/${encodeURIComponent(g.host)}/ambiente`, { ambiente: v ? "teste" : "producao" }),
                        `${g.host} marcado como ${v ? "teste" : "produção"}.`)} />
                  </span>
                )}
              </div>
              {porTipo(g.achados).map((bloco) => (
                <div key={bloco.tipo} style={{ marginTop: 10 }}>
                  <div className="tipo-cab">
                    <span className="tipo-cab__nome">{TIPO_ROTULO[bloco.tipo]}</span>
                    <Badge>{bloco.achados.length}</Badge>
                  </div>
                  {bloco.achados.map((a) => (
                    <ListRow key={a.id} fimAbaixo
                      titulo={a.titulo}
                      detalhe={
                        <>
                          <span>{a.recomendacao}</span>
                          {a.evidencia && <><br /><span className="mono">{a.evidencia}</span></>}
                          <br /><span>desde {dataHora(a.firstSeen)} · visto {dataHora(a.lastSeen)}</span>
                        </>
                      }
                      fim={<Badge tom={SEV[a.severidade].tom}>{SEV[a.severidade].rotulo}</Badge>} />
                  ))}
                </div>
              ))}
              <div className="botoes-linha">
                <Button className="btn--mini" variante="secundario" aria-label={`Copiar prompt de ${g.host}`}
                  onClick={() => void copiarPrompt(g.host)}>Copiar prompt</Button>
              </div>
            </Card>
          </section>
        );
      })}

      <h2 className="secao">Sites auditados</h2>
      <Card>
        {d.dados && confirmados.length === 0 && <p className="sub" style={{ margin: 0 }}>Nenhum site confirmado.</p>}
        {confirmados.map((a) => (
          <ListRow key={a.host} fimAbaixo titulo={a.host}
            detalhe={
              <>
                {a.zona ? `zona ${a.zona}` : "sem zona"} · {a.ambiente === "teste" ? "teste/staging" : "produção"}
              </>
            }
            fim={
              <>
                <span className="amb">
                  <span className="amb__rot">teste</span>
                  <Toggle ligado={a.ambiente === "teste"} rotulo={`Marcar ${a.host} como ${a.ambiente === "teste" ? "produção" : "teste"}`}
                    onChange={(v) => rodar(
                      () => api.put(`/api/auditoria/hosts/${encodeURIComponent(a.host)}/ambiente`, { ambiente: v ? "teste" : "producao" }),
                      `${a.host} marcado como ${v ? "teste" : "produção"}.`)} />
                </span>
                <Button className="btn--mini" variante="secundario" aria-label={`Remover ${a.host}`}
                  onClick={() => rodar(() => api.del(`/api/auditoria/hosts/${encodeURIComponent(a.host)}`), `${a.host} removido.`)}>Remover</Button>
              </>
            } />
        ))}
        <div className="campos">
          <input className="campo" aria-label="Novo host" placeholder="app.seudominio.com.br" value={novo} onChange={(e) => setNovo(e.target.value)} />
          <Button variante="secundario" disabled={!novo.trim()}
            onClick={() => rodar(() => api.post("/api/auditoria/hosts", { host: novo.trim() }), "Site adicionado.", () => setNovo(""))}>
            Adicionar host
          </Button>
        </div>
        <p className="sub" style={{ margin: "10px 0 0" }}>
          Marque um site como <strong>teste/staging</strong> para liberá-lo como alvo na aba Ataque. Produção nunca é alvo.
        </p>
      </Card>

      {sugeridos.length > 0 && (
        <>
          <h2 className="secao">Sugestões do tráfego</h2>
          <Card>
            <p className="sub" style={{ marginTop: 0 }}>
              Hosts das suas zonas vistos no tráfego. Só entram na auditoria depois que você confirmar.
            </p>
            {sugeridos.map((a) => (
              <ListRow key={a.host} titulo={a.host}
                detalhe={`sugerido${a.acessos ? ` · ${a.acessos} acessos em 7 dias` : ""}`}
                fim={
                  <>
                    <Button className="btn--mini" aria-label={`Confirmar ${a.host}`}
                      onClick={() => rodar(() => api.post("/api/auditoria/hosts", { host: a.host }), `${a.host} confirmado.`)}>Confirmar</Button>{" "}
                    <Button className="btn--mini" variante="secundario" aria-label={`Recusar ${a.host}`}
                      onClick={() => rodar(() => api.del(`/api/auditoria/hosts/${encodeURIComponent(a.host)}`), `${a.host} recusado.`)}>Recusar</Button>
                  </>
                } />
            ))}
          </Card>
        </>
      )}
    </>
  );
}
