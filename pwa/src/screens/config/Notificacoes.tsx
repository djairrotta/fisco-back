import { useEffect, useState } from "react";
import { Card, ListRow, Toggle } from "../../ui";
import { api } from "../../api";
import { erroMsg, useCarga } from "../../lib";
import { ROTULO_TIPO } from "./rotulos";

interface Cfg { tipo: string; push: boolean; whatsapp: boolean }

export default function Notificacoes() {
  const { dados } = useCarga<Cfg[]>("/api/config/notificacoes");
  const [lista, setLista] = useState<Cfg[]>([]);
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { if (dados) setLista(dados); }, [dados]);

  async function mudar(tipo: string, campo: "push" | "whatsapp", v: boolean) {
    const antes = lista;
    const novo = lista.map((x) => (x.tipo === tipo ? { ...x, [campo]: v } : x));
    setLista(novo); setErro(""); setOcupado(true);
    try {
      await api.put("/api/config/notificacoes", novo.map(({ tipo, push, whatsapp }) => ({ tipo, push, whatsapp })));
    } catch (e) {
      setLista(antes); setErro(erroMsg(e));
    } finally {
      setOcupado(false);
    }
  }

  if (!lista.length) return null;
  return (
    <>
      <h2 className="secao">Notificações</h2>
      <Card>
        {erro && <p className="erro-txt" role="alert">{erro}</p>}
        {lista.map((x) => {
          const nome = ROTULO_TIPO[x.tipo] ?? x.tipo;
          return (
            <ListRow key={x.tipo} titulo={nome}
              fim={<>
                <span className="row__detalhe">Push</span>
                <Toggle disabled={ocupado} rotulo={`${nome}: Push`} ligado={x.push} onChange={(v) => mudar(x.tipo, "push", v)} />
                <span className="row__detalhe">WhatsApp</span>
                <Toggle disabled={ocupado} rotulo={`${nome}: WhatsApp`} ligado={x.whatsapp} onChange={(v) => mudar(x.tipo, "whatsapp", v)} />
              </>} />
          );
        })}
      </Card>
    </>
  );
}
