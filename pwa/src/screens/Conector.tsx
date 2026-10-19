import { useState } from "react";
import { Badge, Button, Card, ListRow } from "../ui";
import { api } from "../api";
import { dataHora, erroMsg, useCarga } from "../lib";

type Estado = "pendente" | "temporario" | "permanente" | "bloqueado";
interface Pedido {
  id: number;
  faixa: string;
  ip: string | null;
  origem: string;
  caminho: string;
  estado: Estado;
  criado: string;
  decidido: string | null;
}
interface Dados {
  pedidos: Pedido[];
}

const ESTADO: Record<Estado, { rotulo: string; tom: "perigo" | "aviso" | "ok" | "neutro" }> = {
  pendente: { rotulo: "Aguardando", tom: "aviso" },
  temporario: { rotulo: "Temporário", tom: "neutro" },
  permanente: { rotulo: "Permanente", tom: "ok" },
  bloqueado: { rotulo: "Bloqueado", tom: "perigo" },
};

export default function Conector() {
  const d = useCarga<Dados>("/api/conector", 15_000);
  const [msg, setMsg] = useState("");
  const [falha, setFalha] = useState("");
  const [ocupado, setOcupado] = useState<number | null>(null);

  async function decidir(p: Pedido, modo: "temporario" | "permanente" | "bloquear") {
    setMsg(""); setFalha(""); setOcupado(p.id);
    try {
      const r = await api.post<{ faixa: string; estado: Estado }>(
        `/api/conector/pedidos/${p.id}/decidir`,
        { modo },
      );
      setMsg(`${r.faixa}: ${ESTADO[r.estado].rotulo.toLowerCase()}.`);
      void d.recarregar();
    } catch (e) {
      setFalha(erroMsg(e));
    } finally {
      setOcupado(null);
    }
  }

  const pedidos = d.dados?.pedidos ?? [];
  const pendentes = pedidos.filter((p) => p.estado === "pendente");
  const decididos = pedidos.filter((p) => p.estado !== "pendente");

  return (
    <div className="tela">
      <h1>Conectores</h1>
      <p className="sub">
        Claude e os conectores da OpenAI (Codex) já são liberados. Quando um
        conector de origem nova tenta acessar (MCP/OAuth/admin), o Vigia pergunta
        aqui: liberar temporário (24 h), permanente ou bloquear.
      </p>

      {msg && <p className="ok">{msg}</p>}
      {falha && <p className="erro">{falha}</p>}

      {pendentes.length === 0 && (
        <Card>
          <p className="sub">Nenhum pedido pendente.</p>
        </Card>
      )}

      {pendentes.map((p) => (
        <Card key={p.id}>
          <ListRow
            titulo={p.faixa}
            detalhe={`${p.origem || p.ip || "origem desconhecida"} · ${p.caminho} · ${dataHora(p.criado)}`}
            fim={<Badge tom="aviso">Aguardando</Badge>}
          />
          <div className="linha" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <Button onClick={() => decidir(p, "temporario")} disabled={ocupado === p.id}>
              Temporário (24 h)
            </Button>
            <Button onClick={() => decidir(p, "permanente")} disabled={ocupado === p.id}>
              Permanente
            </Button>
            <Button
              variante="perigo"
              onClick={() => decidir(p, "bloquear")}
              disabled={ocupado === p.id}
            >
              Bloquear
            </Button>
          </div>
        </Card>
      ))}

      {decididos.length > 0 && (
        <Card>
          <h2 className="sub">Decididos</h2>
          {decididos.map((p) => (
            <ListRow
              key={p.id}
              titulo={p.faixa}
              detalhe={`${p.origem || p.ip || ""}${p.decidido ? ` · ${dataHora(p.decidido)}` : ""}`}
              fim={<Badge tom={ESTADO[p.estado].tom}>{ESTADO[p.estado].rotulo}</Badge>}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
