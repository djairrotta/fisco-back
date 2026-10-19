import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Logo } from "../ui";
import { ApiError } from "../api";
import { cadastrarPasskey, entrar, entrarComSenha } from "../auth";

/** Origem esperada pelo servidor (WEBAUTHN_ORIGIN), via rota pública. */
async function estadoAuth(): Promise<{ origem: string | null; loginSenha: boolean }> {
  try {
    const r = await fetch("/api/auth/estado", { credentials: "include", headers: { Accept: "application/json" } });
    if (!r.ok) return { origem: null, loginSenha: false };
    const j = (await r.json()) as { origem?: unknown; loginSenha?: unknown };
    return { origem: typeof j.origem === "string" ? j.origem : null, loginSenha: j.loginSenha === true };
  } catch {
    return { origem: null, loginSenha: false };
  }
}

/** Mensagem do servidor quando houver; senão, uma descrição do erro do navegador. */
function mensagemErro(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const nome = (e as { name?: string } | null)?.name;
  if (nome === "NotAllowedError") return "Autenticação cancelada ou não permitida.";
  if (e instanceof Error && e.message) return e.message;
  return `Não foi possível autenticar${nome ? ` (${nome})` : ""}.`;
}

/** Só caminhos internos (ex.: /oauth/autorizar?...); nunca outra origem. */
export function destinoSeguro(v: string | null): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return "/";
  return v;
}

export default function Login() {
  const [params] = useSearchParams();
  const convite = params.get("convite");
  const voltar = destinoSeguro(params.get("voltar"));
  const nav = useNavigate();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [esperada, setEsperada] = useState<string | null>(null);
  const [loginSenha, setLoginSenha] = useState(false);
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [logadoPorSenha, setLogadoPorSenha] = useState(false);

  useEffect(() => {
    let vivo = true;
    void estadoAuth().then((e) => {
      if (!vivo) return;
      if (e.origem) setEsperada(e.origem);
      setLoginSenha(e.loginSenha);
    });
    return () => { vivo = false; };
  }, []);

  async function entrarSenha(ev: React.FormEvent) {
    ev.preventDefault();
    setOcupado(true);
    setErro("");
    try {
      await entrarComSenha(usuario, senha);
      setSenha("");
      setLogadoPorSenha(true);
    } catch (e) {
      setErro(mensagemErro(e));
    } finally {
      setOcupado(false);
    }
  }

  async function cadastrarAgora() {
    setOcupado(true);
    setErro("");
    try {
      await cadastrarPasskey();
      nav(voltar, { replace: true });
    } catch (e) {
      setErro(`${mensagemErro(e)} Você continua logado; pode tentar de novo ou seguir sem passkey.`);
    } finally {
      setOcupado(false);
    }
  }

  async function acionar() {
    setOcupado(true);
    setErro("");
    try {
      if (convite) {
        await cadastrarPasskey(convite);
        // Após cadastrar, entra com a passkey recém-criada.
      }
      await entrar();
      nav(voltar, { replace: true });
    } catch (e) {
      const o = (e instanceof ApiError ? (e.corpo as { origemEsperada?: unknown } | null)?.origemEsperada : null);
      if (typeof o === "string") setEsperada(o);
      setErro(mensagemErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const outraOrigem = esperada !== null && esperada !== location.origin;
  const linkCerto = esperada ? `${esperada}/login${location.search ?? ""}` : "";

  return (
    <main className="app app--bare login">
      <Logo size={96} className="logo" />
      <h1>Vigia</h1>
      {outraOrigem && (
        <div className="banner banner--perigo" role="alert">
          <span>
            Este endereço não é o configurado no servidor e o Face ID será recusado. Abra pelo endereço{" "}
            <a href={linkCerto}>{esperada}</a>
          </span>
        </div>
      )}
      <p>{convite ? "Convite recebido. Cadastre este dispositivo para acessar." : "Monitor de segurança"}</p>
      {logadoPorSenha ? (
        <>
          <p>Você entrou com usuário e senha. Cadastre a passkey deste aparelho para as próximas vezes.</p>
          <Button bloco onClick={cadastrarAgora} disabled={ocupado}>Cadastrar passkey neste aparelho</Button>
          <Button bloco variante="secundario" onClick={() => nav(voltar, { replace: true })} disabled={ocupado}>
            Agora não, ir para o painel
          </Button>
        </>
      ) : (
        <>
          <Button bloco onClick={acionar} disabled={ocupado}>
            {convite ? "Cadastrar este dispositivo (Face ID)" : "Entrar com passkey"}
          </Button>
          {loginSenha && !convite && (
            <form className="campos login-senha" onSubmit={entrarSenha}>
              <p className="sub" style={{ margin: "16px 0 0" }}>ou entre com usuário e senha</p>
              <input className="campo" autoComplete="username" placeholder="Usuário" value={usuario}
                onChange={(e) => setUsuario(e.target.value)} aria-label="Usuário" required />
              <input className="campo" type="password" autoComplete="current-password" placeholder="Senha" value={senha}
                onChange={(e) => setSenha(e.target.value)} aria-label="Senha" required />
              <Button bloco variante="secundario" type="submit" disabled={ocupado || !usuario || !senha}>Entrar</Button>
            </form>
          )}
        </>
      )}
      <p className="erro" role="status" aria-live="assertive">{erro}</p>
    </main>
  );
}
