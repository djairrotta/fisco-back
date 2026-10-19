import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Avatar, BotaoIcone, Button, Icone, Menu, Popover, Portal, Segmented, Sheet, Toggle, useToast, usePresenca, type ItemMenu } from "../ui";
import { ApiError, api, ehPrecisaSenha, enviarComProgresso } from "../api";
import { api2, isoComFuso, type AnexoServidor, type ListaAssinaturas, type Ref } from "../api2";
import { useCaixa, useCaixas } from "../caixas";
import { gerarAssinatura } from "../assinatura";
import {
  adicionarAnexos, apagarRascunho, assuntoCom, completar, destinatariosResposta, enderecosVistos, gravarRascunho,
  LIMITE_ANEXOS, lerRascunho, montarPrevia, sugerir, totalBytes, type Modo, type Rascunho,
} from "../compor";
import { buscarDataUrl, dataLonga, erroMsg, tamanhoLegivel } from "../lib";
import { urlLogo } from "../marca";
import { documentoIframe, sanitizarEmail } from "../sanitizar";
import { useShell, type PedidoEscrever } from "../shell/contexto";
import type { Endereco, Mensagem, RespostaEnvio, ResultadoEnvio } from "../tipos";
import { BannerSenha } from "./Leitura";
import EscolhaHorario from "./Agendar";

const TITULO: Record<Modo, string> = { nova: "Nova mensagem", responder: "Responder", todos: "Responder a todos", encaminhar: "Encaminhar" };
const LIMITE_HTML = 512 * 1024;
/** Rascunho no servidor: 5 s depois da última mudança (§3 da API). */
export const ESPERA_RASCUNHO = 5000;
export const AVISO_FILA = "Sem conexão com o servidor — mensagem na Caixa de saída, reenvio automático";

