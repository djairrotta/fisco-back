// Encaminhamento e resposta automática (Sieve, API.md §9).
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Campo, ConfirmDialog, Icone, Toggle, useToast } from "../ui";
import { ApiError } from "../api";
import { api2, type Recursos, type Regras as TRegras } from "../api2";
import { useCaixa } from "../caixas";
import { erroMsg } from "../lib";
import { nomeCaixa } from "../marca";
import { useShell } from "../shell/contexto";
import { separarEnderecos } from "./Leitura";
import Pagina from "./Pagina";

function Enderecos({ valor, onChange, max, proprio }: { valor: string[]; onChange: (v: string[]) => void; max: number; proprio: string }) {
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState("");
  const adicionar = () => {
    const { validos, invalidos } = separarEnderecos(texto);
    if (invalidos.length) { setErro(`Endereço inválido: ${invalidos.join(", ")}`); return; }
    if (validos.includes(proprio.toLowerCase())) { setErro("Não dá para encaminhar para a própria caixa."); return; }
    const novos = [...new Set([...valor, ...validos])];
    if (novos.length > max) { setErro(`No máximo ${max} endereços neste servidor.`); return; }
    onChange(novos); setTexto(""); setErro("");
  };
  return (
    <div className="regras-end">
      <div className="regras-end__chips">
        {valor.map((e) => (
          <span key={e} className="esc-anexo">
            <Icone nome="naoLida" tam={13} /><span className="esc-anexo__nome">{e}</span>
            <button type="button" aria-label={`Remover ${e}`} onClick={() => onChange(valor.filter((x) => x !== e))}><Icone nome="fechar" tam={13} /></button>
          </span>
        ))}
        <input className="regras-end__in" aria-label="Encaminhar para" inputMode="email" autoCapitalize="none" placeholder={valor.length ? "Outro endereço" : "nome@dominio.com.br"}
          value={texto} onChange={(e) => { setTexto(e.target.value); setErro(""); }} onBlur={() => texto.trim() && adicionar()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); adicionar(); } if (e.key === "Backspace" && !texto && valor.length) onChange(valor.slice(0, -1)); }} />
      </div>
      {erro ? <span className="campo-bloco__erro" role="alert">{erro}</span> : <span className="campo-bloco__ajuda">Enter para adicionar. Até {max} endereços.</span>}
    </div>
  );
}

