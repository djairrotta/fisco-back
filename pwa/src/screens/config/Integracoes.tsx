import { useState } from "react";
import { Button, Card, ConfirmDialog, ListRow, Segmented } from "../../ui";
import { api } from "../../api";
import { dataHora, erroMsg, useCarga } from "../../lib";

type Escopo = "ler" | "escrever";
interface Token {
  id: number; nome: string; escopos: Escopo[]; criadoEm: string;
  ultimoUso: string | null; revogadoEm: string | null;
}
interface Criado { id: number; nome: string; escopos: Escopo[]; token: string }
interface AppOAuth { id: number; cliente: string; escopos: Escopo[]; criadoEm: string; ultimoUso: string | null }

const HOST_PADRAO = "https://vigia.judinfo.com.br";

/** Origem do PWA (o MCP fica no mesmo host). */
export function origemAtual(): string {
  try {
    const o = globalThis.location?.origin;
    return o && o !== "null" ? o : HOST_PADRAO;
  } catch {
    return HOST_PADRAO;
  }
}

/** JSON para o conector personalizado do Claude. */
export function snippetConector(url: string, token: string): string {
  return JSON.stringify({
    name: "Vigia",
    url,
    headers: { Authorization: `Bearer ${token}` },
  }, null, 2);
}

export function comandoClaudeCode(url: string, token: string): string {
  return `claude mcp add --transport http vigia ${url} --header "Authorization: Bearer ${token}"`;
}

const rotuloEscopo = (e: Escopo[]) => (e.includes("escrever") ? "leitura e escrita" : "só leitura");

async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}

