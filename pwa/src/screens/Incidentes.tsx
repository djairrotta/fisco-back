import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Card, ListaIps, ListRow, Segmented } from "../ui";
import { dataHora, useCarga } from "../lib";
import { AvisoPassou, type EstadoIp, LinhaLocal, SelosLimitados } from "./comum/EstadoIp";

export interface IncidenteResumo {
  id: number; ips: string[]; hosts: string[]; fim: string | null; classeFinal: string | null;
  status: string; severidadeMax: string; totalSinais: number; contagemTotal: number;
  estadoIps?: EstadoIp[];
}

const FILTROS = [
  { valor: "", rotulo: "Todos" },
  { valor: "aberto", rotulo: "Abertos" },
  { valor: "bloqueado", rotulo: "Bloqueados" },
  { valor: "ignorado", rotulo: "Ignorados" },
];
const tomSev = (s: string) => (s === "alta" ? "perigo" : s === "media" ? "aviso" : "neutro");

export default function Incidentes() {
  const [status, setStatus] = useState("");
  const nav = useNavigate();
  const { dados, erro } = useCarga<IncidenteResumo[]>(`/api/incidentes${status ? `?status=${status}` : ""}`);
  return (
    <>
      <h1 className="titulo">Incidentes</h1>
      <Segmented opcoes={FILTROS} valor={status} onChange={setStatus} />
      {erro && <p className="erro-txt" role="alert">{erro}</p>}
      {dados && dados.length === 0 && <p className="sub">Nenhum incidente.</p>}
      {dados && dados.length > 0 && (
        <Card>
          {dados.map((i) => (
            <ListRow
              key={i.id}
              onClick={() => nav(`/incidentes/${i.id}`)}
              fimAbaixo
              titulo={<ListaIps ips={i.ips} max={2} />}
              detalhe={<>
                {`${i.hosts.join(", ")} · ${i.classeFinal ?? "sem classe"} · ${dataHora(i.fim)}`}
                {(i.estadoIps ?? []).slice(0, 2).map((e) => <LinhaLocal key={`l:${e.ip}`} e={e} comIp={i.ips.length > 1} />)}
                {(i.estadoIps ?? []).map((e) => <AvisoPassou key={e.ip} e={e} />)}
              </>}
              fim={<>
                <Badge tom={tomSev(i.severidadeMax)}>{i.severidadeMax}</Badge><Badge>{i.status}</Badge>
                <SelosLimitados estados={i.estadoIps ?? []} max={2} />
              </>}
            />
          ))}
        </Card>
      )}
    </>
  );
}