export default function Regras() {
  const id = Number(useParams().id);
  const caixa = useCaixa(id);
  const { layout } = useShell();
  const { mostrar } = useToast();
  const [r, setR] = useState<TRegras | null>(null);
  const [salvo, setSalvo] = useState<string>("");
  const [recursos, setRecursos] = useState<Recursos | null>(null);
  const [indisponivel, setIndisponivel] = useState("");
  const [outro, setOutro] = useState<string | undefined>();
  const [erro, setErro] = useState("");
  const [avisos, setAvisos] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [confirmar, setConfirmar] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(""); setIndisponivel("");
    try {
      const x = await api2.lerRegras(id);
      const regras = { encaminhar: x.encaminhar, ferias: x.ferias };
      setR(regras); setSalvo(JSON.stringify(regras));
      if (x.suportado) { setRecursos(x.recursos); setOutro(x.outroScriptAtivo); } else setIndisponivel(x.motivo);
    } catch (e) { setErro(erroMsg(e)); }
  }, [id]);
  useEffect(() => { void carregar(); }, [carregar]);

  async function salvar(substituir = false) {
    if (!r) return;
    setOcupado(true); setErro(""); setAvisos([]); setConfirmar(null);
    try {
      const x = await api2.salvarRegras(id, r, substituir);
      const regras = { encaminhar: x.encaminhar, ferias: x.ferias };
      setR(regras); setSalvo(JSON.stringify(regras)); setRecursos(x.recursos); setOutro(x.outroScriptAtivo); setAvisos(x.avisos ?? []);
      mostrar(x.encaminhar.ativo || x.ferias.ativo ? "Regras ativadas no servidor" : "Regras desligadas", { icone: "regras" });
    } catch (e) {
      const corpo = e instanceof ApiError ? (e.corpo as { outroScriptAtivo?: string; suportado?: boolean } | null) : null;
      if (e instanceof ApiError && e.status === 409 && corpo?.outroScriptAtivo) setConfirmar(corpo.outroScriptAtivo);
      else if (e instanceof ApiError && e.status === 503 && corpo?.suportado === false) setIndisponivel(e.message);
      else setErro(erroMsg(e));
    } finally { setOcupado(false); }
  }

  if (!caixa) return null;
  const sujo = !!r && JSON.stringify(r) !== salvo;
  const enc = r?.encaminhar, fer = r?.ferias;
  const setEnc = (v: Partial<TRegras["encaminhar"]>) => setR((x) => (x ? { ...x, encaminhar: { ...x.encaminhar, ...v } } : x));
  const setFer = (v: Partial<TRegras["ferias"]>) => setR((x) => (x ? { ...x, ferias: { ...x.ferias, ...v } } : x));
  const uma = layout === "uma";

  return (
    <Pagina titulo="Regras" sub={`Encaminhamento e resposta automática de ${caixa.endereco}, aplicados pelo servidor mesmo com o Correio fechado.`}
      voltar={{ rotulo: uma ? "Ajustes" : nomeCaixa(caixa), href: `/c/${id}/config` }}
      acao={r && !indisponivel ? <Button variante="liquido" tam="p" disabled={!sujo || ocupado} onClick={() => void salvar()}>{ocupado ? "Salvando…" : sujo ? "Salvar" : "Salvo"}</Button> : undefined}>
      {erro && <p className="aviso aviso--perigo regras-aviso" role="alert"><Icone nome="alerta" tam={16} />{erro}</p>}
      {indisponivel && (
        <div className="regras-indisp" role="status">
          <span className="regras-indisp__ic"><Icone nome="regras" tam={26} /></span>
          <h2 className="regras-indisp__titulo">Regras indisponíveis neste servidor</h2>
          <p className="regras-indisp__motivo">{indisponivel}</p>
          <p className="regras-indisp__nota">Encaminhamento e resposta automática dependem do serviço de filtros (ManageSieve) do provedor. O resto do Correio continua funcionando.</p>
          <Button variante="cinza" icone="atualizar" onClick={() => void carregar()}>Tentar de novo</Button>
        </div>
      )}
      {!r && !erro && !indisponivel && <div className="regras-carregando"><span className="esq" /><span className="esq" /><span className="esq esq--fraco" /></div>}
      {r && enc && fer && !indisponivel && (
        <>
          {outro && (
            <p className="aviso regras-aviso" role="status"><Icone nome="alerta" tam={16} />
              <span>O filtro “{outro}” está ativo no servidor (criado por outro programa). Ao ligar uma regra aqui, o Correio pergunta antes de substituí-lo.</span>
            </p>
          )}
          {avisos.map((a) => <p key={a} className="aviso regras-aviso" role="status"><Icone nome="alerta" tam={16} /><span>{a}</span></p>)}

          <section className={`regra${enc.ativo ? " regra--on" : ""}`} aria-label="Encaminhamento">
            <header className="regra__cab">
              <span className="regra__ic"><Icone nome="encaminhar" tam={18} /></span>
              <div className="regra__txt">
                <h2>Encaminhar automaticamente</h2>
                <p>{enc.ativo && enc.para.length ? `Cada mensagem recebida segue para ${enc.para.join(", ")}.` : "Envia uma cópia de cada mensagem recebida para outros endereços."}</p>
              </div>
              <Toggle rotulo="Encaminhar automaticamente" ligado={enc.ativo} onChange={(v) => setEnc({ ativo: v })} />
            </header>
            <div className="regra__corpo" hidden={!enc.ativo}>
              <Campo rotulo="Para"><Enderecos valor={enc.para} onChange={(v) => setEnc({ para: v })} max={recursos?.maxEncaminhamentos ?? 4} proprio={caixa.endereco} /></Campo>
              <label className="regra__op">
                <Toggle rotulo="Manter uma cópia nesta caixa" ligado={enc.manterCopia} onChange={(v) => setEnc({ manterCopia: v })} />
                <span><strong>Manter uma cópia nesta caixa</strong><small>Desligado, a mensagem só chega aos endereços acima.</small></span>
              </label>
            </div>
          </section>

          <section className={`regra${fer.ativo ? " regra--on" : ""}`} aria-label="Resposta automática">
            <header className="regra__cab">
              <span className="regra__ic"><Icone nome="ferias" tam={18} /></span>
              <div className="regra__txt">
                <h2>Resposta automática</h2>
                <p>{fer.ativo ? `Responde a quem escrever${fer.inicio || fer.fim ? `, ${fer.inicio ? `de ${fer.inicio.split("-").reverse().join("/")}` : ""}${fer.fim ? ` até ${fer.fim.split("-").reverse().join("/")}` : ""}` : ""}.` : "Avisa quem escreve que você está fora, de férias ou em audiência."}</p>
              </div>
              <Toggle rotulo="Resposta automática" ligado={fer.ativo} disabled={recursos?.ferias === false} onChange={(v) => setFer({ ativo: v })} />
            </header>
            {recursos?.ferias === false && <p className="regra__nota">O servidor não oferece resposta automática (extensão vacation).</p>}
            <div className="regra__corpo" hidden={!fer.ativo}>
              <Campo rotulo="Assunto"><input className="campo" aria-label="Assunto da resposta" placeholder="Ausente até segunda-feira" maxLength={200} value={fer.assunto} onChange={(e) => setFer({ assunto: e.target.value })} /></Campo>
              <Campo rotulo="Mensagem"><textarea className="campo campo--area" rows={5} aria-label="Mensagem da resposta" maxLength={5000}
                placeholder="Olá! Estou fora do escritório até 14/10. Para assuntos urgentes, ligue (19) 3656-0000." value={fer.mensagem} onChange={(e) => setFer({ mensagem: e.target.value })} /></Campo>
              <div className="form-grade">
                <Campo rotulo="Começa em" ajuda="Opcional"><input className="campo" type="date" aria-label="Começa em" value={fer.inicio ?? ""} max={fer.fim || undefined} onChange={(e) => setFer({ inicio: e.target.value || undefined })} /></Campo>
                <Campo rotulo="Termina em" ajuda="Opcional, inclusive"><input className="campo" type="date" aria-label="Termina em" value={fer.fim ?? ""} min={fer.inicio || undefined} onChange={(e) => setFer({ fim: e.target.value || undefined })} /></Campo>
              </div>
              {recursos?.datas === false && <p className="regra__nota">Este servidor não aceita datas no filtro: a resposta vale enquanto estiver ligada.</p>}
              <div className="regra__dias">
                <span><strong>Responder a cada</strong><small>Intervalo mínimo entre respostas ao mesmo remetente.</small></span>
                <span className="passo">
                  <button type="button" aria-label="Menos um dia" disabled={fer.dias <= 1} onClick={() => setFer({ dias: fer.dias - 1 })}><Icone nome="minimizar" tam={14} /></button>
                  <output aria-live="polite">{fer.dias} {fer.dias === 1 ? "dia" : "dias"}</output>
                  <button type="button" aria-label="Mais um dia" disabled={fer.dias >= 30} onClick={() => setFer({ dias: fer.dias + 1 })}><Icone nome="mais_" tam={14} /></button>
                </span>
              </div>
            </div>
          </section>
          <p className="regras-rodape">As regras ficam no servidor de e-mail num filtro chamado “correio”. Elas valem também para o webmail.</p>
        </>
      )}
      {confirmar && (
        <ConfirmDialog titulo={`Substituir o filtro “${confirmar}”?`} rotuloConfirmar="Substituir" perigo={false}
          texto="Outro filtro está ativo no servidor. Para ligar estas regras, o Correio ativa o filtro dele; o outro não é apagado, só desativado."
          onCancelar={() => setConfirmar(null)} onConfirmar={() => void salvar(true)} />
      )}
    </Pagina>
  );
}

