import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button, Card, Segmented } from "../ui";
import { ApiError, api } from "../api";
import { erroMsg } from "../lib";

type Escopo = "ler" | "escrever";
interface Pedido { cliente: string; redirectHost: string; redirectUri: string; escopos: Escopo[] }

const rotuloEscopo = (e: Escopo[]) => (e.includes("escrever") ? "leitura e escrita" : "só leitura");

/**
 * /oauth/autorizar: consentimento OAuth do MCP (conector do claude.ai e apps
 * do Claude). Exige a sessão de passkey: sem ela, api.ts manda ao login e o
 * login volta para cá. O servidor revalida tudo em /api/oauth/decidir.
 */
export default function Autorizar() {
  const { search } = useLocation();
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [erro, setErro] = useState("");
  const [escopo, setEscopo] = useState<Escopo>("ler");
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    api.get<Pedido>(`/api/oauth/pedido${search}`).then(
      (p) => { if (vivo) setPedido(p); },
      (e) => {
        if (!vivo) return;
        if (e instanceof ApiError && e.status === 401) return; // indo para o login
        const red = e instanceof ApiError ? (e.corpo as { redirect?: unknown } | null)?.redirect : undefined;
        setErro(erroMsg(e));
        if (typeof red === "string") location.assign(red);
      },
    );
    return () => { vivo = false; };
  }, [search]);

  async function decidir(aprovar: boolean) {
    setOcupado(true); setErro("");
    try {
      const params = Object.fromEntries(new URLSearchParams(search));
      const r = await api.post<{ redirect: string }>("/api/oauth/decidir", { params, escopo, aprovar });
      location.assign(r.redirect);
    } catch (e) {
      setErro(erroMsg(e));
      setOcupado(false);
    }
  }

  return (
    <main className="app app--bare login">
      <img className="logo" src="/icons/icon-192.png" alt="" />
      {!pedido && !erro && <p role="status">Carregando pedido…</p>}
      {pedido && (
        <>
          <h1>Autorizar {pedido.cliente}?</h1>
          <Card>
            <p className="sub">
              O aplicativo <strong>{pedido.cliente}</strong> (nome informado pelo próprio aplicativo) quer acessar o
              MCP do Vigia. Depois de autorizar, você volta para:
            </p>
            <p><code className="mono">{pedido.redirectHost}</code></p>
            <p className="sub">O aplicativo pediu: {rotuloEscopo(pedido.escopos)}.</p>
            <Segmented<Escopo>
              opcoes={[{ valor: "ler", rotulo: "Só leitura" }, { valor: "escrever", rotulo: "Leitura e escrita" }]}
              valor={escopo} onChange={setEscopo} />
            <p className="sub">
              {escopo === "escrever"
                ? "Leitura e escrita: pode bloquear e desbloquear IPs e mudar regras reais no Cloudflare."
                : "Só leitura: status, incidentes, bloqueios, regras e IAs, sem mudar nada."}{" "}
              Revogue quando quiser em Config → Integrações.
            </p>
          </Card>
          <Button bloco onClick={() => void decidir(true)} disabled={ocupado}>Autorizar</Button>
          <Button bloco variante="secundario" onClick={() => void decidir(false)} disabled={ocupado}>Negar</Button>
        </>
      )}
      {erro && (
        <>
          {!pedido && <h1>Pedido de acesso inválido</h1>}
          <p className="erro" role="alert">{erro}</p>
        </>
      )}
    </main>
  );
}
