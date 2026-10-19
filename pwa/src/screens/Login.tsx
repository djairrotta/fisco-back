import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Icone } from "../ui";
import { avisoEndereco, cadastrarPasskey, entrar, entrarComSenha, estadoAuth, explicarErroPasskey, type EstadoAuth } from "../auth";
import { erroMsg } from "../lib";

export default function Login() {
  const [params] = useSearchParams();
  const convite = params.get("convite");
  const nav = useNavigate();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [esperado, setEsperado] = useState<EstadoAuth | null>(null);
  const [semServidor, setSemServidor] = useState("");
  const hostAtual = location.host;
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [logadoPorSenha, setLogadoPorSenha] = useState(false);

  async function entrarSenha(ev: React.FormEvent) {
    ev.preventDefault();
    setOcupado(true);
    setErro("");
    try {
      await entrarComSenha(usuario, senha);
      setSenha("");
      setLogadoPorSenha(true);
    } catch (e) {
      setErro(erroMsg(e));
    } finally {
      setOcupado(false);
    }
  }

  async function cadastrarAgora() {
    setOcupado(true);
    setErro("");
    try {
      await cadastrarPasskey();
      nav("/", { replace: true });
    } catch (e) {
      setErro(`${explicarErroPasskey(e, esperado, hostAtual)} Você continua logado; pode tentar de novo ou seguir sem passkey.`);
    } finally {
      setOcupado(false);
    }
  }

  useEffect(() => {
    estadoAuth().then(setEsperado).catch((e) => setSemServidor(`Servidor indisponível: ${erroMsg(e)}`));
  }, []);

  const aviso = avisoEndereco(esperado, hostAtual);

  async function acionar() {
    setOcupado(true);
    setErro("");
    let etapa: "registro" | "login" = convite ? "registro" : "login";
    try {
      if (convite) {
        await cadastrarPasskey(convite);
        etapa = "login"; // após cadastrar, entra com a passkey recém-criada
      }
      await entrar();
      nav("/", { replace: true });
    } catch (e) {
      const m = explicarErroPasskey(e, esperado, hostAtual);
      setErro(convite && etapa === "login" ? `Passkey cadastrada, mas o login falhou: ${m}` : m);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <main className="login">
      <div className="login__cartao">
        <img className="login__icone" src="/icons/icon-192.png" alt="" />
        <h1 className="login__titulo">Correio</h1>
        <p className="login__sub">{convite ? "Convite recebido. Cadastre este dispositivo para acessar." : "As caixas de e-mail dos seus domínios, num só lugar."}</p>
        {aviso && (
          <div className="aviso aviso--perigo" role="alert">
            <Icone nome="alerta" tam={16} />
            <span>Este endereço ({hostAtual}) não é o do servidor. <strong>{aviso}</strong></span>
            <a className="aviso__acao" href={`${esperado!.origem}${location.pathname}${location.search}`}>Abrir</a>
          </div>
        )}
        {semServidor && <p className="login__erro" role="alert">{semServidor}</p>}
        {logadoPorSenha ? (
          <>
            <p className="login__sub">Você entrou com usuário e senha. Cadastre a passkey deste aparelho para as próximas vezes.</p>
            <Button variante="liquido" tam="g" bloco icone="passkey" onClick={cadastrarAgora} disabled={ocupado}>
              {ocupado ? "Aguardando passkey…" : "Cadastrar passkey neste aparelho"}
            </Button>
            <Button variante="cinza" tam="g" bloco onClick={() => nav("/", { replace: true })} disabled={ocupado}>
              Agora não, abrir o Correio
            </Button>
          </>
        ) : (
          <>
            <Button variante="liquido" tam="g" bloco icone="passkey" onClick={acionar} disabled={ocupado}>
              {ocupado ? "Aguardando passkey…" : convite ? "Cadastrar este dispositivo (Face ID)" : "Entrar com passkey"}
            </Button>
            {esperado?.loginSenha && !convite && (
              <form onSubmit={entrarSenha} style={{ display: "grid", gap: 8, width: "100%", marginTop: 14 }}>
                <p className="login__nota" style={{ justifyContent: "center" }}>ou entre com usuário e senha</p>
                <input className="campo" autoComplete="username" placeholder="Usuário" value={usuario}
                  onChange={(e) => setUsuario(e.target.value)} aria-label="Usuário" required />
                <input className="campo" type="password" autoComplete="current-password" placeholder="Senha" value={senha}
                  onChange={(e) => setSenha(e.target.value)} aria-label="Senha" required />
                <Button variante="cinza" tam="g" bloco type="submit" disabled={ocupado || !usuario || !senha}>Entrar</Button>
              </form>
            )}
          </>
        )}
        <p className="login__erro" role="alert" aria-live="assertive">{erro}</p>
        <p className="login__nota"><Icone nome="seguro" tam={14} />{esperado?.loginSenha ? "Passkey (Face ID, Touch ID) ou usuário e senha." : "Acesso só com passkey: Face ID, Touch ID ou a senha do aparelho."}</p>
      </div>
    </main>
  );
}