export default function Integracoes() {
  const { dados, erro: erroCarga, recarregar } = useCarga<Token[]>("/api/tokens");
  const [nome, setNome] = useState("Claude");
  const [escopo, setEscopo] = useState<Escopo>("ler");
  const [criado, setCriado] = useState<Criado | null>(null);
  const { dados: apps, erro: erroApps, recarregar: recarregarApps } = useCarga<AppOAuth[]>("/api/oauth/apps");
  const [revogar, setRevogar] = useState<Token | null>(null);
  const [revogarApp, setRevogarApp] = useState<AppOAuth | null>(null);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const url = `${origemAtual()}/mcp`;
  const host = new URL(url).host;
  const tokenExemplo = criado?.token ?? "<token>";

  async function criar() {
    setErro(""); setAviso(""); setOcupado(true);
    try {
      const r = await api.post<Criado>("/api/tokens", { nome: nome.trim(), escopo });
      setCriado(r);
      await recarregar();
    } catch (e) {
      setErro(erroMsg(e));
    } finally {
      setOcupado(false);
    }
  }

  async function confirmarRevogar(t: Token) {
    setRevogar(null); setErro(""); setAviso("");
    try {
      await api.post(`/api/tokens/${t.id}/revogar`);
      if (criado?.id === t.id) setCriado(null);
      setAviso(`Token "${t.nome}" revogado.`);
      await recarregar();
    } catch (e) {
      setErro(erroMsg(e));
    }
  }

  async function confirmarRevogarApp(a: AppOAuth) {
    setRevogarApp(null); setErro(""); setAviso("");
    try {
      await api.post(`/api/oauth/apps/${a.id}/revogar`);
      setAviso(`Acesso de "${a.cliente}" revogado.`);
      await recarregarApps();
    } catch (e) {
      setErro(erroMsg(e));
    }
  }

  async function copiarCom(texto: string, oque: string) {
    setAviso((await copiar(texto)) ? `${oque} copiado.` : "Não foi possível copiar; selecione e copie manualmente.");
  }

  const ativos = (dados ?? []).filter((t) => !t.revogadoEm);
  const revogados = (dados ?? []).filter((t) => t.revogadoEm);

  return (
    <>
      <h2 className="secao">Integrações</h2>
      <Card>
        <ListRow titulo="Servidor MCP" detalhe={<code className="mono">{url}</code>}
          fim={<Button variante="secundario" onClick={() => void copiarCom(url, "Endereço")}>Copiar</Button>} />
        <p className="sub">
          Use com o Claude (conector personalizado com OAuth, ou Claude Code com token). Cada token vale só para a API
          (<code className="mono">/api/v1</code>) e o MCP; nunca entra no app nem cria outros tokens.
        </p>
      </Card>

      <Card>
        <h3 className="card__titulo">Novo token</h3>
        <div className="campos" style={{ marginTop: 0 }}>
          <input className="campo" aria-label="Nome do token" placeholder="Ex.: Claude" maxLength={60}
            value={nome} onChange={(e) => setNome(e.target.value)} autoCapitalize="off" autoCorrect="off" />
          <Segmented<Escopo>
            opcoes={[{ valor: "ler", rotulo: "Só leitura" }, { valor: "escrever", rotulo: "Leitura e escrita" }]}
            valor={escopo} onChange={setEscopo} />
          <Button bloco onClick={() => void criar()} disabled={ocupado || !nome.trim()}>Criar token</Button>
        </div>
        {erro && <p className="erro-txt" role="alert">{erro}</p>}
        {aviso && <p className="aviso-txt" role="status">{aviso}</p>}
        {criado && (
          <div className="token-novo" aria-label="Token criado">
            <p className="aviso-txt">Copie agora: este token não será mostrado de novo.</p>
            <code className="mono token-novo__valor">{criado.token}</code>
            <Button bloco onClick={() => void copiarCom(criado.token, "Token")}>Copiar token</Button>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="card__titulo">Conector do Claude (OAuth)</h3>
        <p className="sub">
          claude.ai, Claude Desktop e celular: Configurações → Conectores → Adicionar conector personalizado, com nome
          “Vigia” e a URL acima. Não precisa de token: o Claude abre o Vigia, você entra com a passkey e escolhe
          só leitura ou leitura e escrita.
        </p>
        <p className="sub">Claude Code (token):</p>
        <pre className="mono bloco-codigo" aria-label="Comando do Claude Code">{comandoClaudeCode(url, tokenExemplo)}</pre>
        <p className="sub">Clientes com cabeçalho fixo (token):</p>
        <pre className="mono bloco-codigo" aria-label="JSON do conector">{snippetConector(url, tokenExemplo)}</pre>
        <Button variante="secundario" bloco onClick={() => void copiarCom(snippetConector(url, tokenExemplo), "JSON")}>Copiar JSON</Button>
        <p className="sub">
          <strong>Cloudflare Access:</strong> o Access bloqueia o Claude antes do Vigia. Em Zero Trust → Access →
          Applications, crie aplicações com política de ação <strong>Bypass</strong> (Include: Everyone) para{" "}
          <code className="mono">{host}/mcp</code>, <code className="mono">{host}/api/v1/*</code>,{" "}
          <code className="mono">{host}/.well-known/*</code>, <code className="mono">{host}/oauth/token</code>,{" "}
          <code className="mono">{host}/oauth/registrar</code> e <code className="mono">{host}/oauth/revogar</code>.
          A página <code className="mono">/oauth/autorizar</code> continua atrás do Access e da passkey, como o resto
          do app. Detalhes em docs/MCP.md.
        </p>
      </Card>

      <Card>
        <h3 className="card__titulo">Apps autorizados (OAuth)</h3>
        {erroApps && <p className="erro-txt" role="alert">{erroApps}</p>}
        {apps && apps.length === 0 && <p className="sub">Nenhum app autorizado.</p>}
        {(apps ?? []).map((a) => (
          <ListRow key={a.id} titulo={a.cliente}
            detalhe={`${rotuloEscopo(a.escopos)} · autorizado ${dataHora(a.criadoEm)} · último uso ${dataHora(a.ultimoUso)}`}
            fim={<Button variante="perigo" onClick={() => setRevogarApp(a)} aria-label={`Revogar acesso de ${a.cliente}`}>Revogar</Button>} />
        ))}
      </Card>

      <Card>
        <h3 className="card__titulo">Tokens</h3>
        {erroCarga && <p className="erro-txt" role="alert">{erroCarga}</p>}
        {dados && ativos.length === 0 && <p className="sub">Nenhum token ativo.</p>}
        {ativos.map((t) => (
          <ListRow key={t.id} titulo={t.nome}
            detalhe={`${rotuloEscopo(t.escopos)} · criado ${dataHora(t.criadoEm)} · último uso ${dataHora(t.ultimoUso)}`}
            fim={<Button variante="perigo" onClick={() => setRevogar(t)} aria-label={`Revogar ${t.nome}`}>Revogar</Button>} />
        ))}
        {revogados.length > 0 && (
          <p className="sub">{revogados.length} revogado(s): {revogados.slice(0, 5).map((t) => t.nome).join(", ")}</p>
        )}
      </Card>

      {revogar && (
        <ConfirmDialog titulo={`Revogar "${revogar.nome}"?`}
          texto="Quem usa este token (API ou MCP) perde o acesso na hora."
          onCancelar={() => setRevogar(null)}
          onConfirmar={() => void confirmarRevogar(revogar)} />
      )}
      {revogarApp && (
        <ConfirmDialog titulo={`Revogar acesso de "${revogarApp.cliente}"?`}
          texto="O aplicativo perde o acesso ao MCP na hora; para voltar, autorize de novo."
          onCancelar={() => setRevogarApp(null)}
          onConfirmar={() => void confirmarRevogarApp(revogarApp)} />
      )}
    </>
  );
}
