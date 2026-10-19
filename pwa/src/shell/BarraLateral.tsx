import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Avatar, BotaoIcone, Button, ConfirmDialog, Icone, Menu, Popover, useToast, type NomeIcone } from "../ui";
import { api2, type PastaContada, type TipoPasta } from "../api2";
import { erroMsg } from "../lib";
import { useCaixas } from "../caixas";
import { nomeCaixa } from "../marca";
import { FAVORITOS, SAIDA, useShell } from "./contexto";
import { TECLA_DE } from "./atalhos";
import type { Caixa } from "../tipos";

interface Especial {
  chave: TipoPasta | typeof FAVORITOS | typeof SAIDA;
  rotulo: string;
  icone: NomeIcone;
  /** Qual número mostrar: não lidas (padrão), total ou nenhum. */
  conta: "naoLidas" | "total" | null;
}

export const ESPECIAIS: Especial[] = [
  { chave: "entrada", rotulo: "Entrada", icone: "entrada", conta: "naoLidas" },
  { chave: FAVORITOS, rotulo: "Favoritos", icone: "favoritos", conta: null },
  { chave: "rascunhos", rotulo: "Rascunhos", icone: "rascunhos", conta: "total" },
  { chave: SAIDA, rotulo: "Caixa de saída", icone: "saida", conta: "total" },
  { chave: "enviados", rotulo: "Enviados", icone: "enviados", conta: null },
  { chave: "arquivo", rotulo: "Arquivo", icone: "arquivo", conta: null },
  { chave: "spam", rotulo: "Spam", icone: "spam", conta: "naoLidas" },
  { chave: "lixeira", rotulo: "Lixeira", icone: "lixeira", conta: null },
];

export interface ItemPasta {
  caminho: string;
  rotulo: string;
  icone: NomeIcone;
  contagem?: number;
  rotuloContagem?: string;
  /** Pasta do usuário (pode renomear/excluir). */
  propria?: boolean;
  nivel?: number;
}

/** Monta as seções da barra lateral a partir das pastas do servidor. */
export function montarPastas(pastas: PastaContada[] | null, saida?: number): { especiais: ItemPasta[]; proprias: ItemPasta[] } {
  const lista: PastaContada[] = pastas ?? [{ caminho: "INBOX", nome: "Entrada", tipo: "entrada" }];
  const especiais: ItemPasta[] = [];
  for (const e of ESPECIAIS) {
    if (e.chave === FAVORITOS) { especiais.push({ caminho: FAVORITOS, rotulo: e.rotulo, icone: e.icone }); continue; }
    if (e.chave === SAIDA) {
      especiais.push({ caminho: SAIDA, rotulo: e.rotulo, icone: e.icone, ...(saida ? { contagem: saida, rotuloContagem: `${saida} na fila` } : {}) });
      continue;
    }
    const p = lista.find((x) => x.tipo === e.chave) ?? (e.chave === "entrada" ? { caminho: "INBOX", nome: "Entrada", tipo: "entrada" as const } : null);
    if (!p) continue;
    const n = e.conta ? p[e.conta] : undefined;
    especiais.push({
      caminho: p.caminho, rotulo: e.rotulo, icone: e.icone,
      ...(n ? { contagem: n, rotuloContagem: e.conta === "total" ? `${n} no total` : `${n} não lidas` } : {}),
    });
  }
  const proprias = lista
    .filter((p) => !p.tipo && !p.protegida && p.caminho.toUpperCase() !== "INBOX")
    .map((p) => ({
      caminho: p.caminho, rotulo: p.nome.split(" / ").pop() ?? p.nome, icone: "pasta" as const, propria: true,
      nivel: p.nome.split(" / ").length - 1,
      ...(p.naoLidas ? { contagem: p.naoLidas, rotuloContagem: `${p.naoLidas} não lidas` } : {}),
    }));
  return { especiais, proprias };
}

const fmt = (n: number) => (n > 9999 ? `${Math.round(n / 1000)} mil` : n.toLocaleString("pt-BR"));

