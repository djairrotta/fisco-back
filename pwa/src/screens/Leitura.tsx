import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BotaoIcone, Button, ConfirmDialog, EsqueletoLeitura, Icone, Menu, Monograma, Popover, Sheet, type ItemMenu,
} from "../ui";
import { useCaixas } from "../caixas";
import { lembrarEnderecos } from "../compor";
import { buscarDataUrl, dataLonga, nomeEndereco, tamanhoLegivel, useCarga } from "../lib";
import { cidsReferenciados, documentoIframe, sanitizarEmail, textoParaHtml } from "../sanitizar";
import { useAcoes } from "../acoes";
import { useShell } from "../shell/contexto";
import { TECLA_DE } from "../shell/atalhos";
import type { Anexo, Caixa, Endereco, Mensagem } from "../tipos";

const LIMITE_INLINE = 5 * 1024 * 1024;

export const urlAnexo = (caixaId: number, pasta: string, uid: number, parte: string) =>
  `/api/caixas/${caixaId}/mensagens/${uid}/anexos/${encodeURIComponent(parte)}?pasta=${encodeURIComponent(pasta)}`;

/** Baixa as imagens inline (cid) e devolve cid → data: URL (o iframe sandbox tem origem opaca). */
async function carregarCids(caixaId: number, m: Mensagem): Promise<Record<string, string>> {
  if (!m.html) return {};
  const usados = new Set(cidsReferenciados(m.html));
  const alvos = m.anexos.filter((a) => a.cid && usados.has(a.cid) && a.tipo.startsWith("image/") && a.tamanho <= LIMITE_INLINE);
  const pares = await Promise.all(alvos.map(async (a) => {
    const url = await buscarDataUrl(urlAnexo(caixaId, m.pasta, m.uid, a.parte), a.tipo, LIMITE_INLINE);
    return url ? ([a.cid!, url] as const) : null;
  }));
  return Object.fromEntries(pares.filter((p): p is readonly [string, string] => p !== null));
}

const listaEnd = (es: Endereco[]) => es.map((e) => e.nome || e.endereco).join(", ");

/** HTML sem cores/fundos próprios pode seguir o tema do app; o resto fica em papel branco. */
export function htmlSimples(html: string): boolean {
  return !/(style\s*=|<style|bgcolor|color\s*=|background\s*=)/i.test(html);
}

export function BannerSenha({ caixa }: { caixa: Caixa }) {
  return (
    <div className="aviso aviso--perigo" role="alert">
      <Icone nome="chave" tam={16} />
      <span>A senha de {caixa.endereco} foi recusada pelo servidor.</span>
      <Link className="aviso__acao" to={`/c/${caixa.id}/config`}>Atualizar senha</Link>
    </div>
  );
}

function ChipAnexo({ a, href }: { a: Anexo; href: string }) {
  const ext = (a.nome?.split(".").pop() ?? "").slice(0, 4).toUpperCase();
  return (
    <a className="anexo" href={href} download={a.nome ?? "anexo"}>
      <span className={`anexo__tipo anexo__tipo--${/pdf/i.test(ext) ? "pdf" : /xls|csv/i.test(ext) ? "planilha" : /doc|odt|rtf/i.test(ext) ? "texto" : /png|jpe?g|gif|webp|heic/i.test(ext) ? "imagem" : "outro"}`}>{ext || <Icone nome="arquivo_" tam={14} />}</span>
      <span className="anexo__txt">
        <span className="anexo__nome">{a.nome ?? `anexo ${a.parte}`}</span>
        <span className="anexo__tam">{tamanhoLegivel(a.tamanho)}</span>
      </span>
      <Icone nome="baixar" tam={15} className="anexo__baixar" />
    </a>
  );
}

/** Endereços puros de um campo livre ("a@b.com, c@d.com"). */
export function separarEnderecos(v: string): { validos: string[]; invalidos: string[] } {
  const partes = v.split(/[,;\s]+/).map((s) => s.trim().replace(/^<|>$/g, "")).filter(Boolean);
  const validos = [...new Set(partes.filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)).map((s) => s.toLowerCase()))];
  return { validos, invalidos: partes.filter((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) };
}

