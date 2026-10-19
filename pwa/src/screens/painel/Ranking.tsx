import { Card } from "../../ui";

export default function Ranking({ titulo, itens }: { titulo: string; itens: { rotulo: string; n: number }[] }) {
  const max = Math.max(1, ...itens.map((i) => i.n));
  return (
    <Card>
      <h2 className="secao" style={{ margin: "0 0 8px" }}>{titulo}</h2>
      {itens.length === 0 && <p className="sub" style={{ margin: 0 }}>Sem dados nas últimas 24 h.</p>}
      {itens.map((i) => (
        <div className="barra" key={i.rotulo}>
          <span style={{ minWidth: 0, flex: "0 1 45%", overflowWrap: "anywhere" }}>{i.rotulo}</span>
          <span className="barra__trilho"><span className="barra__preench" style={{ width: `${(i.n / max) * 100}%`, display: "block" }} /></span>
          <span>{Math.round(i.n).toLocaleString("pt-BR")}</span>
        </div>
      ))}
    </Card>
  );
}
