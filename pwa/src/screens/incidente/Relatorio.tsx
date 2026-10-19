import { Badge, Card } from "../../ui";
import { dataHora } from "../../lib";

export interface RelatorioDados {
  resumo: string; gravidade: string; falso_positivo: boolean; acao_recomendada: string; detalhes: string;
}

export default function Relatorio({ r, em }: { r: RelatorioDados; em: string | null }) {
  return (
    <>
      <h2 className="secao">Investigação{em ? ` · ${dataHora(em)}` : ""}</h2>
      <Card>
        <div className="grade" style={{ marginBottom: 8 }}>
          <Badge tom={r.gravidade === "critica" || r.gravidade === "alta" ? "perigo" : "aviso"}>gravidade: {r.gravidade}</Badge>
          {r.falso_positivo && <Badge tom="ok">possível falso positivo</Badge>}
          <Badge>ação: {r.acao_recomendada}</Badge>
        </div>
        <p style={{ margin: "0 0 8px", fontWeight: 600 }}>{r.resumo}</p>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }} className="row__detalhe">{r.detalhes}</p>
      </Card>
    </>
  );
}
