import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Avatar, Button, Campo, ConfirmDialog, Grupo, ListRow, Toggle } from "../ui";
import Pagina from "./Pagina";
import { api } from "../api";
import { useCaixa, useCaixas } from "../caixas";
import { erroMsg, useCarga } from "../lib";
import { corDoLogo, nomeCaixa, urlFavicon, urlLogo } from "../marca";
import type { Caixa, ResultadoTeste } from "../tipos";
import { textoTeste } from "./Caixas";
import { useShell } from "../shell/contexto";

type TipoImg = "logo" | "favicon";
export const MSG_IMAGEM = "PNG, JPEG ou WebP, até 2 MB";
const TIPOS_IMG = ["image/png", "image/jpeg", "image/webp"];
const ICO = ["image/x-icon", "image/vnd.microsoft.icon"];
const REGRAS: Record<TipoImg, { tipos: string[]; max: number; msg: string; accept: string; dica: string }> = {
  logo: { tipos: TIPOS_IMG, max: 2 * 1024 * 1024, msg: `${MSG_IMAGEM}.`, accept: "image/png,image/jpeg,image/webp", dica: MSG_IMAGEM },
  favicon: { tipos: [...TIPOS_IMG, ...ICO], max: 2 * 1024 * 1024, msg: `${MSG_IMAGEM} (ICO também).`, accept: "image/png,image/jpeg,image/webp,image/x-icon,.ico", dica: `${MSG_IMAGEM}; ICO também` },
};

/** Checagem rápida no aparelho (o servidor valida de novo pelos bytes). */
export function validarImagemLocal(f: { type: string; size: number; name: string }, tipo: TipoImg): string {
  const r = REGRAS[tipo];
  const ico = tipo === "favicon" && /\.ico$/i.test(f.name);
  if (!r.tipos.includes(f.type) && !ico) return r.msg;
  if (f.size > r.max) return r.msg;
  return "";
}

function UploadImagem({ caixa, tipo, aoEnviar }: { caixa: Caixa; tipo: TipoImg; aoEnviar: (c: Caixa) => void }) {
  const { versao } = useCaixas();
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<string | null>(null);
  const [erro, setErro] = useState("");
  const [ok, setOk] = useState("");
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => () => { if (previa) URL.revokeObjectURL(previa); }, [previa]);
  const atual = tipo === "logo" ? urlLogo(caixa, versao) : caixa.tem_favicon ? urlFavicon(caixa, versao) : null;

  function escolher(f: File | undefined) {
    setErro(""); setOk("");
    if (!f) return;
    const e = validarImagemLocal(f, tipo);
    if (e) { setErro(e); setArquivo(null); setPrevia(null); return; }
    setArquivo(f);
    setPrevia(URL.createObjectURL(f));
  }

  async function enviar() {
    if (!arquivo) return;
    setOcupado(true); setErro(""); setOk("");
    try {
      const form = new FormData();
      form.set("arquivo", arquivo, arquivo.name);
      const r = await api.form<{ caixa: Caixa }>("PUT", `/api/caixas/${caixa.id}/${tipo}`, form);
      aoEnviar(r.caixa);
      setArquivo(null); setPrevia(null);
      setOk(tipo === "logo" ? "Logo atualizado." : "Favicon atualizado.");
    } catch (e) {
      setErro(erroMsg(e));
    } finally {
      setOcupado(false);
    }
  }

  const rotulo = tipo === "logo" ? "Logo" : "Favicon";
  return (
    <div className="upload">
      <div className={`upload__img${tipo === "favicon" ? " upload__img--p" : ""}`}>
        {previa || atual ? <img src={previa ?? atual!} alt={`${rotulo} ${previa ? "(novo)" : "atual"}`} /> : <span className="upload__vazio">sem {rotulo.toLowerCase()}</span>}
      </div>
      <div className="upload__txt">
        <span className="row__titulo">{rotulo}</span>
        <span className="row__detalhe">{REGRAS[tipo].dica}</span>
        {erro && <span className="txt-perigo" role="alert">{erro}</span>}
        {ok && <span className="txt-ok" role="status">{ok}</span>}
      </div>
      <div className="upload__acoes">
        <label className="btn btn--cinza btn--p">
          <span className="btn__txt">Escolher…</span>
          <input type="file" hidden accept={REGRAS[tipo].accept} aria-label={`Escolher ${rotulo.toLowerCase()}`}
            onChange={(e) => escolher(e.target.files?.[0])} />
        </label>
        {arquivo && <Button variante="liquido" tam="p" disabled={ocupado} onClick={() => void enviar()}>{ocupado ? "Enviando…" : "Enviar"}</Button>}
      </div>
    </div>
  );
}