function DialogoRedirecionar({ assunto, de, onEnviar, onCancelar }: { assunto: string; de: string; onEnviar: (para: string[]) => Promise<boolean>; onCancelar: () => void }) {
  const [v, setV] = useState("");
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const { validos, invalidos } = separarEnderecos(v);
  return (
    <Sheet aberto onFechar={onCancelar} rotulo="Redirecionar" titulo={confirmando ? "Confirmar redirecionamento" : "Redirecionar"}>
      {!confirmando ? (
        <>
          <p className="folha__texto">A mensagem segue como está, com o remetente original ({de}), para os novos destinatários. Nada fica em Enviados.</p>
          <label className="campo-bloco">
            <span className="campo-bloco__rotulo">Para</span>
            <input className="campo" type="text" inputMode="email" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="nome@dominio.com.br, outro@dominio.com.br" aria-label="Redirecionar para"
              onKeyDown={(e) => { if (e.key === "Enter" && validos.length && !invalidos.length) setConfirmando(true); }} />
            {invalidos.length > 0 && <span className="campo-bloco__erro">Endereço inválido: {invalidos.join(", ")}</span>}
          </label>
          <div className="folha__rodape folha__rodape--lado">
            <Button variante="cinza" onClick={onCancelar}>Cancelar</Button>
            <Button variante="liquido" disabled={!validos.length || invalidos.length > 0} onClick={() => setConfirmando(true)}>Continuar</Button>
          </div>
        </>
      ) : (
        <>
          <div className="redir-resumo">
            <span className="redir-resumo__ic"><Icone nome="externo" tam={18} /></span>
            <div>
              <p className="redir-resumo__assunto">{assunto || "(sem assunto)"}</p>
              <p className="redir-resumo__para">Para {validos.join(", ")}</p>
            </div>
          </div>
          <div className="folha__rodape folha__rodape--lado">
            <Button variante="cinza" onClick={() => setConfirmando(false)}>Voltar</Button>
            <Button variante="liquido" disabled={ocupado} onClick={async () => { setOcupado(true); if (!(await onEnviar(validos))) setOcupado(false); }}>
              {ocupado ? "Redirecionando…" : "Redirecionar"}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}

interface Props {
  caixa: Caixa;
  pasta: string;
  uid: number;
  /** Removida desta pasta (arquivada, excluída, movida): quem chama escolhe a próxima. */
  onSaiu: (uid: number) => void;
  onLida: (uid: number, lida: boolean) => void;
  onEstrela: (uid: number, estrela: boolean) => void;
  voltar?: { rotulo: string; href: string };
  /** Pedido de ação vindo de atalho do teclado (muda o `n` a cada tecla). */
  comando?: { acao: string; n: number } | null;
}

export default function Leitura({ caixa, pasta, uid, onSaiu, onLida, onEstrela, voltar, comando }: Props) {
  const { caixas } = useCaixas();
  const { layout, escrever, pastas } = useShell();
  const acoes = useAcoes(caixa.id);
  const carga = useCarga<{ mensagem: Mensagem }>(`/api/caixas/${caixa.id}/mensagens/${uid}?pasta=${encodeURIComponent(pasta)}`);
  const m = carga.dados?.mensagem ?? null;
  const [cids, setCids] = useState<Record<string, string>>({});
  const [remotas, setRemotas] = useState(false);
  const [lida, setLida] = useState(true);
  const [fav, setFav] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [menu, setMenu] = useState<"mais" | "mover" | "responder" | null>(null);
  const [redirecionando, setRedirecionando] = useState(false);
  const refMais = useRef<HTMLButtonElement>(null);
  const refMover = useRef<HTMLButtonElement>(null);
  const uma = layout === "uma";

  useEffect(() => {
    if (!m) return;
    setLida(true);
    setFav(!!m.estrela);
    lembrarEnderecos([m.de, ...m.para, ...m.cc, ...m.responderPara]);
    let vivo = true;
    void carregarCids(caixa.id, m).then((c) => { if (vivo) setCids(c); });
    return () => { vivo = false; };
  }, [m, caixa.id]);

  const escuroOk = !!m && (!m.html || htmlSimples(m.html));
  const corpo = useMemo(() => {
    if (!m) return { doc: "", bloqueadas: 0 };
    const opc = { tema: escuroOk ? "auto" as const : "papel" as const, margem: uma ? "4px 20px 28px" : "4px 36px 40px" };
    if (m.html) {
      const s = sanitizarEmail(m.html, { permitirRemotas: remotas, cids });
      return { doc: documentoIframe(s.html, remotas, opc), bloqueadas: s.bloqueadas };
    }
    return { doc: documentoIframe(textoParaHtml(m.texto ?? ""), false, opc), bloqueadas: 0 };
  }, [m, remotas, cids, escuroOk, uma]);

  const naLixeira = acoes.tipoDe(pasta) === "lixeira";
  const ehSpam = acoes.tipoDe(pasta) === "spam";
  const resp = (modo: "responder" | "todos" | "encaminhar") => escrever({ caixaId: caixa.id, modo, pasta, uid });

  async function arquivar() { if (await acoes.arquivar(pasta, uid)) onSaiu(uid); }
  async function excluir() {
    if (naLixeira && !confirmar) { setConfirmar(true); return; }
    setConfirmar(false);
    if (await acoes.excluir(pasta, uid)) onSaiu(uid);
  }
  async function alternarLida() {
    const r = await acoes.marcarLida(pasta, uid, !lida);
    if (r !== null) { setLida(r); onLida(uid, r); }
  }
  async function alternarFav() {
    const r = await acoes.marcarEstrela(pasta, uid, !fav);
    if (r !== null) { setFav(r); onEstrela(uid, r); }
  }
  async function mover(destino: string) { setMenu(null); if (await acoes.mover(pasta, uid, destino)) onSaiu(uid); }
  async function marcarSpam() { if (await (ehSpam ? acoes.naoSpam(pasta, uid) : acoes.spam(pasta, uid))) onSaiu(uid); }

  // atalhos do teclado chegam como comando
  const ultimo = useRef(0);
  useEffect(() => {
    if (!comando || comando.n === ultimo.current || !m) return;
    ultimo.current = comando.n;
    const a = comando.acao;
    if (a === "responder" || a === "todos" || a === "encaminhar") resp(a);
    else if (a === "arquivar") void arquivar();
    else if (a === "excluir") void excluir();
    else if (a === "estrela") void alternarFav();
    else if (a === "naoLida") void alternarLida();
  }, [comando, m]); // eslint-disable-line react-hooks/exhaustive-deps

  const destinos = (pastas ?? []).filter((p) => p.caminho !== pasta);
  const itensMover: ItemMenu[] = destinos.map((p) => ({
    rotulo: p.nome, onClick: () => void mover(p.caminho),
    icone: p.tipo === "entrada" ? "entrada" : p.tipo === "arquivo" ? "arquivo" : p.tipo === "lixeira" ? "lixeira" : p.tipo === "spam" ? "spam" : p.tipo === "enviados" ? "enviados" : p.tipo === "rascunhos" ? "rascunhos" : "pasta",
  }));
  const itensMais: (ItemMenu | null)[] = [
    { icone: lida ? "naoLida" : "lida", rotulo: lida ? "Marcar como não lida" : "Marcar como lida", atalho: TECLA_DE.naoLida, onClick: () => void alternarLida() },
    { icone: "favoritos", rotulo: fav ? "Tirar estrela" : "Marcar com estrela", atalho: TECLA_DE.estrela, onClick: () => void alternarFav() },
    null,
    { icone: "externo", rotulo: "Redirecionar…", onClick: () => setRedirecionando(true) },
    ...(uma ? [{ icone: "mover" as const, rotulo: "Mover para…", onClick: () => setMenu("mover") }] : []),
    { icone: ehSpam ? "naoSpam" : "spam", rotulo: ehSpam ? "Não é spam" : "Marcar como spam", onClick: () => void marcarSpam() },
  ];

  if (!caixas) return null;
  const anexosVisiveis: Anexo[] = m ? m.anexos.filter((a) => !(a.cid && cids[a.cid])) : [];
  const nome = m ? nomeEndereco(m.de) : "";

  const barraTopo = (
    <div className="leitura__barra" role="toolbar" aria-label="Ações da mensagem">
      {voltar && (
        <Link className="voltar" to={voltar.href} aria-label={`Voltar para ${voltar.rotulo}`}>
          <Icone nome="voltar" tam={24} /><span>{voltar.rotulo}</span>
        </Link>
      )}
      {!uma && (
        <>
          <div className="barra-grupo">
            <BotaoIcone icone="responder" rotulo="Responder" atalho={TECLA_DE.responder} onClick={() => resp("responder")} disabled={!m} />
            <BotaoIcone icone="todos" rotulo="Responder a todos" atalho={TECLA_DE.todos} onClick={() => resp("todos")} disabled={!m} />
            <BotaoIcone icone="encaminhar" rotulo="Encaminhar" atalho={TECLA_DE.encaminhar} onClick={() => resp("encaminhar")} disabled={!m} />
          </div>
          <span className="barra-sep" aria-hidden="true" />
          <div className="barra-grupo">
            <BotaoIcone icone="arquivo" rotulo="Arquivar" atalho={TECLA_DE.arquivar} onClick={() => void arquivar()} disabled={!m} />
            <BotaoIcone icone="lixeira" rotulo="Excluir" atalho={TECLA_DE.excluir} onClick={() => void excluir()} disabled={!m} />
            <BotaoIcone ref={refMover} icone="mover" rotulo="Mover para" onClick={() => setMenu(menu === "mover" ? null : "mover")} disabled={!m} />
          </div>
        </>
      )}
      <span className="barra-esp" />
      <BotaoIcone icone="favoritos" rotulo={fav ? "Tirar estrela" : "Marcar com estrela"} atalho={uma ? undefined : TECLA_DE.estrela}
        className={fav ? "bico--estrela" : ""} onClick={() => void alternarFav()} disabled={!m} />
      <BotaoIcone ref={refMais} icone="mais" rotulo="Mais ações" onClick={() => setMenu(menu === "mais" ? null : "mais")} disabled={!m} />
    </div>
  );

  return (
    <article className="leitura" aria-label="Mensagem">
      {barraTopo}
      <div className="leitura__rolagem">
        {carga.precisaSenha && <div className="leitura__avisos"><BannerSenha caixa={caixa} /></div>}
        {carga.erro && !carga.precisaSenha && <div className="leitura__avisos"><p className="aviso aviso--perigo" role="alert"><Icone nome="alerta" tam={16} />{carga.erro}</p></div>}
        {!m && !carga.erro && <EsqueletoLeitura />}
        {m && (
          <>
            <header className="leitura__cab">
              <h1 className="leitura__assunto">{m.assunto || "(sem assunto)"}</h1>
              {m.suspeita && (
                <div className="aviso aviso--perigo" role="alert">
                  <Icone nome="spam" tam={16} />
                  <span><strong>Possível {m.suspeita.classe}.</strong> {m.suspeita.motivo}</span>
                </div>
              )}
              <div className="leitura__de">
                <Monograma nome={nome} tam={42} />
                <div className="leitura__de-txt">
                  <div className="leitura__de-l1">
                    <span className="leitura__nome">{nome}</span>
                    {m.de?.nome && <span className="leitura__end">{m.de.endereco}</span>}
                  </div>
                  <div className="leitura__para">
                    {m.para.length > 0 && <span>Para: {listaEnd(m.para)}</span>}
                    {m.cc.length > 0 && <span> · Cc: {listaEnd(m.cc)}</span>}
                  </div>
                </div>
                <time className="leitura__data" dateTime={m.data ?? undefined}>{dataLonga(m.data)}</time>
              </div>
              {anexosVisiveis.length > 0 && (
                <div className="anexos" aria-label="Anexos">
                  {anexosVisiveis.map((a) => <ChipAnexo key={a.parte} a={a} href={urlAnexo(caixa.id, m.pasta, m.uid, a.parte)} />)}
                </div>
              )}
              {corpo.bloqueadas > 0 && !remotas && (
                <div className="aviso">
                  <Icone nome="imagem" tam={16} />
                  <span>{corpo.bloqueadas === 1 ? "1 imagem remota bloqueada" : `${corpo.bloqueadas} imagens remotas bloqueadas`} para evitar rastreamento.</span>
                  <button type="button" className="aviso__acao" onClick={() => setRemotas(true)}>Carregar imagens</button>
                </div>
              )}
            </header>
            <iframe className={`corpo-email${escuroOk ? "" : " corpo-email--papel"}`} title="Conteúdo do e-mail"
              sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={corpo.doc} />
          </>
        )}
      </div>

      {uma && (
        <div className="barra-base" role="toolbar" aria-label="Ações">
          <BotaoIcone icone="lixeira" rotulo="Excluir" tam={22} onClick={() => void excluir()} disabled={!m} />
          <BotaoIcone icone="mover" rotulo="Mover para" tam={22} onClick={() => setMenu("mover")} disabled={!m} />
          <BotaoIcone icone="arquivo" rotulo="Arquivar" tam={22} onClick={() => void arquivar()} disabled={!m} />
          <BotaoIcone icone="responder" rotulo="Responder" tam={22} onClick={() => setMenu("responder")} disabled={!m} />
          <BotaoIcone icone="escrever" rotulo="Nova mensagem" tam={22} onClick={() => escrever({ caixaId: caixa.id })} />
        </div>
      )}

      {uma ? (
        <>
          <Sheet aberto={menu === "mais"} onFechar={() => setMenu(null)} rotulo="Mais ações">
            <Menu rotulo="Mais ações" itens={itensMais} onEscolher={() => setMenu(null)} />
          </Sheet>
          <Sheet aberto={menu === "responder"} onFechar={() => setMenu(null)} rotulo="Responder">
            <Menu rotulo="Responder" onEscolher={() => setMenu(null)} itens={[
              { icone: "responder", rotulo: "Responder", onClick: () => resp("responder") },
              { icone: "todos", rotulo: "Responder a todos", onClick: () => resp("todos") },
              { icone: "encaminhar", rotulo: "Encaminhar", onClick: () => resp("encaminhar") },
            ]} />
          </Sheet>
          <Sheet aberto={menu === "mover"} onFechar={() => setMenu(null)} rotulo="Mover para" titulo="Mover para">
            <Menu rotulo="Pastas" itens={itensMover} />
          </Sheet>
        </>
      ) : (
        <>
          <Popover aberto={menu === "mais"} onFechar={() => setMenu(null)} ancora={refMais} rotulo="Mais ações" alinhar="fim" largura={250}>
            <Menu rotulo="Mais ações" itens={itensMais} onEscolher={() => setMenu(null)} />
          </Popover>
          <Popover aberto={menu === "mover"} onFechar={() => setMenu(null)} ancora={refMover} rotulo="Mover para" largura={230}>
            <Menu rotulo="Pastas" itens={itensMover} />
          </Popover>
        </>
      )}
      {redirecionando && (
        <DialogoRedirecionar assunto={m?.assunto ?? ""} de={m?.de?.endereco ?? ""} onCancelar={() => setRedirecionando(false)}
          onEnviar={async (para) => { const ok = await acoes.redirecionar(pasta, uid, para); if (ok) setRedirecionando(false); return ok; }} />
      )}
      {confirmar && (
        <ConfirmDialog titulo="Apagar definitivamente?" rotuloConfirmar="Apagar"
          texto="A mensagem será apagada do servidor e não poderá ser recuperada."
          onCancelar={() => setConfirmar(false)} onConfirmar={() => void excluir()} />
      )}
    </article>
  );
}
