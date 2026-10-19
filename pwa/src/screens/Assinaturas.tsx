// Estúdio de assinatura (API.md §8): várias assinaturas por caixa, padrões
// para novo e-mail e resposta, quatro modelos, prévia ao vivo clara e escura.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { BotaoIcone, Button, Campo, ConfirmDialog, Icone, Menu, Popover, Segmented, Toggle, useToast, type NomeIcone } from "../ui";
import { api2, type Assinatura, type CamposAssinatura2, type ListaAssinaturas, type Modelo } from "../api2";
import { useCaixa } from "../caixas";
import { erroMsg } from "../lib";
import { nomeCaixa } from "../marca";
import { useShell } from "../shell/contexto";
import { MSG_IMAGEM } from "./ConfigCaixa";
import Pagina from "./Pagina";

const MODELOS: { id: Modelo; nome: string; nota: string }[] = [
  { id: "classico", nome: "Clássico", nota: "Serifado, sóbrio" },
  { id: "executivo", nome: "Executivo", nota: "Logo acima, filete" },
  { id: "moderno", nome: "Moderno", nota: "Barra de cor" },
  { id: "minimalista", nome: "Minimalista", nota: "Só o essencial" },
];

type Edicao = { nome: string; modelo: Modelo; campos: CamposAssinatura2 };