function Item({ p, ativo, onClick, onRenomear, onExcluir, editando, onFimEdicao }: {
  p: ItemPasta; ativo: boolean; onClick: () => void;
  onRenomear?: () => void; onExcluir?: () => void; editando?: boolean; onFimEdicao?: (nome: string | null) => void;
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (editando) {
    return (
      <li>
        <CampoPasta inicial={p.rotulo} icone={p.icone} rotulo={`Renomear ${p.rotulo}`} onFim={(v) => onFimEdicao?.(v)} />
      </li>
    );
  }
  return (
    <li className="lat-li" style={p.nivel ? { paddingLeft: p.nivel * 14 } : undefined}>
      <button type="button" className={`lat-item${ativo ? " lat-item--ativo" : ""}`} aria-current={ativo ? "page" : undefined} onClick={onClick}
        onContextMenu={p.propria ? (e) => { e.preventDefault(); setMenu(true); } : undefined}>
        <Icone nome={p.icone} tam={17} />
        <span className="lat-item__rot">{p.rotulo}</span>
        {p.contagem ? <span className="lat-item__cont" aria-label={p.rotuloContagem}>{fmt(p.contagem)}</span> : null}
      </button>
      {p.propria && (
        <>
          <BotaoIcone ref={ref} icone="mais" rotulo={`Opções de ${p.rotulo}`} tam={15} className="lat-item__mais" onClick={() => setMenu((v) => !v)} />
          <Popover aberto={menu} onFechar={() => setMenu(false)} ancora={ref} rotulo={`Opções de ${p.rotulo}`} largura={190}>
            <Menu rotulo={`Opções de ${p.rotulo}`} onEscolher={() => setMenu(false)} itens={[
              { icone: "caneta", rotulo: "Renomear", onClick: () => onRenomear?.() },
              { icone: "lixeira", rotulo: "Excluir pasta", perigo: true, onClick: () => onExcluir?.() },
            ]} />
          </Popover>
        </>
      )}
    </li>
  );
}

/** Campo inline para criar ou renomear uma pasta (Enter confirma, Esc cancela). */
function CampoPasta({ inicial, icone, rotulo, onFim }: { inicial: string; icone: NomeIcone; rotulo: string; onFim: (nome: string | null) => void }) {
  const [v, setV] = useState(inicial);
  const feito = useRef(false);
  const fim = (nome: string | null) => { if (feito.current) return; feito.current = true; onFim(nome); };
  return (
    <div className="lat-item lat-item--edit">
      <Icone nome={icone} tam={17} />
      <input className="lat-item__in" autoFocus aria-label={rotulo} value={v} maxLength={100} onFocus={(e) => e.target.select()}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); fim(v.trim() || null); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fim(null); }
        }}
        onBlur={() => fim(v.trim() && v.trim() !== inicial ? v.trim() : null)} />
    </div>
  );
}

