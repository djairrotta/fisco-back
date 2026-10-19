import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BotaoIcone, Button, ConfirmDialog, EsqueletoLista, Icone, Menu, Popover, Sheet, Vazio, type ItemMenu } from "../ui";
import { api, ehPrecisaSenha } from "../api";
import { api2, type AcaoLote, type FiltrosBusca } from "../api2";
import { useCaixa, useCaixas } from "../caixas";
import { lembrarEnderecos } from "../compor";
import { erroMsg } from "../lib";
import { nomeCaixa } from "../marca";
import { useAcoes } from "../acoes";
import { FAVORITOS, SAIDA, useShell } from "../shell/contexto";
import { useAtalhos, type AcaoAtalho } from "../shell/atalhos";
import { ESPECIAIS } from "../shell/BarraLateral";
import type { ItemLista, PaginaMensagens } from "../tipos";
import LinhaMensagem, { type AcaoLinha } from "./LinhaMensagem";
import Leitura, { BannerSenha } from "./Leitura";
import Saida from "./Saida";

type Item = ItemLista & { pasta?: string };
const COR = { arquivar: "#8a63d2", excluir: "#e5483e", lida: "#2f80ed", estrela: "#f0a020" };

/** Lê "m/<pasta>/<uid>" do resto da rota (a pasta pode conter "/"). */
export function lerResto(resto: string): { pasta: string; uid: number } | "escrever" | null {
  const p = resto.split("/").filter(Boolean);
  if (p[0] === "escrever") return "escrever";
  if (p[0] === "m" && p.length >= 3) {
    const uid = Number(p[p.length - 1]);
    if (Number.isInteger(uid) && uid > 0) return { pasta: p.slice(1, -1).join("/"), uid };
  }
  return null;
}

export interface Filtros { de: string; para: string; assunto: string; temAnexo: boolean; naoLidas: boolean; desde: string; ate: string; todas: boolean }
export const FILTROS_VAZIOS: Filtros = { de: "", para: "", assunto: "", temAnexo: false, naoLidas: false, desde: "", ate: "", todas: false };

/** Busca avançada (rota /busca) quando há filtro ou "todas as pastas"; texto puro na pasta usa a busca 1.0 paginada. */
export function pedidoBusca(texto: string, f: Filtros, pasta: string): FiltrosBusca | null {
  const algum = f.de || f.para || f.assunto || f.temAnexo || f.naoLidas || f.desde || f.ate || f.todas;
  if (!algum) return null;
  return {
    ...(f.todas ? { todas: true } : { pasta }), texto: texto || undefined, de: f.de || undefined, para: f.para || undefined,
    assunto: f.assunto || undefined, temAnexo: f.temAnexo || undefined, naoLidas: f.naoLidas || undefined,
    desde: f.desde || undefined, ate: f.ate || undefined,
  };
}

function rotulosFiltros(f: Filtros): { chave: keyof Filtros; rotulo: string }[] {
  const r: { chave: keyof Filtros; rotulo: string }[] = [];
  if (f.todas) r.push({ chave: "todas", rotulo: "Todas as pastas" });
  if (f.de) r.push({ chave: "de", rotulo: `De: ${f.de}` });
  if (f.para) r.push({ chave: "para", rotulo: `Para: ${f.para}` });
  if (f.assunto) r.push({ chave: "assunto", rotulo: `Assunto: ${f.assunto}` });
  if (f.temAnexo) r.push({ chave: "temAnexo", rotulo: "Com anexo" });
  if (f.naoLidas) r.push({ chave: "naoLidas", rotulo: "Não lidas" });
  const br = (d: string) => d.split("-").reverse().join("/");
  if (f.desde || f.ate) r.push({ chave: "desde", rotulo: f.desde && f.ate ? `${br(f.desde)} a ${br(f.ate)}` : f.desde ? `Desde ${br(f.desde)}` : `Até ${br(f.ate)}` });
  return r;
}

