import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, Button, Campo, Grupo, Icone, ListRow, Toggle } from "../ui";
import { useCaixas } from "../caixas";
import { nomeCaixa } from "../marca";
import Pagina from "./Pagina";
import { api } from "../api";
import { cadastrarPasskey, estadoAuth, explicarErroPasskey, sair, type EstadoAuth } from "../auth";
import { ativarPush, desativarPush, inscricaoAtual, pushSuportado } from "../push";
import { dataHora, erroMsg, useCarga } from "../lib";

interface Ia { modelo: string; ativo: boolean; timeoutS: number; chaveConfigurada: boolean }
interface Passkey { id: number; credencial: string; transportes: string[]; criado: string }
type Notif = { recebido: boolean; enviado: boolean; falha: boolean };

function Push() {
  const [ligado, setLigado] = useState<boolean | null>(null);
  const [msg, setMsg] = useState("");
  const [erro, setErro] = useState("");
  useEffect(() => {
    if (!pushSuportado()) { setLigado(false); setMsg("Este navegador não suporta push. No iPhone, adicione o Correio à Tela de Início."); return; }
    inscricaoAtual().then((s) => setLigado(!!s)).catch(() => setLigado(false));
  }, []);
  async function alternar(v: boolean) {
    setErro(""); setMsg("");
    try {
      if (v) {
        const r = await ativarPush();
        if (r === "ativado") { setLigado(true); setMsg("Notificações ativadas neste aparelho."); }
        else if (r === "negado") setErro("Permissão de notificação negada. Libere nos ajustes do navegador.");
        else setErro("Este navegador não suporta push.");
      } else {
        await desativarPush();
        setLigado(false);
        setMsg("Notificações desativadas neste aparelho.");
      }
    } catch (e) { setErro(erroMsg(e)); }
  }
  return (
    <>
      <ListRow titulo="Notificações neste aparelho" icone="notificacoes"
        fim={<Toggle rotulo="Notificações neste aparelho" ligado={!!ligado} disabled={ligado === null || !pushSuportado()} onChange={(v) => void alternar(v)} />} />
      {msg && <p className="row-nota" role="status">{msg}</p>}
      {erro && <p className="row-nota txt-perigo" role="alert">{erro}</p>}
    </>
  );
}

function NotifGlobal() {
  const c = useCarga<{ global: Notif }>("/api/config/notificacoes");
  const [n, setN] = useState<Notif | null>(null);
  const [erro, setErro] = useState("");
  useEffect(() => { if (c.dados) setN(c.dados.global); }, [c.dados]);
  const itens = [
    { tipo: "recebido", rotulo: "E-mail recebido" },
    { tipo: "enviado", rotulo: "E-mail enviado" },
    { tipo: "falha", rotulo: "Falha de envio ou conexão" },
  ] as const;
  async function alternar(tipo: keyof Notif, ativo: boolean) {
    setErro("");
    setN((x) => (x ? { ...x, [tipo]: ativo } : x));
    try { await api.put("/api/config/notificacoes", { caixa: null, tipo, ativo }); }
    catch (e) { setN((x) => (x ? { ...x, [tipo]: !ativo } : x)); setErro(erroMsg(e)); }
  }
  return (
    <>
      {(c.erro || erro) && <p className="row-nota txt-perigo" role="alert">{c.erro || erro}</p>}
      {n && itens.map((i) => (
        <ListRow key={i.tipo} titulo={i.rotulo}
          fim={<Toggle rotulo={`${i.rotulo} (padrão)`} ligado={n[i.tipo]} onChange={(v) => void alternar(i.tipo, v)} />} />
      ))}
    </>
  );
}

function Classificador() {
  const c = useCarga<Ia>("/api/config/ia");
  const [modelo, setModelo] = useState("");
  const [ia, setIa] = useState<Ia | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  useEffect(() => { if (c.dados) { setIa(c.dados); setModelo(c.dados.modelo); } }, [c.dados]);
  async function salvar(corpo: Partial<Pick<Ia, "modelo" | "ativo">>) {
    setMsg(null);
    try {
      const r = await api.put<Ia>("/api/config/ia", corpo);
      setIa(r); setModelo(r.modelo);
      setMsg({ ok: true, t: "Classificador atualizado." });
    } catch (e) { setMsg({ ok: false, t: erroMsg(e) }); }
  }
  if (c.erro) return <p className="row-nota txt-perigo" role="alert">{c.erro}</p>;
  if (!ia) return null;
  return (
    <>
      {!ia.chaveConfigurada && <p className="row-nota txt-aviso">Sem OPENROUTER_API_KEY no servidor: o selo de suspeita fica desligado.</p>}
      <ListRow titulo="Selo de possível phishing ou spam" icone="seguro"
        fim={<Toggle rotulo="Classificador ativo" ligado={ia.ativo} onChange={(v) => void salvar({ ativo: v })} />} />
      <div className="row-form">
        <Campo rotulo="Modelo (slug OpenRouter)"
          ajuda="typesafe/jev-* (exceto -router) usa a Decisions API do OpenRouter (decisão tipada ok/spam/phishing); outros modelos usam chat.">
          <span className="campo-linha">
            <input className="campo" value={modelo} maxLength={200} spellCheck={false} autoCapitalize="none"
              placeholder="typesafe/jev-1.13" aria-label="Modelo do classificador" onChange={(e) => setModelo(e.target.value)} />
            <Button variante="cinza" disabled={!modelo.trim() || modelo.trim() === ia.modelo}
              onClick={() => void salvar({ modelo: modelo.trim() })}>Salvar</Button>
          </span>
        </Campo>
        {msg && <p className={msg.ok ? "txt-ok" : "txt-perigo"} role={msg.ok ? "status" : "alert"}>{msg.t}</p>}
      </div>
    </>
  );
}