const TIPOS_NOTIF = [
  { tipo: "recebido", rotulo: "E-mail recebido" },
  { tipo: "enviado", rotulo: "E-mail enviado" },
  { tipo: "falha", rotulo: "Falha de envio ou conexão" },
] as const;
type Notif = Record<(typeof TIPOS_NOTIF)[number]["tipo"], boolean>;

export default function ConfigCaixa() {
  const id = Number(useParams().id);
  const caixa = useCaixa(id);
  const { caixas, atualizar, recarregar, novaVersao, versao } = useCaixas();
  const nav = useNavigate();
  const { layout } = useShell();
  const [nome, setNome] = useState("");
  const [senha, setSenha] = useState("");
  const [cor, setCor] = useState("#0a84ff");
  const [msg, setMsg] = useState<Record<string, { ok: boolean; t: string }>>({});
  const [confirmar, setConfirmar] = useState(false);
  const notif = useCarga<{ global: Notif; caixa: Notif | null }>(caixa ? `/api/config/notificacoes?caixa=${id}` : null);
  const [n, setN] = useState<Notif | null>(null);

  useEffect(() => {
    if (!caixa) return;
    setNome(caixa.nome_exibicao ?? "");
    setCor(caixa.cor ?? "#0a84ff");
  }, [caixa?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (notif.dados?.caixa) setN(notif.dados.caixa); }, [notif.dados]);


  if (!caixa) return caixas === null ? null : <Pagina titulo="Caixa não encontrada"><p className="pagina__vazio">Ela pode ter sido removida.</p></Pagina>;
  const aviso = (k: string, ok: boolean, t: string) => setMsg((m) => ({ ...m, [k]: { ok, t } }));
  const Aviso = ({ k }: { k: string }) =>
    msg[k] ? <p className={`row-nota ${msg[k].ok ? "txt-ok" : "txt-perigo"}`} role={msg[k].ok ? "status" : "alert"}>{msg[k].t}</p> : null;

  async function patch(k: string, corpo: Record<string, unknown>, sucesso: string) {
    try {
      const r = await api.patch<{ caixa: Caixa; teste?: ResultadoTeste }>(`/api/caixas/${id}`, corpo);
      atualizar(r.caixa);
      if (r.teste) aviso(k, r.teste.imap && r.teste.smtp, textoTeste(r.teste));
      else aviso(k, true, sucesso);
      return true;
    } catch (e) {
      aviso(k, false, erroMsg(e));
      return false;
    }
  }

  async function testar() {
    aviso("senha", true, "Testando…");
    try {
      const r = await api.post<{ caixa: Caixa; teste: ResultadoTeste }>(`/api/caixas/${id}/testar`, {});
      atualizar(r.caixa);
      aviso("senha", r.teste.imap && r.teste.smtp, textoTeste(r.teste));
    } catch (e) { aviso("senha", false, erroMsg(e)); }
  }

  async function usarCorDoLogo() {
    const url = urlLogo(caixa!, versao);
    if (!url) { aviso("cor", false, "Envie um logo primeiro."); return; }
    try {
      const c = await corDoLogo(url);
      if (!c) { aviso("cor", false, "Não encontrei uma cor predominante no logo."); return; }
      setCor(c);
      aviso("cor", true, `Cor do logo: ${c}. Toque em Salvar cor para aplicar.`);
    } catch (e) { aviso("cor", false, erroMsg(e)); }
  }



  async function alternarNotif(tipo: keyof Notif, ativo: boolean) {
    setN((x) => (x ? { ...x, [tipo]: ativo } : x));
    try {
      await api.put("/api/config/notificacoes", { caixa: id, tipo, ativo });
    } catch (e) {
      setN((x) => (x ? { ...x, [tipo]: !ativo } : x));
      aviso("notif", false, erroMsg(e));
    }
  }

  async function remover() {
    setConfirmar(false);
    try {
      await api.del(`/api/caixas/${id}`);
      await recarregar();
      nav("/caixas", { replace: true });
    } catch (e) { aviso("remover", false, erroMsg(e)); }
  }

  return (
    <Pagina titulo={nomeCaixa(caixa)} sub={caixa.endereco}
      voltar={layout === "uma" ? { rotulo: "Ajustes", href: "/config" } : undefined}
      acao={<Button variante="cinza" tam="p" icone="entrada" onClick={() => nav(`/c/${id}`)}>Abrir caixa</Button>}>
      <div className="pagina__marca"><Avatar caixa={caixa} tam={56} versao={versao} /></div>

      <Grupo titulo="Conta">
        <div className="row-form">
          <Campo rotulo="Nome de exibição">
            <span className="campo-linha">
              <input className="campo" value={nome} maxLength={100} onChange={(e) => setNome(e.target.value)} aria-label="Nome de exibição" />
              <Button variante="cinza" onClick={() => void patch("nome", { nome_exibicao: nome.trim() }, "Nome salvo.")}>Salvar</Button>
            </span>
          </Campo>
          <Aviso k="nome" />
          <Campo rotulo="Nova senha da caixa">
            <input className="campo" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} aria-label="Nova senha" />
          </Campo>
          <div className="linha-botoes">
            <Button variante="liquido" tam="p" disabled={!senha} onClick={async () => { if (await patch("senha", { senha }, "Senha salva.")) setSenha(""); }}>Salvar e testar</Button>
            <Button variante="cinza" tam="p" onClick={() => void testar()}>Testar conexão</Button>
          </div>
          <Aviso k="senha" />
        </div>
      </Grupo>

      <Grupo titulo="Marca" nota="A cor da caixa vira o destaque do Correio quando ela está aberta.">
        <UploadImagem caixa={caixa} tipo="logo" aoEnviar={(c) => { atualizar(c); novaVersao(); }} />
        <UploadImagem caixa={caixa} tipo="favicon" aoEnviar={(c) => { atualizar(c); novaVersao(); }} />
        <div className="row-form">
          <Campo rotulo="Cor">
            <span className="campo-linha">
              <input type="color" className="cor-amostra" value={/^#[0-9a-f]{6}$/i.test(cor) ? cor : "#0a84ff"} onChange={(e) => setCor(e.target.value)} aria-label="Cor da caixa" />
              <input className="campo campo--hex" value={cor} maxLength={7} aria-label="Cor em hexadecimal" onChange={(e) => setCor(e.target.value.trim())} />
            </span>
          </Campo>
          <div className="linha-botoes">
            <Button variante="liquido" tam="p" onClick={() => {
              if (!/^#[0-9a-f]{6}$/i.test(cor)) { aviso("cor", false, "Cor deve ser #rrggbb."); return; }
              void patch("cor", { cor }, "Cor salva.");
            }}>Salvar cor</Button>
            <Button variante="cinza" tam="p" onClick={() => void usarCorDoLogo()}>Usar cor do logo</Button>
            <Button variante="simples" tam="p" onClick={() => void patch("cor", { cor: null }, "Cor removida (padrão do Correio).")}>Sem cor</Button>
          </div>
          <Aviso k="cor" />
        </div>
      </Grupo>

      <Grupo titulo="Mensagens" nota="Assinaturas com modelos e padrões; encaminhamento e resposta automática no servidor.">
        <ListRow icone="assinatura" titulo="Assinaturas" detalhe="Estúdio com quatro modelos, prévia clara e escura" seta onClick={() => nav(`/c/${id}/assinaturas`)} />
        <ListRow icone="regras" titulo="Encaminhamento e resposta automática" detalhe="Regras aplicadas pelo servidor de e-mail" seta onClick={() => nav(`/c/${id}/regras`)} />
      </Grupo>

      <Grupo titulo="Notificações desta caixa">
        {notif.erro && <p className="row-nota txt-perigo" role="alert">{notif.erro}</p>}
        {n && TIPOS_NOTIF.map((t) => (
          <ListRow key={t.tipo} titulo={t.rotulo}
            fim={<Toggle rotulo={t.rotulo} ligado={n[t.tipo]} onChange={(v) => void alternarNotif(t.tipo, v)} />} />
        ))}
        <Aviso k="notif" />
      </Grupo>

      <Grupo nota="Só tira a caixa deste app; nada é apagado no servidor de e-mail.">
        <button type="button" className="row row--click row--perigo" onClick={() => setConfirmar(true)}>
          <span className="row__main"><span className="row__titulo">Remover caixa do Correio</span></span>
        </button>
        <Aviso k="remover" />
      </Grupo>
      {confirmar && (
        <ConfirmDialog titulo="Remover caixa?" rotuloConfirmar="Remover" texto={`${caixa.endereco} sairá do Correio (senha, marca e assinatura).`}
          onCancelar={() => setConfirmar(false)} onConfirmar={() => void remover()} />
      )}
    </Pagina>
  );
}