/** Formulário de filtros (popover no Mac, folha no iPhone). */
function FormFiltros({ valor, onAplicar, onLimpar }: { valor: Filtros; onAplicar: (f: Filtros) => void; onLimpar: () => void }) {
  const [f, setF] = useState(valor);
  const campo = (k: "de" | "para" | "assunto", rotulo: string, ph: string) => (
    <label className="filtro-campo">
      <span>{rotulo}</span>
      <input className="campo" value={f[k]} placeholder={ph} aria-label={rotulo} onChange={(e) => setF({ ...f, [k]: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter") onAplicar(f); }} />
    </label>
  );
  const marca = (k: "temAnexo" | "naoLidas" | "todas", rotulo: string, icone: Parameters<typeof Icone>[0]["nome"]) => (
    <button type="button" className={`chip${f[k] ? " chip--on" : ""}`} aria-pressed={f[k]} onClick={() => setF({ ...f, [k]: !f[k] })}>
      <Icone nome={icone} tam={13} />{rotulo}
    </button>
  );
  return (
    <form className="filtros-form" aria-label="Filtros da busca" onSubmit={(e) => { e.preventDefault(); onAplicar(f); }}>
      {campo("de", "De", "nome ou endereço")}
      {campo("para", "Para", "nome ou endereço")}
      {campo("assunto", "Assunto", "palavras do assunto")}
      <div className="filtro-campo">
        <span>Período</span>
        <span className="filtro-datas">
          <input className="campo" type="date" aria-label="Desde" value={f.desde} max={f.ate || undefined} onChange={(e) => setF({ ...f, desde: e.target.value })} />
          <span className="filtro-datas__a">a</span>
          <input className="campo" type="date" aria-label="Até" value={f.ate} min={f.desde || undefined} onChange={(e) => setF({ ...f, ate: e.target.value })} />
        </span>
      </div>
      <div className="filtro-chips">
        {marca("temAnexo", "Com anexo", "clipe")}
        {marca("naoLidas", "Não lidas", "naoLida")}
        {marca("todas", "Todas as pastas", "caixas")}
      </div>
      <div className="filtros-form__acoes">
        <Button variante="simples" tam="p" onClick={() => { setF(FILTROS_VAZIOS); onLimpar(); }}>Limpar</Button>
        <Button type="submit" variante="liquido" tam="p">Buscar</Button>
      </div>
    </form>
  );
}

export default function Correio() {
  const ps = useParams();
  const id = Number(ps.id);
  const rota = lerResto(ps["*"] ?? "");
  const aberta = rota && rota !== "escrever" ? rota : null;
  const caixa = useCaixa(id);
  const { caixas } = useCaixas();
  const { layout, escrever, abrirGaveta, pastas } = useShell();
  const acoes = useAcoes(caixa?.id ?? null);
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const pasta = params.get("pasta") ?? aberta?.pasta ?? "INBOX";
  const favoritos = pasta === FAVORITOS;
  const virtual = favoritos || pasta === SAIDA;
  const tipoPasta = acoes.tipoDe(pasta);
  const ehRascunhos = tipoPasta === "rascunhos";
  const uma = layout === "uma";

  // ----------------------------------------------------------- busca
  const buscaRef = useRef<HTMLInputElement>(null);
  const filtroRef = useRef<HTMLButtonElement>(null);
  const [busca, setBusca] = useState(params.get("busca") ?? "");
  const [termo, setTermo] = useState(busca.trim());
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VAZIOS);
  const [painelFiltros, setPainelFiltros] = useState(false);
  const pedido = pedidoBusca(termo, filtros, pasta);
  const chavePedido = JSON.stringify(pedido);
  const ativos = rotulosFiltros(filtros);
  useEffect(() => { const t = setTimeout(() => setTermo(busca.trim()), 350); return () => clearTimeout(t); }, [busca]);
  useEffect(() => { if (params.has("buscar")) buscaRef.current?.focus(); }, [params]);
  useEffect(() => { setFiltros(FILTROS_VAZIOS); setBusca(""); }, [id]);

  // ----------------------------------------------------------- lista
  const [itens, setItens] = useState<Item[]>([]);
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState(0);
  const [limitado, setLimitado] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [senhaRecusada, setSenhaRecusada] = useState(false);
  const seq = useRef(0);

  const carregar = useCallback(async (pag: number) => {
    if (pasta === SAIDA) return;
    const n = ++seq.current;
    setCarregando(true);
    setErro("");
    const vale = () => n === seq.current;
    try {
      let lista: Item[]; let tot: number; let lim = false;
      const pb = pedidoBusca(termo, filtros, pasta);
      if (favoritos) {
        const r = await api2.listarFavoritos(id);
        lista = r.mensagens; tot = r.mensagens.length; lim = r.limitado;
      } else if (pb) {
        const r = await api2.buscar(id, pb);
        lista = r.mensagens; tot = r.mensagens.length; lim = r.limitado;
      } else {
        const q = new URLSearchParams({ pasta, pagina: String(pag) });
        if (termo) q.set("busca", termo);
        const r = await api.get<PaginaMensagens>(`/api/caixas/${id}/mensagens?${q}`);
        lista = r.mensagens; tot = r.total;
      }
      if (!vale()) return;
      setItens((xs) => (pag === 1 ? lista : [...xs, ...lista]));
      setPagina(pag);
      setTotal(tot);
      setLimitado(lim);
      setSenhaRecusada(false);
      lembrarEnderecos(lista.map((m) => m.de));
    } catch (e) {
      if (!vale()) return;
      setErro(erroMsg(e));
      setSenhaRecusada(ehPrecisaSenha(e));
    } finally {
      if (vale()) setCarregando(false);
    }
  }, [id, pasta, termo, chavePedido, favoritos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!caixa || pasta === SAIDA) return;
    setItens([]);
    void carregar(1);
    const vis = () => { if (document.visibilityState === "visible") void carregar(1); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [caixa?.id, carregar]); // eslint-disable-line react-hooks/exhaustive-deps

  // deep link /c/:id/escrever?modo=…&pasta=…&uid=…&rascunho=… abre o compositor sobre a lista
  useEffect(() => {
    if (rota !== "escrever" || !caixa) return;
    const modo = params.get("modo");
    const uid = Number(params.get("uid"));
    const rascunho = Number(params.get("rascunho"));
    escrever({
      caixaId: id,
      modo: modo === "responder" || modo === "todos" || modo === "encaminhar" ? modo : "nova",
      ...(uid > 0 ? { pasta: params.get("pasta") ?? "INBOX", uid } : {}),
      ...(rascunho > 0 ? { rascunhoUid: rascunho } : {}),
    });
    nav(`/c/${id}`, { replace: true });
  }, [rota, caixa?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // --------------------------------------------------------- seleção
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [selecionando, setSelecionando] = useState(false);
  const modoSelecao = selecionando || sel.size > 0;
  useEffect(() => { setSel(new Set()); setSelecionando(false); }, [pasta, id]);
  const alternar = (uid: number) => setSel((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  const sairSelecao = () => { setSel(new Set()); setSelecionando(false); };

  // ---------------------------------------------------------- rotas
  const qLista = useMemo(() => {
    const q = new URLSearchParams();
    if (params.get("pasta")) q.set("pasta", params.get("pasta")!);
    return q.toString();
  }, [params]);
  const hrefLista = `/c/${id}${qLista ? `?${qLista}` : ""}`;
  const hrefMsg = (m: Item) => `/c/${id}/m/${encodeURIComponent(m.pasta ?? pasta)}/${m.uid}${qLista ? `?${qLista}` : ""}`;

  const remover = useCallback((uids: number[]) => {
    const fora = new Set(uids);
    setItens((xs) => {
      const i = xs.findIndex((m) => m.uid === aberta?.uid);
      const resto = xs.filter((m) => !fora.has(m.uid));
      if (aberta && fora.has(aberta.uid)) {
        // Mac: abre a próxima (ou a anterior); iPhone: volta à lista
        const prox = uma ? null : resto[Math.min(Math.max(i, 0), resto.length - 1)] ?? null;
        setTimeout(() => nav(prox ? hrefMsg(prox) : hrefLista, { replace: true }), 0);
      }
      return resto;
    });
    setTotal((t) => Math.max(0, t - uids.length));
  }, [aberta?.uid, uma, hrefLista]); // eslint-disable-line react-hooks/exhaustive-deps

  const marcar = (uids: number[], campo: "lida" | "estrela", v: boolean) =>
    setItens((xs) => xs.map((m) => (uids.includes(m.uid) ? { ...m, [campo]: v } : m)));

  // -------------------------------------------------------- atalhos
  const [comando, setComando] = useState<{ acao: string; n: number } | null>(null);
  useAtalhos(!uma && pasta !== SAIDA, (a: AcaoAtalho) => {
    if (a === "escrever") { escrever({ caixaId: id }); return; }
    if (a === "buscar") { buscaRef.current?.focus(); return; }
    if (a === "proxima" || a === "anterior") {
      if (!itens.length) return;
      const i = aberta ? itens.findIndex((m) => m.uid === aberta.uid) : -1;
      const j = i < 0 ? 0 : Math.max(0, Math.min(itens.length - 1, i + (a === "proxima" ? 1 : -1)));
      if (j !== i) nav(hrefMsg(itens[j]));
      return;
    }
    if (aberta) setComando({ acao: a, n: Date.now() });
  });

  // ------------------------------------------------------- lote
  const [menuLote, setMenuLote] = useState(false);
  const refMoverLote = useRef<HTMLButtonElement>(null);
  const uidsSel = [...sel];
  const selItens = itens.filter((m) => sel.has(m.uid));
  const todasLidas = selItens.length > 0 && selItens.every((m) => m.lida);
  const todasEstrela = selItens.length > 0 && selItens.every((m) => m.estrela);
  // exclusão definitiva (Lixeira) sempre passa por confirmação
  const [aConfirmar, setAConfirmar] = useState<Item[] | null>(null);
  const naLixeira = (m: Item) => acoes.tipoDe(m.pasta ?? pasta) === "lixeira";

  async function executarLote(acao: AcaoLote, alvo: Item[], destino?: string) {
    // favoritos/busca misturam pastas: agrupa por pasta de origem
    const grupos = new Map<string, number[]>();
    for (const m of alvo) grupos.set(m.pasta ?? pasta, [...(grupos.get(m.pasta ?? pasta) ?? []), m.uid]);
    let ok = true;
    for (const [p, uids] of grupos) ok = !!(await acoes.lote(acao, p, uids, destino)) && ok;
    return ok;
  }

  async function excluirItens(alvo: Item[], confirmado = false) {
    if (!confirmado && alvo.some(naLixeira)) { setAConfirmar(alvo); return; }
    setAConfirmar(null);
    if (await executarLote("excluir", alvo)) {
      remover(alvo.map((m) => m.uid));
      if (alvo.length > 1 || sel.size) sairSelecao();
    }
  }

  async function lote(acao: AcaoLote, destino?: string) {
    setMenuLote(false);
    if (acao === "excluir") { await excluirItens(selItens); return; }
    const uids = uidsSel;
    if (!(await executarLote(acao, selItens, destino))) return;
    if (acao === "lida" || acao === "nao_lida") marcar(uids, "lida", acao === "lida");
    else if (acao === "estrela" || acao === "sem_estrela") {
      if (favoritos && acao === "sem_estrela") remover(uids); else marcar(uids, "estrela", acao === "estrela");
    } else remover(uids);
    sairSelecao();
  }

  // ------------------------------------------------------ ações de linha
  const acoesLinha = (m: Item): { inicio: AcaoLinha[]; fim: AcaoLinha[] } => {
    const p = m.pasta ?? pasta;
    return {
      inicio: [
        { id: "arquivar", rotulo: "Arquivar", icone: "arquivo", cor: COR.arquivar, fn: () => void acoes.arquivar(p, m.uid).then((ok) => ok && remover([m.uid])) },
        { id: "excluir", rotulo: "Excluir", icone: "lixeira", cor: COR.excluir, fn: () => void excluirItens([m]) },
      ],
      fim: [
        { id: "lida", rotulo: m.lida ? "Não lida" : "Lida", icone: m.lida ? "naoLida" : "lida", cor: COR.lida,
          fn: () => void acoes.marcarLida(p, m.uid, !m.lida).then((r) => r !== null && marcar([m.uid], "lida", r)) },
        { id: "estrela", rotulo: m.estrela ? "Sem estrela" : "Estrela", icone: "favoritos", cor: COR.estrela,
          fn: () => void acoes.marcarEstrela(p, m.uid, !m.estrela).then((r) => r !== null && marcar([m.uid], "estrela", r)) },
      ],
    };
  };

  // ------------------------------------------------------- sentinela
  const fimRef = useRef<HTMLDivElement>(null);
  const paginada = !favoritos && !pedido;
  useEffect(() => {
    const el = fimRef.current;
    if (!el || typeof IntersectionObserver === "undefined" || !paginada) return;
    const o = new IntersectionObserver((es) => {
      if (es[0]?.isIntersecting && !carregando && itens.length < total && !erro) void carregar(pagina + 1);
    }, { rootMargin: "400px" });
    o.observe(el);
    return () => o.disconnect();
  }, [carregando, itens.length, total, pagina, erro, carregar, paginada]);

  // título grande que encolhe ao rolar (iPhone)
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [compacto, setCompacto] = useState(false);
  useEffect(() => {
    const el = tituloRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const o = new IntersectionObserver((es) => setCompacto(!es[0].isIntersecting), { threshold: 0, rootMargin: "-44px 0px 0px 0px" });
    o.observe(el);
    return () => o.disconnect();
  }, [uma, aberta]);

  if (!caixa) {
    return caixas === null
      ? <div className="correio"><section className="coluna-lista"><EsqueletoLista /></section></div>
      : <div className="centro-vazio"><Vazio icone="caixas" titulo="Caixa não encontrada" acao={<Link className="link" to="/caixas">Ver caixas</Link>} /></div>;
  }
  if (pasta === SAIDA) return <Saida caixa={caixa} />;

  const especial = ESPECIAIS.find((e) => e.chave === (favoritos ? FAVORITOS : tipoPasta ?? pasta));
  const titulo = favoritos ? "Favoritos" : especial?.rotulo ?? pastas?.find((p) => p.caminho === pasta)?.nome.split(" / ").pop() ?? pasta;
  const naoLidas = pastas?.find((p) => p.caminho === pasta)?.naoLidas;
  const buscando = !!(termo || pedido);
  const subtitulo = buscando
    ? (carregando ? "Buscando…" : `${total.toLocaleString("pt-BR")}${limitado ? "+" : ""} ${total === 1 ? "resultado" : "resultados"}${filtros.todas ? " em todas as pastas" : ""}`)
    : naoLidas ? `${naoLidas.toLocaleString("pt-BR")} não ${naoLidas === 1 ? "lida" : "lidas"}`
      : total ? `${total.toLocaleString("pt-BR")}${limitado ? "+" : ""} ${total === 1 ? "mensagem" : "mensagens"}` : "";

  const mostrarLista = !uma || !aberta;
  const mostrarLeitura = !uma || !!aberta;
  const itensMoverLote: ItemMenu[] = (pastas ?? []).filter((p) => p.caminho !== pasta).map((p) => ({ rotulo: p.nome, icone: "pasta", onClick: () => void lote("mover", p.caminho) }));
  const limparBusca = () => { setBusca(""); setFiltros(FILTROS_VAZIOS); };

  const formFiltros = <FormFiltros valor={filtros} onAplicar={(f) => { setFiltros(f); setPainelFiltros(false); }} onLimpar={() => { setFiltros(FILTROS_VAZIOS); setPainelFiltros(false); }} />;

  const cabecalho = modoSelecao ? (
    <div className="lista__cab lista__cab--sel">
      <button type="button" className="txt-btn" onClick={sairSelecao}>Cancelar</button>
      <span className="lista__sel-n" aria-live="polite">{sel.size === 0 ? "Selecionar mensagens" : sel.size === 1 ? "1 selecionada" : `${sel.size} selecionadas`}</span>
      <button type="button" className="txt-btn" onClick={() => setSel(sel.size === itens.length ? new Set() : new Set(itens.map((m) => m.uid)))}>
        {sel.size === itens.length && itens.length > 0 ? "Nenhuma" : "Todas"}
      </button>
    </div>
  ) : (
    <div className={`lista__cab${compacto && uma ? " lista__cab--compacto" : ""}`}>
      <div className="lista__barra">
        {layout !== "tres" && <BotaoIcone icone={uma ? "menu" : "lateral"} rotulo="Mostrar pastas" tam={uma ? 22 : 18} onClick={abrirGaveta} />}
        {uma && <span className="lista__titulo-p" aria-hidden={!compacto}>{titulo}</span>}
        <span className="barra-esp" />
        {!uma && <BotaoIcone icone="atualizar" rotulo="Atualizar" onClick={() => void carregar(1)} disabled={carregando} />}
        {itens.length > 0 && <button type="button" className="txt-btn" onClick={() => setSelecionando(true)}>Selecionar</button>}
        {layout === "duas" && <BotaoIcone icone="escrever" rotulo="Escrever" onClick={() => escrever({ caixaId: id })} />}
      </div>
      <h1 ref={tituloRef} className="lista__titulo">{titulo}</h1>
      <p className="lista__sub">
        {uma && <span className="lista__caixa">{nomeCaixa(caixa)}</span>}
        {uma && subtitulo && <span aria-hidden="true"> · </span>}
        <span>{subtitulo}</span>
      </p>
      {!favoritos && (
        <div className="busca">
          <label className="busca__campo">
            <Icone nome="buscar" tam={15} />
            <input ref={buscaRef} type="search" placeholder={filtros.todas ? "Buscar em todas as pastas" : `Buscar em ${titulo}`} aria-label="Buscar" value={busca} maxLength={200}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { limparBusca(); (e.target as HTMLInputElement).blur(); } }} />
            {!uma && !busca && !ativos.length && <kbd className="busca__tecla">/</kbd>}
            <button ref={filtroRef} type="button" className={`busca__filtro${ativos.length ? " busca__filtro--on" : ""}`}
              aria-label={ativos.length ? `Filtros (${ativos.length} ativos)` : "Filtros"} aria-expanded={painelFiltros} onClick={() => setPainelFiltros((v) => !v)}>
              <Icone nome="filtros" tam={15} />
              {ativos.length > 0 && <span className="busca__n">{ativos.length}</span>}
            </button>
          </label>
          {params.has("buscar") && uma && (
            <button type="button" className="txt-btn" onClick={() => { limparBusca(); const q = new URLSearchParams(params); q.delete("buscar"); setParams(q, { replace: true }); }}>Cancelar</button>
          )}
        </div>
      )}
      {ativos.length > 0 && (
        <div className="filtros" aria-label="Filtros ativos">
          {ativos.map((a) => (
            <button key={a.chave} type="button" className="chip chip--on" aria-label={`Remover filtro ${a.rotulo}`}
              onClick={() => setFiltros({ ...filtros, [a.chave]: FILTROS_VAZIOS[a.chave], ...(a.chave === "desde" ? { ate: "" } : {}) })}>
              {a.rotulo}<Icone nome="fechar" tam={12} />
            </button>
          ))}
        </div>
      )}
      {uma ? (
        <Sheet aberto={painelFiltros} onFechar={() => setPainelFiltros(false)} rotulo="Filtros" titulo="Filtros">{painelFiltros && formFiltros}</Sheet>
      ) : (
        <Popover aberto={painelFiltros} onFechar={() => setPainelFiltros(false)} ancora={filtroRef} rotulo="Filtros" alinhar="fim" largura={320}>{formFiltros}</Popover>
      )}
    </div>
  );

  const corpoLista = () => {
    if (carregando && itens.length === 0) return <EsqueletoLista />;
    if (erro && !senhaRecusada && itens.length === 0) {
      return <Vazio icone="alerta" titulo="Não foi possível carregar" texto={<span role="alert">{erro}</span>}
        acao={<Button variante="cinza" tam="p" icone="atualizar" onClick={() => void carregar(1)}>Tentar de novo</Button>} />;
    }
    if (!carregando && itens.length === 0 && !senhaRecusada) {
      if (buscando) return <Vazio icone="buscar" titulo="Nada encontrado" texto={filtros.todas ? "Tente outros termos ou filtros." : "Tente outros termos ou busque em todas as pastas."} />;
      if (favoritos) return <Vazio icone="favoritos" titulo="Nenhum favorito" texto="Marque mensagens com estrela (tecla S) para encontrá-las aqui." />;
      return <Vazio icone={especial?.icone ?? "pasta"} titulo="Nenhuma mensagem nesta pasta." texto={pasta === "INBOX" ? `O que chegar para ${caixa.endereco} aparece aqui.` : undefined} />;
    }
    return (
      <>
        <ul className={`lista${modoSelecao ? " lista--sel" : ""}`} aria-label="Mensagens">
          {itens.map((m) => {
            const a = acoesLinha(m);
            return (
              <LinhaMensagem key={`${m.pasta ?? pasta}:${m.uid}`} m={aberta?.uid === m.uid && !m.lida ? { ...m, lida: true } : m} href={hrefMsg(m)}
                aberta={!uma && aberta?.uid === m.uid} selecionada={sel.has(m.uid)} modoSelecao={modoSelecao}
                inicio={a.inicio} fim={a.fim} pastaNome={pedido && filtros.todas ? acoes.nomeDe(m.pasta ?? pasta) : undefined}
                onAbrir={ehRascunhos || (m.pasta && acoes.tipoDe(m.pasta) === "rascunhos") ? () => escrever({ caixaId: id, rascunhoUid: m.uid }) : undefined}
                onAlternarSelecao={() => alternar(m.uid)}
                onPressaoLonga={() => { setSelecionando(true); alternar(m.uid); }} />
            );
          })}
        </ul>
        <div ref={fimRef} className="lista__fim">
          {paginada && itens.length < total && (
            <Button variante="simples" tam="p" disabled={carregando} onClick={() => void carregar(pagina + 1)}>
              {carregando ? "Carregando…" : `Carregar mais ${Math.min(50, total - itens.length)}`}
            </Button>
          )}
          {limitado && <p className="lista__nota">Mostrando os 200 mais recentes. Refine a busca para ver outros.</p>}
          {erro && itens.length > 0 && <p className="txt-perigo" role="alert">{erro}</p>}
        </div>
      </>
    );
  };

  const emSpam = tipoPasta === "spam";
  return (
    <div className={`correio${aberta ? " correio--aberta" : ""}`}>
      {mostrarLista && (
        <section className="coluna-lista" aria-label={titulo}>
          <div className="coluna-lista__rolagem">
            {cabecalho}
            {(caixa.estado === "precisa_senha" || senhaRecusada) && <div className="lista__avisos"><BannerSenha caixa={caixa} /></div>}
            {corpoLista()}
          </div>
          {modoSelecao && (
            <div className="barra-lote" role="toolbar" aria-label="Ações em lote">
              <BotaoIcone icone={todasLidas ? "naoLida" : "lida"} rotulo={todasLidas ? "Marcar como não lidas" : "Marcar como lidas"} disabled={!sel.size} onClick={() => void lote(todasLidas ? "nao_lida" : "lida")} />
              <BotaoIcone icone="favoritos" rotulo={todasEstrela ? "Tirar estrela" : "Marcar com estrela"} className={todasEstrela ? "bico--estrela" : ""} disabled={!sel.size} onClick={() => void lote(todasEstrela ? "sem_estrela" : "estrela")} />
              <BotaoIcone ref={refMoverLote} icone="mover" rotulo="Mover" disabled={!sel.size} onClick={() => setMenuLote(true)} />
              {tipoPasta !== "arquivo" && <BotaoIcone icone="arquivo" rotulo="Arquivar" disabled={!sel.size} onClick={() => void lote("arquivar")} />}
              {emSpam
                ? <BotaoIcone icone="naoSpam" rotulo="Não é spam" disabled={!sel.size} onClick={() => void lote("nao_spam")} />
                : <BotaoIcone icone="spam" rotulo="Marcar como spam" disabled={!sel.size} onClick={() => void lote("spam")} />}
              <BotaoIcone icone="lixeira" rotulo="Excluir" disabled={!sel.size} onClick={() => void lote("excluir")} />
            </div>
          )}
          {uma ? (
            <Sheet aberto={menuLote} onFechar={() => setMenuLote(false)} rotulo="Mover para" titulo="Mover para"><Menu rotulo="Pastas" itens={itensMoverLote} /></Sheet>
          ) : (
            <Popover aberto={menuLote} onFechar={() => setMenuLote(false)} ancora={refMoverLote} rotulo="Mover para" largura={230}><Menu rotulo="Pastas" itens={itensMoverLote} /></Popover>
          )}
        </section>
      )}
      {aConfirmar && (() => {
        const n = aConfirmar.length;
        const k = aConfirmar.filter(naLixeira).length;
        const todas = k === n;
        return (
          <ConfirmDialog rotuloConfirmar="Apagar" onCancelar={() => setAConfirmar(null)} onConfirmar={() => void excluirItens(aConfirmar, true)}
            titulo={todas ? (n === 1 ? "Apagar definitivamente?" : `Apagar ${n} mensagens definitivamente?`) : `Excluir ${n} mensagens?`}
            texto={todas
              ? (n === 1 ? "A mensagem será apagada do servidor e não poderá ser recuperada." : "As mensagens serão apagadas do servidor e não poderão ser recuperadas.")
              : `${k} ${k === 1 ? "está na Lixeira e será apagada" : "estão na Lixeira e serão apagadas"} de vez; as outras vão para a Lixeira.`} />
        );
      })()}
      {mostrarLeitura && (
        <section className="coluna-leitura" aria-label="Leitura">
          {aberta ? (
            <Leitura key={`${aberta.pasta}:${aberta.uid}`} caixa={caixa} pasta={aberta.pasta} uid={aberta.uid} comando={comando}
              voltar={uma ? { rotulo: titulo, href: hrefLista } : undefined}
              onSaiu={(u) => remover([u])} onLida={(u, v) => marcar([u], "lida", v)} onEstrela={(u, v) => marcar([u], "estrela", v)} />
          ) : (
            <div className="centro-vazio">
              <Vazio icone="naoLida" titulo="Nenhuma mensagem selecionada"
                texto={<>Escolha uma mensagem na lista ou pressione <kbd>C</kbd> para escrever.</>} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