/** Lista de caixas (popover no Mac, folha no iPhone). */
export function ListaCaixas({ ativa, onEscolher, compacta }: { ativa: Caixa | null; onEscolher: (c: Caixa) => void; compacta?: boolean }) {
  const { caixas, versao } = useCaixas();
  return (
    <ul className={`caixas-lista${compacta ? " caixas-lista--compacta" : ""}`} aria-label="Caixas">
      {(caixas ?? []).map((c) => (
        <li key={c.id}>
          <button type="button" className={`caixa-opcao${c.id === ativa?.id ? " caixa-opcao--ativa" : ""}`}
            aria-current={c.id === ativa?.id ? "true" : undefined} onClick={() => onEscolher(c)}>
            <Avatar caixa={c} tam={compacta ? 30 : 42} versao={versao} />
            <span className="caixa-opcao__txt">
              <span className="caixa-opcao__nome">{nomeCaixa(c)}</span>
              <span className="caixa-opcao__end">{c.endereco}</span>
            </span>
            {c.estado !== "ok" && <span className="caixa-opcao__aviso" title={c.estado === "precisa_senha" ? "Senha recusada" : "Sem conexão"}><Icone nome="alerta" tam={15} /></span>}
            {c.id === ativa?.id && <Icone nome="ok" tam={16} className="caixa-opcao__ok" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TrocaCaixa({ ativa }: { ativa: Caixa | null }) {
  const { versao } = useCaixas();
  const nav = useNavigate();
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!ativa) return null;
  return (
    <>
      <button ref={ref} type="button" className="troca" aria-label="Trocar de caixa" aria-haspopup="dialog" aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}>
        <Avatar caixa={ativa} tam={30} versao={versao} />
        <span className="troca__txt">
          <span className="troca__nome">{nomeCaixa(ativa)}</span>
          <span className="troca__end">{ativa.endereco}</span>
        </span>
        <Icone nome="trocar" tam={15} className="troca__seta" />
      </button>
      <Popover aberto={aberto} onFechar={() => setAberto(false)} ancora={ref} rotulo="Caixas" largura={292}>
        <ListaCaixas ativa={ativa} compacta onEscolher={(c) => { setAberto(false); nav(`/c/${c.id}`); }} />
        <Menu rotulo="Gerenciar" onEscolher={() => setAberto(false)} itens={[
          null,
          { icone: "ajustes", rotulo: "Ajustes desta caixa", onClick: () => nav(`/c/${ativa.id}/config`) },
          { icone: "mais_", rotulo: "Adicionar ou gerenciar caixas", onClick: () => nav("/caixas") },
        ]} />
      </Popover>
    </>
  );
}

export default function BarraLateral({ aoNavegar }: { aoNavegar?: () => void }) {
  const { ativa, layout, pastas, escrever, recarregarPastas } = useShell();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const [saida, setSaida] = useState<number | undefined>();
  useEffect(() => {
    if (!ativa) return;
    let vivo = true;
    api2.listarSaida(ativa.id).then((r) => { if (vivo) setSaida(r.length); }).catch(() => {});
    return () => { vivo = false; };
  }, [ativa?.id, pastas]); // eslint-disable-line react-hooks/exhaustive-deps

  const { mostrar } = useToast();
  const [criando, setCriando] = useState(false);
  const [renomeando, setRenomeando] = useState<string | null>(null);
  const [excluindo, setExcluindo] = useState<ItemPasta | null>(null);
  const falha = (e: unknown) => mostrar(erroMsg(e), { tom: "perigo", icone: "alerta" });
  async function criar(nome: string | null) {
    setCriando(false);
    if (!nome || !ativa) return;
    try { await api2.criarPasta(ativa.id, nome); mostrar(`Pasta “${nome}” criada`, { icone: "pasta" }); recarregarPastas(); } catch (e) { falha(e); }
  }
  async function renomear(caminho: string, nome: string | null) {
    setRenomeando(null);
    if (!nome || !ativa) return;
    try {
      const r = await api2.renomearPasta(ativa.id, caminho, nome);
      recarregarPastas();
      if (atual === caminho) nav(`/c/${ativa.id}?pasta=${encodeURIComponent(r.caminho)}`, { replace: true });
    } catch (e) { falha(e); }
  }
  async function excluir(p: ItemPasta) {
    setExcluindo(null);
    if (!ativa) return;
    try {
      await api2.excluirPasta(ativa.id, p.caminho);
      mostrar(`Pasta “${p.rotulo}” excluída`, { icone: "lixeira" });
      recarregarPastas();
      if (atual === p.caminho) nav(`/c/${ativa.id}`, { replace: true });
    } catch (e) { falha(e); }
  }

  const { especiais, proprias } = montarPastas(pastas, saida);
  const naCaixa = !!ativa && pathname.startsWith(`/c/${ativa.id}`) && !pathname.endsWith("/config");
  const msg = pathname.match(/^\/c\/\d+\/m\/(.+)\/\d+$/);
  const atual = params.get("pasta") ?? (msg ? decodeURIComponent(msg[1]) : "INBOX");
  const ir = (caminho: string) => {
    aoNavegar?.();
    if (!ativa) return;
    nav(caminho === "INBOX" ? `/c/${ativa.id}` : `/c/${ativa.id}?pasta=${encodeURIComponent(caminho)}`);
  };
  const desktop = layout !== "uma";

  return (
    <nav className="lat" aria-label="Pastas">
      <div className="lat__topo">
        <TrocaCaixa ativa={ativa} />
        {desktop && ativa && (
          <Button variante="liquido" bloco icone="escrever" className="lat__escrever" title={`Escrever (${TECLA_DE.escrever})`}
            onClick={() => { aoNavegar?.(); escrever(); }}>
            Escrever
          </Button>
        )}
      </div>
      <div className="lat__rolagem">
        <ul className="lat__lista" aria-label="Caixa">
          {especiais.map((p) => <Item key={p.caminho} p={p} ativo={naCaixa && atual === p.caminho} onClick={() => ir(p.caminho)} />)}
        </ul>
        <div className="lat__secao-l">
          <h3 className="lat__secao">Pastas</h3>
          {ativa && <BotaoIcone icone="mais_" rotulo="Nova pasta" tam={15} className="lat__nova" onClick={() => setCriando(true)} />}
        </div>
        <ul className="lat__lista" aria-label="Pastas próprias">
          {proprias.map((p) => (
            <Item key={p.caminho} p={p} ativo={naCaixa && atual === p.caminho} onClick={() => ir(p.caminho)}
              editando={renomeando === p.caminho} onRenomear={() => setRenomeando(p.caminho)} onExcluir={() => setExcluindo(p)}
              onFimEdicao={(nome) => void renomear(p.caminho, nome)} />
          ))}
          {criando && <li><CampoPasta inicial="" icone="pasta" rotulo="Nome da nova pasta" onFim={(n) => void criar(n)} /></li>}
          {!criando && proprias.length === 0 && <li className="lat__vazio">Crie pastas para organizar clientes e processos.</li>}
        </ul>
      </div>
      {excluindo && (
        <ConfirmDialog titulo={`Excluir “${excluindo.rotulo}”?`} rotuloConfirmar="Excluir"
          texto="Só pastas vazias podem ser excluídas. As mensagens nunca são apagadas junto."
          onCancelar={() => setExcluindo(null)} onConfirmar={() => void excluir(excluindo)} />
      )}
      {desktop && (
        <div className="lat__base">
          <button type="button" className={`lat-item${pathname === "/config" ? " lat-item--ativo" : ""}`} onClick={() => { aoNavegar?.(); nav("/config"); }}>
            <Icone nome="ajustes" tam={17} /><span className="lat-item__rot">Ajustes</span>
          </button>
        </div>
      )}
    </nav>
  );
}
