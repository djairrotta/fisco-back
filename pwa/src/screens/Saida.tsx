// Caixa de saída (API.md §4): agendadas, tentativas de reenvio e falhas,
// com editar, reagendar, reenviar agora e cancelar.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotaoIcone, Button, ConfirmDialog, EsqueletoLeitura, EsqueletoLista, Icone, Popover, Sheet, Vazio, useToast } from "../ui";
import { api2, isoComFuso, type ItemSaida, type ItemSaidaCompleto } from "../api2";
import { dataLonga, erroMsg, tamanhoLegivel } from "../lib";
import { documentoIframe, sanitizarEmail } from "../sanitizar";
import { useShell } from "../shell/contexto";
import type { Caixa } from "../tipos";
import EscolhaHorario from "./Agendar";
import { separarEnderecos } from "./Leitura";

/** "hoje às 18:00", "amanhã às 08:00", "ontem às 09:12" ou "em 12/10 às 14:30". */
export function quandoRelativo(iso: string | null, agora = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dif = Math.round((dia(d) - dia(agora)) / 86400000);
  const h = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (dif === 0) return `hoje às ${h}`;
  if (dif === 1) return `amanhã às ${h}`;
  if (dif === -1) return `ontem às ${h}`;
  return `em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${h}`;
}

export function estadoSaida(s: ItemSaida, agora = new Date()): { selo: string; tom: "neutro" | "aviso" | "perigo" | "ok"; linha: string } {
  const quando = (iso: string | null) => quandoRelativo(iso, agora);
  const n = s.tentativas === 1 ? "1 tentativa" : `${s.tentativas} tentativas`;
  if (s.estado === "enviando") return { selo: "Enviando", tom: "ok", linha: "Enviando agora…" };
  if (s.estado === "falhou") return { selo: "Falhou", tom: "perigo", linha: `${s.ultimoErro ?? "Falha no envio"}${s.tentativas ? ` (${n})` : ""}` };
  if (s.origem === "falha") return { selo: "Nova tentativa", tom: "aviso", linha: `Tenta de novo ${quando(s.proximaTentativa)}${s.tentativas ? ` · ${n}` : ""}` };
  return { selo: "Agendada", tom: "neutro", linha: `Envio ${quando(s.agendarPara ?? s.proximaTentativa)}` };
}

/** Envio interrompido no meio: pode já ter saído, então reenviar pede confirmação. */
export const ehInterrompido = (s: ItemSaida) => s.estado === "falhou" && /envio interrompido/i.test(s.ultimoErro ?? "");

const destinatarios = (s: ItemSaida) => [...s.para, ...s.cc, ...s.cco].join(", ") || "(sem destinatário)";

function Editar({ caixa, item, onSalvo, onFechar }: { caixa: Caixa; item: ItemSaidaCompleto; onSalvo: (i: ItemSaidaCompleto) => void; onFechar: () => void }) {
  const [para, setPara] = useState(item.para.join(", "));
  const [cc, setCc] = useState(item.cc.join(", "));
  const [assunto, setAssunto] = useState(item.assunto);
  const ref = useRef<HTMLDivElement>(null);
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { if (ref.current) ref.current.innerHTML = sanitizarEmail(item.html, { semEstilo: true }).html; }, [item.html]);
  async function salvar() {
    const p = separarEnderecos(para), c = separarEnderecos(cc);
    if (p.invalidos.length || c.invalidos.length) { setErro(`Endereço inválido: ${[...p.invalidos, ...c.invalidos].join(", ")}`); return; }
    setOcupado(true); setErro("");
    try {
      const r = await api2.editarSaida(caixa.id, item.id, { para: p.validos, cc: c.validos, assunto, html: ref.current?.innerHTML ?? item.html });
      onSalvo(r.item);
    } catch (e) { setErro(erroMsg(e)); setOcupado(false); }
  }
  return (
    <Sheet aberto onFechar={onFechar} rotulo="Editar mensagem" titulo="Editar mensagem">
      <div className="saida-edit">
        <label className="campo-bloco"><span className="campo-bloco__rotulo">Para</span><input className="campo" aria-label="Para" value={para} onChange={(e) => setPara(e.target.value)} /></label>
        <label className="campo-bloco"><span className="campo-bloco__rotulo">Cc</span><input className="campo" aria-label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} /></label>
        <label className="campo-bloco"><span className="campo-bloco__rotulo">Assunto</span><input className="campo" aria-label="Assunto" value={assunto} onChange={(e) => setAssunto(e.target.value)} /></label>
        <div className="campo-bloco"><span className="campo-bloco__rotulo">Mensagem</span>
          <div ref={ref} className="saida-edit__corpo" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Mensagem" />
        </div>
        {item.anexos.length > 0 && <p className="campo-bloco__ajuda">Os anexos não mudam aqui; para trocá-los, cancele e envie de novo.</p>}
        {erro && <p className="txt-perigo" role="alert">{erro}</p>}
      </div>
      <div className="folha__rodape folha__rodape--lado">
        <Button variante="cinza" onClick={onFechar}>Cancelar</Button>
        <Button variante="liquido" disabled={ocupado} onClick={() => void salvar()}>{ocupado ? "Salvando…" : "Salvar"}</Button>
      </div>
    </Sheet>
  );
}