function Passkeys() {
  const c = useCarga<{ passkeys: Passkey[] }>("/api/config/passkeys");
  const [esperado, setEsperado] = useState<EstadoAuth | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { estadoAuth().then(setEsperado).catch(() => {}); }, []);
  async function adicionar() {
    setOcupado(true); setMsg(null);
    try {
      await cadastrarPasskey();
      setMsg({ ok: true, t: "Passkey deste aparelho cadastrada." });
      await c.recarregar();
    } catch (e) {
      setMsg({ ok: false, t: explicarErroPasskey(e, esperado, location.host) });
    } finally { setOcupado(false); }
  }
  return (
    <>
      {c.erro && <p className="row-nota txt-perigo" role="alert">{c.erro}</p>}
      {c.dados?.passkeys.map((p) => (
        <ListRow key={p.id} icone="passkey" titulo={`Passkey ${p.credencial}…`}
          detalhe={`Cadastrada em ${dataHora(p.criado)}${p.transportes.length ? ` (${p.transportes.join(", ")})` : ""}`} />
      ))}
      <ListRow icone="mais_" titulo={<button type="button" className="row-link" disabled={ocupado} onClick={() => void adicionar()}>
        {ocupado ? "Aguardando passkey…" : "Adicionar passkey deste aparelho"}
      </button>} />
      {msg && <p className={`row-nota ${msg.ok ? "txt-ok" : "txt-perigo"}`} role={msg.ok ? "status" : "alert"}>{msg.t}</p>}
    </>
  );
}

function ListaCaixasAjustes() {
  const { caixas, versao } = useCaixas();
  const nav = useNavigate();
  return (
    <>
      {(caixas ?? []).map((c) => (
        <ListRow key={c.id} seta icone={<Avatar caixa={c} tam={30} versao={versao} />} titulo={nomeCaixa(c)} detalhe={c.endereco}
          onClick={() => nav(`/c/${c.id}/config`)} />
      ))}
      <ListRow icone="mais_" titulo={<span className="row-link">Adicionar caixa</span>} onClick={() => nav("/caixas")} />
    </>
  );
}

export default function ConfigGeral() {
  const nav = useNavigate();
  const [erro, setErro] = useState("");
  return (
    <Pagina titulo="Ajustes">
      <Grupo titulo="Caixas" nota="Marca, assinatura, senha e notificações de cada caixa."><ListaCaixasAjustes /></Grupo>
      <Grupo titulo="Notificações" nota="O padrão vale para as caixas sem ajuste próprio."><Push /><NotifGlobal /></Grupo>
      <Grupo titulo="Classificador"><Classificador /></Grupo>
      <Grupo titulo="Diagnóstico" nota="Atividade e erros de envio, recebimento e filtros.">
        <ListRow seta icone="enviar_" titulo="Contas Resend"
          detalhe="Envio por domínio verificado na Resend (até 20 contas)."
          onClick={() => nav("/resend")} />
        <ListRow seta icone="regras" titulo="Registro"
          detalhe="Envios, conexões IMAP/SMTP, filtros e erros (últimos 30 dias)."
          onClick={() => nav("/registro")} />
      </Grupo>
      <Grupo titulo="Passkeys" nota="Cada aparelho entra com a própria passkey."><Passkeys /></Grupo>
      <Grupo>
        <button type="button" className="row row--click row--perigo" onClick={async () => {
          try { await sair(); nav("/login", { replace: true }); } catch (e) { setErro(erroMsg(e)); }
        }}><span className="row__ic"><Icone nome="sair" tam={17} /></span><span className="row__main"><span className="row__titulo">Sair</span></span></button>
        {erro && <p className="row-nota txt-perigo" role="alert">{erro}</p>}
      </Grupo>
    </Pagina>
  );
}
