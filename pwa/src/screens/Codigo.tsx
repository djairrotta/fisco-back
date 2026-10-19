import { useRef, useState } from "react";
import { Badge, Button, Card, ListRow } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";

type Sev = "critica" | "alta" | "media" | "baixa" | "informativa";
interface Achado {
  arquivo: string;
  linha: number | null;
  severidade: Sev;
  titulo: string;
  risco: string;
  fix: string;
  needs_validation: boolean;
}
interface Analise {
  id: number;
  criado: string;
  repo: string;
  origem: string;
  modelo: string;
  resumo: string;
  achados: Achado[];
  arquivos: number;
}
interface Dados { analises: Analise[]; rodando: boolean }

const SEV: Record<Sev, { rotulo: string; tom: "perigo" | "aviso" | "neutro" }> = {
  critica: { rotulo: "Crítica", tom: "perigo" },
  alta: { rotulo: "Alta", tom: "perigo" },
  media: { rotulo: "Média", tom: "aviso" },
  baixa: { rotulo: "Baixa", tom: "neutro" },
  informativa: { rotulo: "Info", tom: "neutro" },
};

export default function Codigo() {
  const d = useCarga<Dados>("/api/codigo", 20_000);
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [falha, setFalha] = useState("");
  const [enviando, setEnviando] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function analisarGithub() {
    setMsg(""); setFalha("");
    if (!url.trim()) { setFalha("Cole o link do repositório"); return; }
    setEnviando(true);
    try {
      const r = await api.post<{ repo: string; mensagem: string }>(
        "/api/codigo/github",
        { url: url.trim() },
      );
      setMsg(`${r.repo}: ${r.mensagem}`);
      setUrl("");
      void d.recarregar();
    } catch (e) { setFalha(erroMsg(e)); } finally { setEnviando(false); }
  }

  async function analisarZip(file: File) {
    setMsg(""); setFalha("");
    if (file.size > 25 * 1024 * 1024) { setFalha("Zip maior que 25 MB"); return; }
    setEnviando(true);
    try {
      const fd = new FormData();
      fd.append("arquivo", file);
      const resp = await fetch("/api/codigo/zip", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const corpo = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(corpo?.erro ?? `HTTP ${resp.status}`);
      setMsg(`${corpo.repo}: ${corpo.mensagem}`);
      void d.recarregar();
    } catch (e) { setFalha(erroMsg(e)); } finally {
      setEnviando(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="tela">
      <h1>Análise de código</h1>
      <p className="sub">
        O Revisor IA lê o código (nunca executa) e aponta falhas de segurança
        reais com o menor fix. Suba um zip do repositório ou cole um link do
        GitHub público.
      </p>

      <Card>
        <label className="campo">
          <span>Link do GitHub</span>
          <div className="linha">
            <input
              type="url"
              placeholder="https://github.com/dono/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={enviando}
            />
            <Button onClick={analisarGithub} disabled={enviando}>Analisar</Button>
          </div>
        </label>
        <div className="campo">
          <span>Ou suba um zip (até 25 MB)</span>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            disabled={enviando}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void analisarZip(f);
            }}
          />
        </div>
        {d.dados?.rodando && <p className="sub">Uma análise está rodando…</p>}
        {msg && <p className="ok">{msg}</p>}
        {falha && <p className="erro">{falha}</p>}
      </Card>

      {(d.dados?.analises ?? []).map((a) => (
        <Card key={a.id}>
          <ListRow
            titulo={a.repo}
            detalhe={`${a.origem} · ${a.arquivos} arquivos · ${dataHora(a.criado)}`}
            fim={<Badge tom="neutro">{a.achados.length} achado(s)</Badge>}
          />
          <p className="sub">{a.resumo}</p>
          {a.achados.map((f, i) => (
            <div key={i} className="achado">
              <div className="linha">
                <Badge tom={SEV[f.severidade].tom}>{SEV[f.severidade].rotulo}</Badge>
                <strong>{f.titulo}</strong>
                {f.needs_validation && <Badge tom="neutro">validar</Badge>}
              </div>
              <p className="mono">{f.arquivo}{f.linha ? `:${f.linha}` : ""}</p>
              <p>{f.risco}</p>
              <p className="fix"><strong>Fix:</strong> {f.fix}</p>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}
