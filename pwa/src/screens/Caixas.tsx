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
    </Pagina>
  );
}