function Detalhe({ caixa, resumo, onMudou, onSaiu, voltar }: {
  caixa: Caixa; resumo: ItemSaida; onMudou: (i: ItemSaida) => void; onSaiu: (id: number) => void; voltar?: () => void;
}) {
  const { layout } = useShell();
  const { mostrar } = useToast();
  const [item, setItem] = useState<ItemSaidaCompleto | null>(null);
  const [erro, setErro] = useState("");
  const [menu, setMenu] = useState<"reagendar" | null>(null);
  const [editando, setEditando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [confirmarReenvio, setConfirmarReenvio] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const refReagendar = useRef<HTMLButtonElement>(null);
  const uma = layout === "uma";
  useEffect(() => {
    let vivo = true;
    setItem(null); setErro("");
    api2.lerSaida(caixa.id, resumo.id).then((i) => { if (vivo) setItem(i); }).catch((e) => { if (vivo) setErro(erroMsg(e)); });
    return () => { vivo = false; };
  }, [caixa.id, resumo.id, resumo.atualizadoEm]);
  const atual = item ?? resumo;
  const est = estadoSaida(atual);
  const doc = useMemo(() => (item ? documentoIframe(sanitizarEmail(item.html).html, false, { tema: "papel", margem: "20px 24px" }) : ""), [item]);
  const falha = (e: unknown) => mostrar(erroMsg(e), { tom: "perigo", icone: "alerta" });

  async function reagendar(d: Date) {
    setMenu(null);
    try {
      const r = await api2.editarSaida(caixa.id, resumo.id, { agendarPara: isoComFuso(d) });
      setItem(r.item); onMudou(r.item);
      mostrar(`Reagendada para ${dataLonga(isoComFuso(d))}`, { icone: "calendario" });
    } catch (e) { falha(e); }
  }
  async function reenviar(confirmado = false) {
    if (!confirmado && ehInterrompido(atual)) { setConfirmarReenvio(true); return; }
    setConfirmarReenvio(false);
    setOcupado(true);
    try {
      const r = await api2.reenviarSaida(caixa.id, resumo.id);
      if (r.enviado) { mostrar("Mensagem enviada", { icone: "enviados" }); onSaiu(resumo.id); return; }
      if (r.item) { onMudou(r.item); mostrar(r.item.estado === "falhou" ? `Falhou de novo: ${r.item.ultimoErro ?? ""}` : "Ainda sem conexão; nova tentativa agendada", { icone: "alerta", tom: "perigo" }); }
    } catch (e) { falha(e); } finally { setOcupado(false); }
  }
  async function cancelar() {
    setCancelando(false);
    try { await api2.cancelarSaida(caixa.id, resumo.id); mostrar("Envio cancelado", { icone: "lixeira" }); onSaiu(resumo.id); } catch (e) { falha(e); }
  }
  const enviando = atual.estado === "enviando";

  return (
    <article className="leitura" aria-label="Item da Caixa de saída">
      <div className="leitura__barra" role="toolbar" aria-label="Ações do envio">
        {voltar && <button type="button" className="voltar" onClick={voltar}><Icone nome="voltar" tam={24} /><span>Caixa de saída</span></button>}
        {!uma && <span className="barra-esp" />}
        <Button variante="cinza" tam="p" icone="caneta" disabled={!item || enviando} onClick={() => setEditando(true)}>Editar</Button>
        <Button ref={refReagendar} variante="cinza" tam="p" icone="calendario" disabled={enviando} onClick={() => setMenu(menu ? null : "reagendar")}>Reagendar</Button>
        <Button variante="liquido" tam="p" icone="enviados" disabled={enviando || ocupado} onClick={() => void reenviar()}>{ocupado ? "Enviando…" : "Reenviar agora"}</Button>
        <BotaoIcone icone="lixeira" rotulo="Cancelar envio" disabled={enviando} onClick={() => setCancelando(true)} />
      </div>
      <div className="leitura__rolagem">
        <header className="leitura__cab">
          <h1 className="leitura__assunto">{atual.assunto || "(sem assunto)"}</h1>
          <div className={`saida-estado saida-estado--${est.tom}`} role="status">
            <span className="saida-estado__ic"><Icone nome={est.tom === "perigo" ? "alerta" : atual.origem === "falha" ? "atualizar" : "saida"} tam={18} /></span>
            <div className="saida-estado__txt">
              <strong>{est.selo}</strong>
              <span>{est.linha}</span>
            </div>
          </div>
          <dl className="saida-meta">
            <dt>Para</dt><dd>{atual.para.join(", ") || "(ninguém)"}</dd>
            {atual.cc.length > 0 && <><dt>Cc</dt><dd>{atual.cc.join(", ")}</dd></>}
            {atual.cco.length > 0 && <><dt>Cco</dt><dd>{atual.cco.join(", ")}</dd></>}
            <dt>Criada</dt><dd>{dataLonga(atual.criadoEm)}</dd>
            {atual.tentativas > 0 && <><dt>Tentativas</dt><dd>{atual.tentativas}</dd></>}
          </dl>
          {atual.anexos.length > 0 && (
            <div className="anexos">
              {atual.anexos.map((a) => (
                <span key={a.nome} className="anexo anexo--estatico">
                  <span className="anexo__tipo">{(a.nome.split(".").pop() ?? "").slice(0, 4).toUpperCase()}</span>
                  <span className="anexo__txt"><span className="anexo__nome">{a.nome}</span><span className="anexo__tam">{tamanhoLegivel(a.tamanho)}</span></span>
                </span>
              ))}
            </div>
          )}
        </header>
        {erro && <div className="leitura__avisos"><p className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} />{erro}</p></div>}
        {!item && !erro && <EsqueletoLeitura />}
        {item && <iframe className="corpo-email corpo-email--papel saida-corpo" title="Conteúdo do envio" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={doc} />}
      </div>
      {uma ? (
        <Sheet aberto={menu === "reagendar"} onFechar={() => setMenu(null)} rotulo="Reagendar"><EscolhaHorario titulo="Reagendar para" rotuloAcao="Reagendar" onEscolher={(d) => void reagendar(d)} /></Sheet>
      ) : (
        <Popover aberto={menu === "reagendar"} onFechar={() => setMenu(null)} ancora={refReagendar} rotulo="Reagendar" largura={290} alinhar="fim">
          <EscolhaHorario titulo="Reagendar para" rotuloAcao="Reagendar" onEscolher={(d) => void reagendar(d)} />
        </Popover>
      )}
      {editando && item && <Editar caixa={caixa} item={item} onFechar={() => setEditando(false)} onSalvo={(i) => { setEditando(false); setItem(i); onMudou(i); mostrar("Alterações salvas", { icone: "ok" }); }} />}
      {confirmarReenvio && (
        <ConfirmDialog titulo="Reenviar mesmo assim?" rotuloConfirmar="Reenviar" perigo={false}
          texto="O envio foi interrompido no meio e a mensagem pode já ter saído. Confira em Enviados antes; reenviar pode duplicar a mensagem para os destinatários."
          onCancelar={() => setConfirmarReenvio(false)} onConfirmar={() => void reenviar(true)} />
      )}
      {cancelando && <ConfirmDialog titulo="Cancelar este envio?" rotuloConfirmar="Cancelar envio" texto="A mensagem e os anexos dela saem da Caixa de saída e não serão enviados." onCancelar={() => setCancelando(false)} onConfirmar={() => void cancelar()} />}
    </article>
  );
}

