import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, Badge, Button, Campo, Grupo, ListRow } from "../ui";
import { api } from "../api";
import { useCaixas } from "../caixas";
import { erroMsg } from "../lib";
import { nomeCaixa } from "../marca";
import type { Caixa, EstadoCaixa, ResultadoTeste } from "../tipos";
import Pagina from "./Pagina";

export const ROTULO_ESTADO: Record<EstadoCaixa, { texto: string; tom: "ok" | "aviso" | "perigo" }> = {
  ok: { texto: "conectada", tom: "ok" },
  erro: { texto: "sem conexão", tom: "aviso" },
  precisa_senha: { texto: "senha recusada", tom: "perigo" },
};

export function textoTeste(t: ResultadoTeste): string {
  if (t.imap && t.smtp) return "Conexão testada: IMAP e SMTP ok.";
  if (t.falhaAutenticacao) return "O servidor recusou a senha desta caixa.";
  return `Falha no teste de conexão${t.erro ? `: ${t.erro}` : ""}.`;
}

function NovaCaixa({ aoCriar }: { aoCriar: (c: Caixa) => void }) {
  const [endereco, setEndereco] = useState("");
  const [nome, setNome] = useState("");
  const [senha, setSenha] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true); setErro(""); setResultado(null);
    try {
      const r = await api.post<{ caixa: Caixa; teste: ResultadoTeste }>("/api/caixas", {
        endereco: endereco.trim(), senha, ...(nome.trim() ? { nome_exibicao: nome.trim() } : {}),
      });
      setResultado({ ok: r.teste.imap && r.teste.smtp, texto: textoTeste(r.teste) });
      setEndereco(""); setNome(""); setSenha("");
      aoCriar(r.caixa);
    } catch (x) {
      setErro(erroMsg(x));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Grupo titulo="Adicionar caixa" nota="A senha fica cifrada no servidor do Correio e é testada antes de salvar.">
      <form className="form" onSubmit={enviar} aria-label="Adicionar caixa">
        <Campo rotulo="Endereço">
          <input className="campo" type="email" required autoComplete="off" placeholder="contato@dominio.com.br"
            aria-label="Endereço" value={endereco} onChange={(e) => setEndereco(e.target.value)} />
        </Campo>
        <Campo rotulo="Nome de exibição" ajuda="Opcional. Aparece na barra lateral e no remetente.">
          <input className="campo" aria-label="Nome" value={nome} maxLength={100} onChange={(e) => setNome(e.target.value)} />
        </Campo>
        <Campo rotulo="Senha da caixa">
          <input className="campo" type="password" required autoComplete="new-password" aria-label="Senha" value={senha} onChange={(e) => setSenha(e.target.value)} />
        </Campo>
        <Button type="submit" variante="liquido" disabled={ocupado}>{ocupado ? "Testando conexão…" : "Adicionar e testar"}</Button>
        {erro && <p className="txt-perigo" role="alert">{erro}</p>}
        {resultado && <p className={resultado.ok ? "txt-ok" : "txt-aviso"} role="status">{resultado.texto}</p>}
      </form>
    </Grupo>
  );
}

interface Importacao { total: number; importadas: number; resultado: { endereco: string; estado: string; detalhe?: string }[] }
const ESTADO_IMPORT: Record<string, string> = {
  importada: "importada", ja_existia: "já estava no Correio", senha_diferente: "senha diferente (adicione à mão)",
  desativada_no_poste: "desativada no poste.io", nao_tentada: "não tentada", erro: "erro",
};

function ImportarPoste({ aoImportar }: { aoImportar: () => void }) {
  const [senha, setSenha] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [r, setR] = useState<Importacao | null>(null);
  async function importar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true); setErro(""); setR(null);
    try {
      const x = await api.post<Importacao>("/api/caixas/importar-poste", senha ? { senha } : {});
      setR(x);
      aoImportar();
    } catch (x) { setErro(erroMsg(x)); } finally { setOcupado(false); }
  }
  return (
    <Grupo titulo="Importar do poste.io" nota="Traz todas as caixas criadas no poste.io que ainda não estão aqui. Usa a senha padrão do servidor, ou a que você digitar; caixa com outra senha fica de fora para você adicionar à mão.">
      <form className="form" onSubmit={importar} aria-label="Importar do poste.io">
        <Campo rotulo="Senha das caixas" ajuda="Opcional: vazio usa a senha padrão configurada no servidor.">
          <input className="campo" type="password" autoComplete="off" aria-label="Senha das caixas" value={senha} onChange={(e) => setSenha(e.target.value)} />
        </Campo>
        <Button type="submit" variante="cinza" disabled={ocupado}>{ocupado ? "Importando e testando…" : "Importar caixas do poste.io"}</Button>
        {erro && <p className="txt-perigo" role="alert">{erro}</p>}
        {r && (
          <div role="status">
            <p className="txt-ok">{r.importadas} de {r.total} caixas importadas.</p>
            <ul className="txt-nota" style={{ margin: 0, paddingLeft: 18 }}>
              {r.resultado.filter((x) => x.estado !== "ja_existia").map((x) => <li key={x.endereco}>{x.endereco}: {ESTADO_IMPORT[x.estado] ?? x.estado}</li>)}
            </ul>
          </div>
        )}
      </form>
    </Grupo>
  );
}

export default function Caixas() {
  const { caixas, erro, recarregar, versao } = useCaixas();
  const nav = useNavigate();
  return (
    <Pagina titulo="Caixas" sub="Os endereços que o Correio lê e de onde envia.">
      {erro && <p className="txt-perigo" role="alert">{erro}</p>}
      {caixas && caixas.length > 0 && (
        <Grupo>
          {caixas.map((c) => (
            <ListRow key={c.id} seta icone={<Avatar caixa={c} tam={36} versao={versao} />}
              titulo={nomeCaixa(c)} detalhe={c.endereco}
              onClick={() => nav(`/c/${c.id}`)}
              fim={<Badge tom={ROTULO_ESTADO[c.estado].tom}>{c.estado_motivo || ROTULO_ESTADO[c.estado].texto}</Badge>} />
          ))}
        </Grupo>
      )}
      {caixas && caixas.length === 0 && <p className="pagina__vazio">Nenhuma caixa ainda. Adicione a primeira abaixo.</p>}
      <NovaCaixa aoCriar={() => void recarregar()} />
      <ImportarPoste aoImportar={() => void recarregar()} />
    </Pagina>
  );
}