const lista = (es: Endereco[]) => es.map((e) => e.endereco).join(", ");
const hora = (d: Date) => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function CampoEndereco({ rotulo, valor, onChange, vistos, fim, autoFocus }: {
  rotulo: string; valor: string; onChange: (v: string) => void; vistos: Endereco[]; fim?: React.ReactNode; autoFocus?: boolean;
}) {
  const [foco, setFoco] = useState(false);
  const sugestoes = foco ? sugerir(valor, vistos) : [];
  return (
    <div className="esc-campo">
      <label className="esc-campo__rot" htmlFor={`esc-${rotulo}`}>{rotulo}</label>
      <input id={`esc-${rotulo}`} className="esc-campo__in" type="text" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
        aria-label={rotulo} value={valor} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFoco(true)} onBlur={() => setTimeout(() => setFoco(false), 150)} />
      {fim}
      {sugestoes.length > 0 && (
        <ul className="sugestoes" role="listbox" aria-label={`Sugestões para ${rotulo}`}>
          {sugestoes.map((s) => (
            <li key={s.endereco}>
              <button type="button" role="option" aria-selected="false" onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(completar(valor, s.endereco))}>
                {s.nome ? <><strong>{s.nome}</strong><span>{s.endereco}</span></> : <strong>{s.endereco}</strong>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({ inicial, versao, onChange, visivel }: { inicial: string; versao: number; onChange: (html: string) => void; visivel: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // conteúdo inicial só quando muda a "versão" (restauração/preenchimento); rascunho vem de fora: sanitiza
  useEffect(() => { if (ref.current) ref.current.innerHTML = sanitizarEmail(inicial, { semEstilo: true }).html; }, [versao]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmd = (c: string, v?: string) => {
    ref.current?.focus();
    document.execCommand?.(c, false, v);
    onChange(ref.current?.innerHTML ?? "");
  };
  const link = () => {
    const u = window.prompt("Endereço do link (https://… ou mailto:)")?.trim();
    if (!u) return;
    if (!/^(https?:\/\/|mailto:)/i.test(u)) { window.alert("Use um link https://, http:// ou mailto:"); return; }
    cmd("createLink", u);
  };
  const b = (icone: Parameters<typeof BotaoIcone>[0]["icone"], rotulo: string, fn: () => void) => (
    <BotaoIcone icone={icone} rotulo={rotulo} tam={16} onMouseDown={(e) => e.preventDefault()} onClick={fn} />
  );
  return (
    <>
      <div className="esc-formato" role="toolbar" aria-label="Formatação">
        {b("negrito", "Negrito", () => cmd("bold"))}
        {b("italico", "Itálico", () => cmd("italic"))}
        {b("lista", "Lista", () => cmd("insertUnorderedList"))}
        {b("link", "Link", link)}
      </div>
      <div ref={ref} className="esc-editor" contentEditable suppressContentEditableWarning role="textbox" hidden={!visivel}
        aria-multiline="true" aria-label="Mensagem" data-vazio="Escreva sua mensagem"
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)} />
    </>
  );
}

export default function JanelaEscrever({ pedido, onFechar }: { pedido: PedidoEscrever; onFechar: () => void }) {
  const id = pedido.caixaId;
  const caixa = useCaixa(id);
  const { versao: versaoMarca } = useCaixas();
  const { layout, recarregarPastas } = useShell();
  const { mostrar } = useToast();
  const nav = useNavigate();
  const uma = layout === "uma";
  const deRascunho = !!pedido.rascunhoUid;

  // modo e original podem vir do pedido ou do rascunho reaberto
  const [modo, setModo] = useState<Modo>(pedido.modo);
  const [origem, setOrigem] = useState<Ref | null>(pedido.uid ? { pasta: pedido.pasta ?? "INBOX", uid: pedido.uid } : null);
  const temOriginal = modo !== "nova" && !!origem;
  const ref = temOriginal ? `${modo}:${origem!.pasta}:${origem!.uid}` : deRascunho ? `rascunho:${pedido.rascunhoUid}` : "nova";

  const [janela, setJanela] = useState<"normal" | "minimizada" | "cheia">("normal");
  const [aberto, setAberto] = useState(true);
  const { montado, ativo } = usePresenca(aberto, 240);
  const [aba, setAba] = useState<"escrever" | "previa">("escrever");
  const [original, setOriginal] = useState<Mensagem | null>(null);
  const [erroOriginal, setErroOriginal] = useState("");
  const [para, setPara] = useState("");
  const [cc, setCc] = useState("");
  const [cco, setCco] = useState("");
  const [mostrarCopias, setMostrarCopias] = useState(false);
  const [assunto, setAssunto] = useState("");
  const [html, setHtml] = useState("");
  const [versaoEditor, setVersaoEditor] = useState(0);
  const [incluirAssinatura, setIncluirAssinatura] = useState(true);
  const [anexos, setAnexos] = useState<File[]>([]);
  const [anexosServidor, setAnexosServidor] = useState<AnexoServidor[]>([]);
  const [erroAnexo, setErroAnexo] = useState("");
  const [pronto, setPronto] = useState(false);
  const [outroRascunho, setOutroRascunho] = useState<Rascunho | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [progresso, setProgresso] = useState(0);
  const [erro, setErro] = useState("");
  const [senhaRecusada, setSenhaRecusada] = useState(false);
  const [resultado, setResultado] = useState<ResultadoEnvio | null>(null);
  const [salvoEm, setSalvoEm] = useState<Date | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [mudou, setMudou] = useState(0);
  const uidServidor = useRef<number | null>(pedido.rascunhoUid ?? null);
  const vistos = useMemo(() => enderecosVistos(), []);
  const inputArq = useRef<HTMLInputElement>(null);
  const refMaisTarde = useRef<HTMLButtonElement>(null);
  const refAss = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"tarde" | "ass" | null>(null);

  // assinaturas 2.0 (null = caixa sem estúdio; usa os campos 1.0)
  const [lista2, setLista2] = useState<ListaAssinaturas | null>(null);
  const [escolha, setEscolha] = useState<number | "nenhuma" | null>(null);
  const [previaAss, setPreviaAss] = useState("");

  const fechar = useCallback((avisar = true) => {
    setAberto(false);
    setTimeout(onFechar, 240);
    if (avisar && !resultado && (uidServidor.current || para || assunto || html)) mostrar("Rascunho guardado em Rascunhos", { icone: "rascunhos" });
  }, [onFechar, resultado, para, assunto, html, mostrar]);

  // 0) rascunho do servidor
  useEffect(() => {
    if (!caixa || !pedido.rascunhoUid) return;
    let vivo = true;
    api2.lerRascunho(id, pedido.rascunhoUid).then((r) => {
      if (!vivo) return;
      setPara(lista(r.para)); setCc(lista(r.cc)); setCco(lista(r.cco)); setMostrarCopias(!!(r.cc.length || r.cco.length));
      setAssunto(r.assunto); setHtml(r.html ?? (r.texto ? `<p>${r.texto.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>` : ""));
      setIncluirAssinatura(r.incluirAssinatura);
      if (r.assinaturaId !== undefined) setEscolha(r.assinaturaId === null ? "nenhuma" : r.assinaturaId);
      setAnexosServidor(r.anexos.filter((a) => !a.cid));
      if (r.respondendoA) { setModo("responder"); setOrigem(r.respondendoA); }
      else if (r.encaminhando) { setModo("encaminhar"); setOrigem(r.encaminhando); }
      setSalvoEm(r.data ? new Date(r.data) : null);
      setVersaoEditor((v) => v + 1);
      setPronto(true);
    }).catch((e) => { if (vivo) { setErro(`Não foi possível abrir o rascunho: ${erroMsg(e)}`); setPronto(true); } });
    return () => { vivo = false; };
  }, [caixa?.id, pedido.rascunhoUid]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1) original (resposta/encaminhamento): preenche destinatários e a nota de citação
  useEffect(() => {
    if (!caixa || !temOriginal) { setOriginal(null); return; }
    let vivo = true;
    api.get<{ mensagem: Mensagem }>(`/api/caixas/${id}/mensagens/${origem!.uid}?pasta=${encodeURIComponent(origem!.pasta)}`)
      .then((r) => { if (vivo) setOriginal(r.mensagem); })
      .catch((e) => { if (vivo) setErroOriginal(erroMsg(e)); });
    return () => { vivo = false; };
  }, [caixa?.id, temOriginal, origem?.uid, origem?.pasta, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2) estado inicial (novo/resposta): cópia local desta mesma mensagem, senão o preenchimento
  useEffect(() => {
    if (!caixa || pronto || deRascunho) return;
    if (temOriginal && !original && !erroOriginal) return;
    const r = lerRascunho(id);
    if (r && r.ref === ref) {
      setPara(r.para); setCc(r.cc); setCco(r.cco); setAssunto(r.assunto); setHtml(r.html);
      setIncluirAssinatura(r.incluirAssinatura); setMostrarCopias(!!(r.cc || r.cco));
    } else {
      if (r && (r.para || r.assunto || r.html)) setOutroRascunho(r);
      if (original) {
        const d = destinatariosResposta(original, modo, caixa.endereco);
        setPara(d.para); setCc(d.cc); setMostrarCopias(!!d.cc);
        setAssunto(assuntoCom(modo, original.assunto));
      }
    }
    setVersaoEditor((v) => v + 1);
    setPronto(true);
  }, [caixa, original, erroOriginal, pronto, temOriginal, ref, id, modo, deRascunho]);

  // assinaturas do estúdio
  useEffect(() => {
    if (!caixa) return;
    let vivo = true;
    api2.listarAssinaturas(id).then((l) => { if (vivo) setLista2(l.assinaturas.length ? l : null); }).catch(() => { if (vivo) setLista2(null); });
    return () => { vivo = false; };
  }, [caixa?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const padrao = lista2 ? (modo === "nova" ? lista2.padroes.nova : lista2.padroes.resposta) : null;
  const assEfetiva: number | "nenhuma" | null = !incluirAssinatura ? "nenhuma" : escolha ?? padrao ?? (lista2 ? "nenhuma" : null);
  const assObj = lista2 && typeof assEfetiva === "number" ? lista2.assinaturas.find((a) => a.id === assEfetiva) ?? null : null;
  useEffect(() => {
    if (!assObj) { setPreviaAss(""); return; }
    let vivo = true;
    api2.previaAssinatura(id, { modelo: assObj.modelo, campos: assObj.campos, assinaturaId: assObj.id })
      .then((r) => { if (vivo) setPreviaAss(r.html); }).catch(() => { if (vivo) setPreviaAss(""); });
    return () => { vivo = false; };
  }, [assObj?.id, assObj?.atualizadoEm, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3a) cópia local a cada pausa (sobrevive a fechar o app sem rede)
  useEffect(() => {
    if (!pronto || resultado || deRascunho) return;
    const t = setTimeout(() => {
      if (!para && !cc && !cco && !assunto && !html && ref === "nova") return;
      gravarRascunho(id, { ref, para, cc, cco, assunto, html, incluirAssinatura, salvoEm: Date.now() });
    }, 400);
    return () => clearTimeout(t);
  }, [pronto, resultado, id, ref, para, cc, cco, assunto, html, incluirAssinatura, deRascunho]);

  // 3b) rascunho no servidor, 5 s depois da última mudança
  const primeira = useRef(true);
  useEffect(() => {
    if (!pronto) return;
    if (primeira.current) { primeira.current = false; return; }
    setMudou((n) => n + 1);
  }, [pronto, para, cc, cco, assunto, html, incluirAssinatura, escolha, anexos.length, anexosServidor.length]);
  // Um salvamento por vez: mudanças feitas durante um salvamento viram UM salvamento seguinte.
  // Ao enviar (ou descartar) `encerrado` corta tudo: nada é salvo depois que o envio começou.
  const emVoo = useRef<Promise<void> | null>(null);
  const deNovo = useRef(false);
  const encerrado = useRef(false);
  /** UIDs antigos que o servidor não confirmou ter substituído: apagar no próximo salvamento. */
  const sobras = useRef<number[]>([]);
  const anexosRef = useRef(anexos);
  anexosRef.current = anexos;
  const anexosServRef = useRef(anexosServidor);
  anexosServRef.current = anexosServidor;

  const limparSobras = useCallback(async () => {
    for (const uid of [...sobras.current]) {
      try { await api2.apagarRascunho(id, uid); sobras.current = sobras.current.filter((x) => x !== uid); }
      catch (e) { if (e instanceof ApiError && e.status === 404) sobras.current = sobras.current.filter((x) => x !== uid); }
    }
  }, [id]);

  const salvarServidor = useCallback(async () => {
    if (!caixa || resultado || encerrado.current) return;
    const novos = anexosRef.current;
    const doServidor = anexosServRef.current;
    if (!uidServidor.current && !para && !cc && !cco && !assunto && !html && !novos.length) return;
    setSalvando(true);
    try {
      await limparSobras();
      const anterior = uidServidor.current;
      const r = await api2.salvarRascunho(id, {
        para, cc, cco, assunto, html, incluirAssinatura,
        assinaturaId: lista2 ? assEfetiva : undefined,
        substituiUid: anterior, anexosRascunho: doServidor.map((a) => a.parte),
        respondendoA: temOriginal && modo !== "encaminhar" ? origem : null,
        encaminhando: temOriginal && modo === "encaminhar" ? origem : null,
        files: novos,
      });
      if (anterior && r.substituido === false && anterior !== r.uid) sobras.current.push(anterior);
      uidServidor.current = r.uid;
      setSalvoEm(new Date());
      // arquivos enviados agora viram anexos do servidor (não sobem de novo a cada 5 s)
      if (novos.length && r.uid) {
        const lido = await api2.lerRascunho(id, r.uid);
        const serv = lido.anexos.filter((a) => !a.cid);
        anexosServRef.current = serv;
        anexosRef.current = anexosRef.current.filter((x) => !novos.includes(x));
        setAnexosServidor(serv);
        setAnexos((xs) => xs.filter((x) => !novos.includes(x)));
      }
    } catch { /* tenta de novo na próxima mudança; a cópia local continua */ } finally { setSalvando(false); }
  }, [caixa, resultado, para, cc, cco, assunto, html, incluirAssinatura, lista2, assEfetiva, temOriginal, modo, origem, id, limparSobras]);
  const salvarRef = useRef(salvarServidor);
  salvarRef.current = salvarServidor;

  const salvarAgora = useCallback((): Promise<void> => {
    if (encerrado.current) return Promise.resolve();
    if (emVoo.current) { deNovo.current = true; return emVoo.current; }
    const p = (async () => {
      try {
        do { deNovo.current = false; await salvarRef.current(); } while (deNovo.current && !encerrado.current);
      } finally { emVoo.current = null; }
    })();
    emVoo.current = p;
    return p;
  }, []);
  useEffect(() => {
    if (!mudou) return;
    const t = setTimeout(() => void salvarAgora(), ESPERA_RASCUNHO);
    return () => clearTimeout(t);
  }, [mudou, salvarAgora]);

  // logo da assinatura 1.0 como data: URL (a prévia roda no iframe sandbox)
  const [logoDados, setLogoDados] = useState<string | null>(null);
  const urlDoLogo = caixa && !lista2 ? urlLogo(caixa, versaoMarca) : null;
  useEffect(() => {
    setLogoDados(null);
    if (!urlDoLogo) return;
    let vivo = true;
    void buscarDataUrl(urlDoLogo, undefined, 1024 * 1024).then((u) => { if (vivo) setLogoDados(u); });
    return () => { vivo = false; };
  }, [urlDoLogo]);
  const assinatura1 = useMemo(() => (caixa && !lista2 ? gerarAssinatura(caixa.assinatura ?? {}, { logoUrl: logoDados }).html : ""), [caixa, logoDados, lista2]);
  const assinaturaHtml = lista2 ? previaAss : assinatura1;
  // prévia do que será enviado: corpo + assinatura (a citação é anexada pelo servidor e não aparece aqui)
  const previa = useMemo(
    () => documentoIframe(montarPrevia({ corpo: sanitizarEmail(html).html, assinatura: assinaturaHtml, incluirAssinatura: assEfetiva !== "nenhuma" && incluirAssinatura, citacao: "" }), false, { margem: "18px 20px" }),
    [html, assinaturaHtml, incluirAssinatura, assEfetiva],
  );

  // Shift+Cmd+D (ou Shift+Ctrl+D) envia
  const enviarRef = useRef<(quando?: Date) => Promise<void>>(async () => {});
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") { e.preventDefault(); void enviarRef.current(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!caixa || !montado) return null;

  function escolher(l: FileList | null) {
    if (!l?.length) return;
    const atuais = [...anexos, ...anexosServidor.map((a) => ({ size: a.tamanho }) as File)];
    const r = adicionarAnexos(atuais, Array.from(l));
    if (r.erro) setErroAnexo(r.erro);
    else { setAnexos([...anexos, ...Array.from(l)]); setErroAnexo(""); }
    if (inputArq.current) inputArq.current.value = "";
  }

  async function enviar(quando?: Date) {
    if (enviando) return;
    setErro(""); setSenhaRecusada(false); setMenu(null);
    if (![para, cc, cco].some((x) => x.trim())) { setErro("Informe ao menos um destinatário."); return; }
    if (new Blob([html]).size > LIMITE_HTML) { setErro("O texto passa do limite de 512 KB."); return; }
    if (totalBytes(anexos) + anexosServidor.reduce((s, a) => s + a.tamanho, 0) > LIMITE_ANEXOS) { setErro("Os anexos passam do limite de 25 MB por mensagem."); return; }
    // nenhum salvamento depois daqui; espera o que estiver em voo para usar o uid mais novo
    encerrado.current = true;
    setEnviando(true); setProgresso(0);
    try { await emVoo.current; } catch { /* segue */ }
    const locais = anexosRef.current;
    const doServidor = anexosServRef.current;
    const f = new FormData();
    f.set("para", para); f.set("cc", cc); f.set("cco", cco);
    f.set("assunto", assunto);
    // só o corpo: citação e assinatura são montadas no servidor
    f.set("html", html);
    f.set("incluirAssinatura", incluirAssinatura && assEfetiva !== "nenhuma" ? "true" : "false");
    if (lista2 && assEfetiva !== null) f.set("assinaturaId", String(assEfetiva));
    if (temOriginal) f.set(modo === "encaminhar" ? "encaminhando" : "respondendoA", JSON.stringify(origem));
    if (uidServidor.current) {
      f.set("rascunhoUid", String(uidServidor.current));
      if (doServidor.length) f.set("anexosRascunho", JSON.stringify(doServidor.map((a) => a.parte)));
    }
    if (quando) f.set("agendarPara", isoComFuso(quando));
    for (const a of locais) f.append("files", a, a.name);
    try {
      const r = await enviarComProgresso<RespostaEnvio>(`/api/caixas/${id}/enviar`, f, setProgresso);
      apagarRascunho(id);
      void limparSobras();
      recarregarPastas();
      if ("enfileirado" in r) { mostrar(AVISO_FILA, { icone: "saida", acao: { rotulo: "Ver", fn: () => nav(`/c/${id}?pasta=__saida`) } }); fechar(false); return; }
      if ("agendado" in r) { mostrar(`Agendada para ${dataLonga(r.saida.agendarPara ?? isoComFuso(quando!))}`, { icone: "calendario", acao: { rotulo: "Ver", fn: () => nav(`/c/${id}?pasta=__saida`) } }); fechar(false); return; }
      setResultado(r);
    } catch (e) {
      encerrado.current = false; // não foi: o autosave volta a valer
      // 500 não entra na Caixa de saída: deixa claro que nada foi enviado nem ficou na fila
      setErro(e instanceof ApiError && e.status === 500 ? `${erroMsg(e)} no servidor: a mensagem não foi enviada nem ficou na Caixa de saída. O rascunho foi mantido.` : erroMsg(e));
      setSenhaRecusada(ehPrecisaSenha(e));
    } finally {
      setEnviando(false);
    }
  }
  enviarRef.current = enviar;

  async function descartar() {
    encerrado.current = true;
    try { await emVoo.current; } catch { /* segue */ }
    await limparSobras();
    const uid = uidServidor.current;
    apagarRascunho(id);
    if (uid) { try { await api2.apagarRascunho(id, uid); recarregarPastas(); } catch { /* já não existe */ } }
    mostrar("Rascunho descartado", { icone: "lixeira" });
    fechar(false);
  }

  const total = totalBytes(anexos) + anexosServidor.reduce((s, a) => s + a.tamanho, 0);
  const titulo = assunto.trim() || TITULO[modo];
  const estado = uma ? "movel" : janela;
  const botaoEnviar = (
    <div className="enviar-grupo">
      <Button variante="liquido" tam={uma ? "p" : "m"} icone={uma ? undefined : "enviados"} onClick={() => void enviar()} disabled={enviando || !pronto}
        title="Enviar (⇧⌘D)" className="enviar-grupo__principal">
        {enviando ? `Enviando… ${Math.round(progresso * 100)}%` : "Enviar"}
      </Button>
      <Button ref={refMaisTarde} variante="liquido" tam={uma ? "p" : "m"} icone="abaixo" aria-label="Enviar mais tarde" title="Enviar mais tarde"
        className="enviar-grupo__mais" disabled={enviando || !pronto} onClick={() => setMenu(menu === "tarde" ? null : "tarde")} />
    </div>
  );
  const nomeAss = assEfetiva === "nenhuma" ? "Sem assinatura" : assObj?.nome ?? "Assinatura";
  const itensAss: ItemMenu[] = lista2 ? [
    ...lista2.assinaturas.map((a) => ({
      rotulo: a.nome, marcado: assEfetiva === a.id, nota: a.id === padrao ? "padrão" : undefined,
      onClick: () => { setEscolha(a.id); setIncluirAssinatura(true); },
    })),
    { rotulo: "Sem assinatura", marcado: assEfetiva === "nenhuma", onClick: () => { setEscolha("nenhuma"); } },
  ] : [];
  const agendar = <EscolhaHorario titulo="Enviar mais tarde" rotuloAcao="Agendar" onEscolher={(d) => void enviar(d)} />;

  return (
    <Portal>
      {(uma || janela === "cheia") && <div className={`escrever-fundo${ativo ? " escrever-fundo--ativo" : ""}`} onClick={uma ? undefined : () => setJanela("normal")} aria-hidden="true" />}
      <div className={`escrever escrever--${estado}${ativo ? " escrever--ativo" : ""}`} role="dialog" aria-label={TITULO[modo]}
        aria-modal={uma || janela === "cheia" ? true : undefined}>
        <header className="escrever__cab" onDoubleClick={uma ? undefined : () => setJanela(janela === "minimizada" ? "normal" : "minimizada")}>
          {uma ? (
            <>
              <button type="button" className="txt-btn" onClick={() => fechar()}>{resultado ? "Fechar" : "Cancelar"}</button>
              <span className="escrever__titulo">{resultado ? "" : TITULO[modo]}</span>
              {resultado ? <span /> : botaoEnviar}
            </>
          ) : (
            <>
              <span className="escrever__titulo">{janela === "minimizada" ? titulo : TITULO[modo]}</span>
              <div className="escrever__janela">
                <BotaoIcone icone="minimizar" rotulo={janela === "minimizada" ? "Restaurar" : "Minimizar"} tam={15} onClick={() => setJanela(janela === "minimizada" ? "normal" : "minimizada")} />
                <BotaoIcone icone={janela === "cheia" ? "restaurar" : "maximizar"} rotulo={janela === "cheia" ? "Janela" : "Tela cheia"} tam={14} onClick={() => setJanela(janela === "cheia" ? "normal" : "cheia")} />
                <BotaoIcone icone="fechar" rotulo="Fechar" tam={16} onClick={() => fechar()} />
              </div>
            </>
          )}
        </header>

        {janela !== "minimizada" && resultado && (
          <div className="escrever__fim">
            <span className="escrever__fim-ic"><Icone nome="ok" tam={26} /></span>
            <h2 className="escrever__fim-titulo">Mensagem enviada</h2>
            {resultado.aviso && <p className="txt-aviso" role="status">{resultado.aviso}</p>}
            {!!resultado.rejeitados?.length && (
              <div className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} /><span>Recusados pelo servidor: {resultado.rejeitados.join(", ")}</span></div>
            )}
            <div className="escrever__fim-acoes">
              {resultado.enviados?.uid ? (
                <Button variante="cinza" onClick={() => { fechar(false); nav(`/c/${id}/m/${encodeURIComponent(resultado.enviados!.pasta)}/${resultado.enviados!.uid}`); }}>Ver em Enviados</Button>
              ) : null}
              <Button variante="liquido" onClick={() => fechar(false)}>Voltar à caixa</Button>
            </div>
          </div>
        )}

        {janela !== "minimizada" && !resultado && (
          <>
            <div className="escrever__rolagem">
              {senhaRecusada && <div className="escrever__avisos"><BannerSenha caixa={caixa} /></div>}
              {erroOriginal && <div className="escrever__avisos"><p className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} />Não foi possível carregar a mensagem original: {erroOriginal}</p></div>}
              {outroRascunho && (
                <div className="escrever__avisos">
                  <div className="aviso">
                    <Icone nome="rascunhos" tam={16} />
                    <span>Há um rascunho de outra mensagem neste aparelho; ele será substituído se você escrever aqui.</span>
                    <button type="button" className="aviso__acao" onClick={() => {
                      const r = outroRascunho;
                      const [m, ...resto] = r.ref.split(":");
                      const uid = Number(resto.pop());
                      setOutroRascunho(null);
                      onFechar();
                      setTimeout(() => nav(r.ref === "nova" ? `/c/${id}/escrever` : `/c/${id}/escrever?modo=${m}&pasta=${encodeURIComponent(resto.join(":"))}&uid=${uid}`), 0);
                    }}>Abrir rascunho</button>
                  </div>
                </div>
              )}
              <div className="esc-campos">
                <div className="esc-campo esc-campo--de">
                  <span className="esc-campo__rot">De</span>
                  <span className="esc-de"><Avatar caixa={caixa} tam={20} versao={versaoMarca} /><span>{caixa.endereco}</span></span>
                </div>
                <CampoEndereco rotulo="Para" valor={para} onChange={setPara} vistos={vistos} autoFocus={!temOriginal && !uma && !deRascunho}
                  fim={!mostrarCopias ? <button type="button" className="esc-copias" onClick={() => setMostrarCopias(true)}>Cc/Cco</button> : undefined} />
                {mostrarCopias && (
                  <>
                    <CampoEndereco rotulo="Cc" valor={cc} onChange={setCc} vistos={vistos} />
                    <CampoEndereco rotulo="Cco" valor={cco} onChange={setCco} vistos={vistos} />
                  </>
                )}
                <div className="esc-campo">
                  <label className="esc-campo__rot" htmlFor="esc-assunto">Assunto</label>
                  <input id="esc-assunto" className="esc-campo__in esc-campo__in--assunto" aria-label="Assunto" value={assunto} maxLength={998}
                    onChange={(e) => setAssunto(e.target.value)} />
                </div>
              </div>
              <div className="esc-barra">
                <Editor inicial={html} versao={versaoEditor} onChange={setHtml} visivel={aba === "escrever"} />
                <span className="barra-esp" />
                <Segmented rotulo="Modo de visualização" className="seg--p" valor={aba} onChange={setAba}
                  opcoes={[{ valor: "escrever", rotulo: "Escrever" }, { valor: "previa", rotulo: "Prévia" }]} />
              </div>
              {/* mesma caixa de areia do leitor: HTML de fora nunca entra no DOM do app */}
              <iframe className="esc-previa" title="Prévia da mensagem" hidden={aba !== "previa"}
                sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={previa} />
              {temOriginal && (
                <p className="esc-citacao" role="note">
                  <Icone nome={modo === "encaminhar" ? "encaminhar" : "responder"} tam={14} />
                  {modo === "encaminhar" ? "A mensagem encaminhada" : "A citação"}{original ? ` de ${original.de?.nome || original.de?.endereco}` : ""} vai abaixo da assinatura, montada no envio.
                </p>
              )}
              {(anexos.length > 0 || anexosServidor.length > 0 || erroAnexo || (modo === "encaminhar" && !!original?.anexos.length)) && (
                <div className="esc-anexos">
                  {anexosServidor.map((a) => (
                    <span key={`s${a.parte}`} className="esc-anexo">
                      <Icone nome="clipe" tam={13} />
                      <span className="esc-anexo__nome">{a.nome ?? `anexo ${a.parte}`}</span>
                      <span className="esc-anexo__tam">{tamanhoLegivel(a.tamanho)}</span>
                      <button type="button" aria-label={`Remover ${a.nome ?? a.parte}`} onClick={() => setAnexosServidor(anexosServidor.filter((x) => x.parte !== a.parte))}><Icone nome="fechar" tam={13} /></button>
                    </span>
                  ))}
                  {anexos.map((a, i) => (
                    <span key={`${a.name}-${i}`} className="esc-anexo">
                      <Icone nome="clipe" tam={13} />
                      <span className="esc-anexo__nome">{a.name}</span>
                      <span className="esc-anexo__tam">{tamanhoLegivel(a.size)}</span>
                      <button type="button" aria-label={`Remover ${a.name}`} onClick={() => { setAnexos(anexos.filter((_, j) => j !== i)); setErroAnexo(""); }}>
                        <Icone nome="fechar" tam={13} />
                      </button>
                    </span>
                  ))}
                  {modo === "encaminhar" && original && original.anexos.length > 0 && (
                    <span className="esc-nota">Os {original.anexos.length} anexo(s) da mensagem original vão junto.</span>
                  )}
                  {erroAnexo && <p className="txt-perigo" role="alert">{erroAnexo}</p>}
                </div>
              )}
            </div>

            {enviando && (
              <div className="progresso" role="progressbar" aria-label="Enviando" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progresso * 100)}>
                <div className="progresso__barra" style={{ width: `${Math.round(progresso * 100)}%` }} />
              </div>
            )}
            {erro && <p className="escrever__erro" role="alert"><Icone nome="alerta" tam={15} />{erro}</p>}
            <footer className="escrever__rodape">
              <BotaoIcone icone="clipe" rotulo="Anexar arquivos" onClick={() => inputArq.current?.click()} />
              <input ref={inputArq} type="file" multiple hidden aria-label="Escolher anexos" onChange={(e) => escolher(e.target.files)} />
              {lista2 ? (
                <button ref={refAss} type="button" className="esc-ass-sel" aria-label={`Assinatura: ${nomeAss}`} aria-haspopup="menu" onClick={() => setMenu(menu === "ass" ? null : "ass")}>
                  <Icone nome="assinatura" tam={15} /><span>{nomeAss}</span><Icone nome="abaixo" tam={13} />
                </button>
              ) : (
                <label className="esc-ass">
                  <Toggle rotulo="Incluir assinatura" ligado={incluirAssinatura} onChange={setIncluirAssinatura} />
                  <span>Assinatura</span>
                </label>
              )}
              {!lista2 && !assinatura1 && <Link className="esc-nota" to={`/c/${id}/assinaturas`} onClick={() => fechar()}>Criar assinatura</Link>}
              <span className="esc-status" aria-live="polite">
                {total > 0 && <span className={total > LIMITE_ANEXOS * 0.9 ? "txt-aviso" : ""}>{tamanhoLegivel(total)} de 25 MB</span>}
                {total > 0 && (salvoEm || salvando) && " · "}
                {salvando ? "Salvando…" : salvoEm ? `Rascunho salvo às ${hora(salvoEm)}` : ""}
              </span>
              <span className="barra-esp" />
              {(uidServidor.current || deRascunho) && <BotaoIcone icone="lixeira" rotulo="Descartar rascunho" onClick={() => void descartar()} />}
              {!uma && botaoEnviar}
            </footer>
          </>
        )}
      </div>
      {uma ? (
        <>
          <Sheet aberto={menu === "tarde"} onFechar={() => setMenu(null)} rotulo="Enviar mais tarde">{agendar}</Sheet>
          <Sheet aberto={menu === "ass"} onFechar={() => setMenu(null)} rotulo="Assinatura" titulo="Assinatura"><Menu rotulo="Assinaturas" itens={itensAss} onEscolher={() => setMenu(null)} /></Sheet>
        </>
      ) : (
        <>
          <Popover aberto={menu === "tarde"} onFechar={() => setMenu(null)} ancora={refMaisTarde} rotulo="Enviar mais tarde" alinhar="fim" largura={290}>{agendar}</Popover>
          <Popover aberto={menu === "ass"} onFechar={() => setMenu(null)} ancora={refAss} rotulo="Assinatura" largura={250}>
            <Menu rotulo="Assinaturas" itens={itensAss} onEscolher={() => setMenu(null)} />
          </Popover>
        </>
      )}
    </Portal>
  );
}