export default function Saida({ caixa }: { caixa: Caixa }) {
  const { layout, abrirGaveta, recarregarPastas } = useShell();
  const uma = layout === "uma";
  const [itens, setItens] = useState<ItemSaida[] | null>(null);
  const [erro, setErro] = useState("");
  const [aberto, setAberto] = useState<number | null>(null);
  const carregar = useCallback(async () => {
    try { const r = await api2.listarSaida(caixa.id); setItens(r); setErro(""); } catch (e) { setErro(erroMsg(e)); setItens((x) => x ?? []); }
  }, [caixa.id]);
  useEffect(() => { void carregar(); const t = setInterval(() => void carregar(), 30_000); return () => clearInterval(t); }, [carregar]);
  useEffect(() => { if (!uma && aberto === null && itens?.length) setAberto(itens[0].id); }, [itens, uma, aberto]);
  const sel = itens?.find((i) => i.id === aberto) ?? null;
  const falhas = itens?.filter((i) => i.estado === "falhou").length ?? 0;

  const lista = (
    <section className="coluna-lista" aria-label="Caixa de saída">
      <div className="coluna-lista__rolagem">
        <div className="lista__cab">
          <div className="lista__barra">
            {layout !== "tres" && <BotaoIcone icone={uma ? "menu" : "lateral"} rotulo="Mostrar pastas" tam={uma ? 22 : 18} onClick={abrirGaveta} />}
            <span className="barra-esp" />
            <BotaoIcone icone="atualizar" rotulo="Atualizar" onClick={() => void carregar()} />
          </div>
          <h1 className="lista__titulo">Caixa de saída</h1>
          <p className="lista__sub">{itens ? (itens.length ? `${itens.length} ${itens.length === 1 ? "envio" : "envios"} na fila${falhas ? ` · ${falhas} com falha` : ""}` : "") : ""}</p>
        </div>
        {erro && <div className="lista__avisos"><p className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} />{erro}</p></div>}
        {!itens && <EsqueletoLista n={4} />}
        {itens && itens.length === 0 && !erro && <Vazio icone="saida" titulo="Nada na fila" texto="Envios agendados e mensagens que aguardam nova tentativa aparecem aqui." />}
        {itens && itens.length > 0 && (
          <ul className="lista" aria-label="Envios">
            {itens.map((s) => {
              const e = estadoSaida(s);
              return (
                <li key={s.id} className="linha-env">
                  <button type="button" className={`linha linha--saida${!uma && aberto === s.id ? " linha--aberta" : ""}`} aria-current={aberto === s.id ? "true" : undefined} onClick={() => setAberto(s.id)}>
                    <span className={`saida-ic saida-ic--${e.tom}`}><Icone nome={e.tom === "perigo" ? "alerta" : s.origem === "falha" ? "atualizar" : "saida"} tam={17} /></span>
                    <span className="linha__corpo">
                      <span className="linha__l1"><span className="linha__de">{destinatarios(s)}</span><span className={`selo selo--${e.tom}`}>{e.selo}</span></span>
                      <span className="linha__l2"><span className="linha__assunto">{s.assunto || "(sem assunto)"}</span>{s.anexos.length > 0 && <span className="linha__ind"><Icone nome="clipe" tam={13} /></span>}</span>
                      <span className={`linha__previa${e.tom === "perigo" ? " txt-perigo" : ""}`}>{e.linha}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );

  const detalhe = sel ? (
    <Detalhe key={sel.id} caixa={caixa} resumo={sel} voltar={uma ? () => setAberto(null) : undefined}
      onMudou={(i) => setItens((xs) => (xs ?? []).map((x) => (x.id === i.id ? i : x)))}
      onSaiu={(sid) => { setItens((xs) => (xs ?? []).filter((x) => x.id !== sid)); setAberto(null); recarregarPastas(); }} />
  ) : (
    <div className="centro-vazio"><Vazio icone="saida" titulo="Nenhum envio selecionado" texto="Escolha um item para ver o estado, editar ou reenviar." /></div>
  );

  return (
    <div className="correio">
      {(!uma || !sel) && lista}
      {(!uma || sel) && <section className="coluna-leitura" aria-label="Detalhe">{detalhe}</section>}
    </div>
  );
}