/** Documento da prévia (srcdoc): papel claro ou escuro, com um trecho de e-mail acima da assinatura. */
export function documentoAssinatura(html: string, escuro: boolean, comCorpo = true): string {
  const fundo = escuro ? "#1e1e20" : "#ffffff";
  const cor = escuro ? "#e6e6e9" : "#1d1d1f";
  const corpo = comCorpo
    ? `<p style="margin:0 0 10px">Prezado Dr. Marcos,</p><p style="margin:0 0 18px;color:${escuro ? "#a1a1a7" : "#6e6e73"}">Segue o laudo revisado, conforme combinado. Fico à disposição.</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    `<style>html,body{margin:0;background:${fundo};color:${cor}}body{padding:${comCorpo ? "22px 24px 26px" : "14px"};font:14px/1.5 -apple-system,BlinkMacSystemFont,Inter,Arial,sans-serif}img{max-width:100%}</style>` +
    `</head><body>${corpo}${html || `<p style="color:#8e8e93;margin:0">Preencha ao menos um campo para ver a assinatura.</p>`}</body></html>`;
}

/** iframe que cresce com o conteúdo (sem scripts; mesma origem só para medir a altura). */
function Previa({ doc, titulo, className = "", min = 120 }: { doc: string; titulo: string; className?: string; min?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [alt, setAlt] = useState(min);
  const medir = () => {
    const d = ref.current?.contentDocument;
    if (d?.body) setAlt(Math.max(min, Math.ceil(d.documentElement.scrollHeight)));
  };
  return <iframe ref={ref} className={className} title={titulo} sandbox="allow-same-origin" srcDoc={doc} style={{ height: alt }} onLoad={medir} />;
}

function Grupo2({ titulo, icone, children, acao }: { titulo: string; icone: NomeIcone; children: React.ReactNode; acao?: React.ReactNode }) {
  return (
    <section className="est-grupo">
      <header className="est-grupo__cab">
        <span className="est-grupo__ic"><Icone nome={icone} tam={15} /></span>
        <h2>{titulo}</h2>
        {acao}
      </header>
      <div className="est-grupo__corpo">{children}</div>
    </section>
  );
}

export default function Assinaturas() {
  const id = Number(useParams().id);
  const caixa = useCaixa(id);
  const { layout } = useShell();
  const { mostrar } = useToast();
  const uma = layout === "uma";
  const [dados, setDados] = useState<ListaAssinaturas | null>(null);
  const [erro, setErro] = useState("");
  const [selId, setSelId] = useState<number | null>(null);
  const [ed, setEd] = useState<Edicao | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState("");
  const [previa, setPrevia] = useState("");
  const [miniaturas, setMiniaturas] = useState<Partial<Record<Modelo, string>>>({});
  const [menu, setMenu] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const refMais = useRef<HTMLButtonElement>(null);
  const inputLogo = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async (escolher?: number) => {
    try {
      const d = await api2.listarAssinaturas(id);
      setDados(d); setErro("");
      setSelId((atual) => escolher ?? (atual && d.assinaturas.some((a) => a.id === atual) ? atual : d.padroes.nova ?? d.assinaturas[0]?.id ?? null));
    } catch (e) { setErro(erroMsg(e)); }
  }, [id]);
  useEffect(() => { void carregar(); }, [carregar]);

  const sel: Assinatura | null = dados?.assinaturas.find((a) => a.id === selId) ?? null;
  useEffect(() => { setEd(sel ? { nome: sel.nome, modelo: sel.modelo, campos: { ...sel.campos } } : null); setErroSalvar(""); }, [sel?.id, sel?.atualizadoEm]); // eslint-disable-line react-hooks/exhaustive-deps
  const sujo = !!sel && !!ed && JSON.stringify({ nome: sel.nome, modelo: sel.modelo, campos: sel.campos }) !== JSON.stringify(ed);

  // prévia ao vivo (debounce) e miniaturas dos quatro modelos com os mesmos campos
  const chave = ed ? JSON.stringify([ed.modelo, ed.campos, sel?.temLogoPropria]) : "";
  useEffect(() => {
    if (!ed || !sel) return;
    let vivo = true;
    const t = setTimeout(() => {
      api2.previaAssinatura(id, { modelo: ed.modelo, campos: ed.campos, assinaturaId: sel.id })
        .then((r) => { if (vivo) setPrevia(r.html); }).catch(() => {});
    }, 300);
    return () => { vivo = false; clearTimeout(t); };
  }, [chave]); // eslint-disable-line react-hooks/exhaustive-deps
  const chaveMini = ed ? JSON.stringify([ed.campos, sel?.temLogoPropria]) : "";
  useEffect(() => {
    if (!ed || !sel) return;
    let vivo = true;
    const t = setTimeout(() => {
      for (const m of MODELOS) {
        api2.previaAssinatura(id, { modelo: m.id, campos: ed.campos, assinaturaId: sel.id })
          .then((r) => { if (vivo) setMiniaturas((x) => ({ ...x, [m.id]: r.html })); }).catch(() => {});
      }
    }, 700);
    return () => { vivo = false; clearTimeout(t); };
  }, [chaveMini]); // eslint-disable-line react-hooks/exhaustive-deps

  const campo = <K extends keyof CamposAssinatura2>(k: K, v: CamposAssinatura2[K]) => setEd((e) => (e ? { ...e, campos: { ...e.campos, [k]: v } } : e));
  const rede = (k: keyof NonNullable<CamposAssinatura2["redes"]>, v: string) =>
    setEd((e) => (e ? { ...e, campos: { ...e.campos, redes: { ...e.campos.redes, [k]: v } } } : e));
  const falha = (e: unknown) => mostrar(erroMsg(e), { tom: "perigo", icone: "alerta" });

  async function salvar() {
    if (!sel || !ed) return;
    setSalvando(true); setErroSalvar("");
    // campos vazios não vão (o servidor valida http(s) e e-mail)
    const limpo: CamposAssinatura2 = Object.fromEntries(Object.entries(ed.campos).filter(([k, v]) => k === "aviso" || (typeof v === "string" ? v.trim() !== "" : v != null))) as CamposAssinatura2;
    if (limpo.redes) limpo.redes = Object.fromEntries(Object.entries(limpo.redes).filter(([, v]) => v?.trim())) as CamposAssinatura2["redes"];
    try {
      await api2.editarAssinatura(id, sel.id, { nome: ed.nome.trim() || MODELOS.find((m) => m.id === ed.modelo)!.nome, modelo: ed.modelo, campos: limpo });
      await carregar(sel.id);
      mostrar("Assinatura salva", { icone: "ok" });
    } catch (e) { setErroSalvar(erroMsg(e)); } finally { setSalvando(false); }
  }
  async function nova() {
    try {
      const r = await api2.criarAssinatura(id, { modelo: "classico", nome: `Assinatura ${(dados?.assinaturas.length ?? 0) + 1}`, campos: { nome: "", corDestaque: caixa?.cor ?? undefined } });
      await carregar(r.assinatura.id);
    } catch (e) { falha(e); }
  }
  async function padrao(tipo: "nova" | "resposta", ligado: boolean) {
    if (!dados || !sel) return;
    const p = { ...dados.padroes, [tipo]: ligado ? sel.id : null };
    try { const r = await api2.definirPadroes(id, p); setDados({ ...dados, padroes: r.padroes }); } catch (e) { falha(e); }
  }
  async function excluir() {
    setExcluindo(false);
    if (!sel) return;
    try { await api2.excluirAssinatura(id, sel.id); setSelId(null); await carregar(); mostrar("Assinatura excluída", { icone: "lixeira" }); } catch (e) { falha(e); }
  }
  async function copiar() {
    try { await navigator.clipboard.writeText(previa); mostrar("HTML copiado", { icone: "copiar" }); } catch { mostrar("Não foi possível copiar neste navegador.", { tom: "perigo", icone: "alerta" }); }
  }
  function baixar() {
    if (!sel) return;
    const a = document.createElement("a");
    if (!sujo) { a.href = api2.urlHtmlAssinatura(id, sel.id); }
    else {
      const doc = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${ed?.nome ?? "Assinatura"}</title></head><body>${previa}</body></html>`;
      a.href = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    a.download = `assinatura-${(ed?.nome ?? "correio").toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.html`;
    a.click();
  }
  async function enviarLogo(f: File | undefined) {
    if (!f || !sel) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 2 * 1024 * 1024) { mostrar(MSG_IMAGEM, { tom: "perigo", icone: "alerta" }); return; }
    try { await api2.enviarLogoAssinatura(id, sel.id, f); campo("logo", "propria"); await carregar(sel.id); mostrar("Logo enviado", { icone: "imagem" }); } catch (e) { falha(e); }
    if (inputLogo.current) inputLogo.current.value = "";
  }

  const docClaro = useMemo(() => documentoAssinatura(previa, false), [previa]);

  if (!caixa) return null;
  const acoesTopo = sel && (
    <div className="est-acoes">
      {!uma && <Button variante="cinza" tam="p" icone="copiar" disabled={!previa} onClick={() => void copiar()}>Copiar HTML</Button>}
      {!uma && <Button variante="cinza" tam="p" icone="baixar" disabled={!previa} onClick={baixar}>Baixar .html</Button>}
      <Button variante="liquido" tam="p" disabled={!sujo || salvando} onClick={() => void salvar()}>{salvando ? "Salvando…" : sujo ? "Salvar" : "Salvo"}</Button>
    </div>
  );

  const lista = dados && (
    <nav className="est-lista" aria-label="Assinaturas">
      {dados.assinaturas.map((a) => (
        <button key={a.id} type="button" className={`est-pilula${a.id === selId ? " est-pilula--on" : ""}`} aria-current={a.id === selId ? "true" : undefined} onClick={() => setSelId(a.id)}>
          <span className="est-pilula__nome">{a.nome}</span>
          {(a.id === dados.padroes.nova || a.id === dados.padroes.resposta) && (
            <span className="est-pilula__tags">
              {a.id === dados.padroes.nova && <span>Novo e-mail</span>}
              {a.id === dados.padroes.resposta && <span>Resposta</span>}
            </span>
          )}
        </button>
      ))}
      <button type="button" className="est-pilula est-pilula--nova" onClick={() => void nova()}><Icone nome="mais_" tam={14} />Nova</button>
    </nav>
  );

  // só a versão clara, num "papel" branco nos dois temas: é como os leitores de e-mail exibem a assinatura
  const painelPrevia = (
    <aside className="est-previa" aria-label="Prévia">
      <figure className="est-papel est-papel--claro">
        {!uma && <figcaption><Icone nome="olho" tam={13} />Prévia</figcaption>}
        <div className="est-papel__env"><span className="est-papel__de">De: <strong>{caixa.endereco}</strong></span><Previa doc={docClaro} titulo="Prévia clara" className="est-papel__doc" min={220} /></div>
      </figure>
      {uma && sel && (
        <div className="est-previa__acoes">
          <Button variante="cinza" tam="p" icone="copiar" disabled={!previa} onClick={() => void copiar()}>Copiar HTML</Button>
          <Button variante="cinza" tam="p" icone="baixar" disabled={!previa} onClick={baixar}>Baixar .html</Button>
        </div>
      )}
    </aside>
  );

  const editor = sel && ed && dados && (
    <div className="est-editor">
      <Grupo2 titulo="Assinatura" icone="assinatura" acao={
        <>
          <BotaoIcone ref={refMais} icone="mais" rotulo="Mais opções" onClick={() => setMenu((v) => !v)} />
          <Popover aberto={menu} onFechar={() => setMenu(false)} ancora={refMais} rotulo="Mais opções" alinhar="fim" largura={210}>
            <Menu rotulo="Mais opções" onEscolher={() => setMenu(false)} itens={[{ icone: "lixeira", rotulo: "Excluir assinatura", perigo: true, onClick: () => setExcluindo(true) }]} />
          </Popover>
        </>
      }>
        <Campo rotulo="Nome da assinatura"><input className="campo" aria-label="Nome da assinatura" value={ed.nome} maxLength={100} onChange={(e) => setEd({ ...ed, nome: e.target.value })} /></Campo>
        <div className="est-padroes">
          <label className="est-padrao"><Toggle rotulo="Padrão para novo e-mail" ligado={dados.padroes.nova === sel.id} onChange={(v) => void padrao("nova", v)} /><span>Padrão para novo e-mail</span></label>
          <label className="est-padrao"><Toggle rotulo="Padrão para respostas" ligado={dados.padroes.resposta === sel.id} onChange={(v) => void padrao("resposta", v)} /><span>Padrão para respostas e encaminhamentos</span></label>
        </div>
      </Grupo2>

      <Grupo2 titulo="Modelo" icone="aparencia">
        <div className="est-modelos" role="radiogroup" aria-label="Modelo">
          {MODELOS.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={ed.modelo === m.id} aria-label={m.nome}
              className={`est-modelo${ed.modelo === m.id ? " est-modelo--on" : ""}`} onClick={() => setEd({ ...ed, modelo: m.id })}>
              <span className="est-modelo__mini">
                {miniaturas[m.id] !== undefined
                  ? <iframe title={`Miniatura ${m.nome}`} sandbox="" tabIndex={-1} srcDoc={documentoAssinatura(miniaturas[m.id]!, false, false)} />
                  : <span className="esq" />}
              </span>
              <span className="est-modelo__txt"><strong>{m.nome}</strong><span>{m.nota}</span></span>
              {ed.modelo === m.id && <span className="est-modelo__ok"><Icone nome="ok" tam={12} /></span>}
            </button>
          ))}
        </div>
      </Grupo2>

      <Grupo2 titulo="Identidade" icone="assinatura">
        <div className="form-grade">
          <Campo rotulo="Nome"><input className="campo" aria-label="Nome" value={ed.campos.nome ?? ""} onChange={(e) => campo("nome", e.target.value)} /></Campo>
          <Campo rotulo="Cargo"><input className="campo" aria-label="Cargo" value={ed.campos.cargo ?? ""} onChange={(e) => campo("cargo", e.target.value)} /></Campo>
          <Campo rotulo="Empresa"><input className="campo" aria-label="Empresa" value={ed.campos.empresa ?? ""} onChange={(e) => campo("empresa", e.target.value)} /></Campo>
          <Campo rotulo="OAB ou registro"><input className="campo" aria-label="OAB ou registro" placeholder="OAB/SP 000.000" value={ed.campos.registro ?? ""} onChange={(e) => campo("registro", e.target.value)} /></Campo>
        </div>
      </Grupo2>

      <Grupo2 titulo="Contato" icone="naoLida">
        <div className="form-grade">
          <Campo rotulo="Telefone"><input className="campo" type="tel" aria-label="Telefone" value={ed.campos.telefone ?? ""} onChange={(e) => campo("telefone", e.target.value)} /></Campo>
          <Campo rotulo="WhatsApp"><input className="campo" type="tel" aria-label="WhatsApp" value={ed.campos.whatsapp ?? ""} onChange={(e) => campo("whatsapp", e.target.value)} /></Campo>
          <Campo rotulo="E-mail"><input className="campo" type="email" aria-label="E-mail" value={ed.campos.email ?? ""} onChange={(e) => campo("email", e.target.value)} /></Campo>
          <Campo rotulo="Site"><input className="campo" type="url" aria-label="Site" placeholder="www.dominio.com.br" value={ed.campos.site ?? ""} onChange={(e) => campo("site", e.target.value)} /></Campo>
        </div>
        <Campo rotulo="Endereço"><input className="campo" aria-label="Endereço" value={ed.campos.endereco ?? ""} onChange={(e) => campo("endereco", e.target.value)} /></Campo>
      </Grupo2>

      <Grupo2 titulo="Redes" icone="externo">
        <div className="form-grade">
          {(["linkedin", "instagram", "facebook", "x", "youtube"] as const).map((r) => (
            <Campo key={r} rotulo={{ linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", x: "X", youtube: "YouTube" }[r]}>
              <input className="campo" type="url" aria-label={r} placeholder="https://" value={ed.campos.redes?.[r] ?? ""} onChange={(e) => rede(r, e.target.value)} />
            </Campo>
          ))}
        </div>
      </Grupo2>

      <Grupo2 titulo="Aviso legal" icone="seguro" acao={
        <span className="est-grupo__links">
          <button type="button" className="txt-btn" onClick={() => campo("aviso", dados.avisoPadrao)}>Texto padrão</button>
          <button type="button" className="txt-btn" onClick={() => campo("aviso", "")}>Sem aviso</button>
        </span>
      }>
        <textarea className="campo campo--area" aria-label="Aviso de confidencialidade" rows={4} maxLength={3000} placeholder="Sem aviso de confidencialidade"
          value={ed.campos.aviso ?? ""} onChange={(e) => campo("aviso", e.target.value)} />
      </Grupo2>

      <Grupo2 titulo="Aparência" icone="aparencia">
        <Campo rotulo="Cor de destaque">
          <span className="campo-linha">
            <input type="color" className="cor-amostra" aria-label="Cor de destaque" value={/^#[0-9a-f]{6}$/i.test(ed.campos.corDestaque ?? "") ? ed.campos.corDestaque : caixa.cor ?? "#1f3a5f"} onChange={(e) => campo("corDestaque", e.target.value)} />
            <input className="campo campo--hex" aria-label="Cor em hexadecimal" value={ed.campos.corDestaque ?? ""} placeholder={caixa.cor ?? "#1f3a5f"} maxLength={7} onChange={(e) => campo("corDestaque", e.target.value.trim())} />
            {caixa.cor && ed.campos.corDestaque !== caixa.cor && <button type="button" className="txt-btn" onClick={() => campo("corDestaque", caixa.cor!)}>Cor da caixa</button>}
          </span>
        </Campo>
        <div className="est-linha">
          <span className="campo-bloco__rotulo">Divisor</span>
          <Segmented rotulo="Divisor" valor={ed.campos.divisor ?? "linha"} onChange={(v) => campo("divisor", v)}
            opcoes={[{ valor: "linha", rotulo: "Linha" }, { valor: "barra", rotulo: "Barra" }, { valor: "nenhum", rotulo: "Nenhum" }]} />
        </div>
        <div className="est-linha">
          <span className="campo-bloco__rotulo">Logo</span>
          <Segmented rotulo="Logo" valor={ed.campos.logo ?? "caixa"} onChange={(v) => { campo("logo", v); if (v === "propria" && !sel.temLogoPropria) inputLogo.current?.click(); }}
            opcoes={[{ valor: "caixa", rotulo: "Da caixa" }, { valor: "propria", rotulo: "Própria" }, { valor: "nenhum", rotulo: "Nenhum" }]} />
        </div>
        {ed.campos.logo === "propria" && (
          <p className="campo-bloco__ajuda">
            {sel.temLogoPropria ? "Logo próprio enviado. " : "Nenhum logo próprio ainda. "}
            <button type="button" className="row-link" onClick={() => inputLogo.current?.click()}>{sel.temLogoPropria ? "Trocar" : "Enviar logo"}</button> ({MSG_IMAGEM})
          </p>
        )}
        <input ref={inputLogo} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Enviar logo próprio" onChange={(e) => void enviarLogo(e.target.files?.[0])} />
      </Grupo2>
      {erroSalvar && <p className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} />{erroSalvar}</p>}
    </div>
  );

  return (
    <Pagina titulo="Assinaturas" sub={`${nomeCaixa(caixa)} · ${caixa.endereco}`} largura="larga"
      voltar={{ rotulo: uma ? "Ajustes" : nomeCaixa(caixa), href: `/c/${id}/config` }} acao={acoesTopo}>
      {erro && <p className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} />{erro}</p>}
      {lista}
      {dados && dados.assinaturas.length === 0 && (
        <div className="est-vazio">
          <span className="vazio__ic"><Icone nome="assinatura" tam={26} /></span>
          <h2 className="vazio__titulo">Nenhuma assinatura ainda</h2>
          <p className="vazio__texto">Crie a primeira: ela vira o padrão para novos e-mails e respostas.</p>
          <Button variante="liquido" icone="mais_" onClick={() => void nova()}>Criar assinatura</Button>
        </div>
      )}
      {sel && ed && (
        <div className="est-grade">
          {uma && painelPrevia}
          {editor}
          {!uma && painelPrevia}
        </div>
      )}
      {excluindo && sel && <ConfirmDialog titulo={`Excluir “${sel.nome}”?`} rotuloConfirmar="Excluir" texto="Mensagens já enviadas não mudam. Se ela era um padrão, o padrão fica vazio." onCancelar={() => setExcluindo(false)} onConfirmar={() => void excluir()} />}
    </Pagina>
  );
}
