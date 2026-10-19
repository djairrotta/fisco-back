import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Logo } from "../ui";
import { ApiError } from "../api";
import { cadastrarPasskey, entrar } from "../auth";

/** Origem esperada pelo servidor (WEBAUTHN_ORIGIN), via rota pública. */
async function origemEsperada(): Promise<string | null> {
  try {
    const r = await fetch("/api/auth/estado", { credentials: "include", headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = (await r.json()) as { origem?: unknown };
    return typeof j.origem === "string" ? j.origem : null;
  } catch {
    return null;
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

  useEffect(() => {
    let vivo = true;
    void origemEsperada().then((o) => { if (vivo && o) setEsperada(o); });
    return () => { vivo = false; };
  }, []);

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
      <Button bloco onClick={acionar} disabled={ocupado}>
        {convite ? "Cadastrar este dispositivo (Face ID)" : "Entrar com passkey"}
      </Button>
      <p className="erro" role="status" aria-live="assertive">{erro}</p>
    </main>
  );
}
