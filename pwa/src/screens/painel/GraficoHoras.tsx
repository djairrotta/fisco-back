export default function GraficoHoras({ dados }: { dados: { h: string; n: number }[] }) {
  const max = Math.max(1, ...dados.map((d) => d.n));
  const w = 240, h = 100, passo = w / Math.max(1, dados.length);
  return (
    <svg className="grafico" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Ataques por hora nas últimas 24 horas">
      {dados.map((d, i) => {
        const alt = (d.n / max) * (h - 4);
        return (
          <rect key={d.h} x={i * passo + 1} y={h - alt} width={Math.max(1, passo - 2)} height={alt} rx={1.5}>
            <title>{`${new Date(d.h).getHours()}h: ${d.n}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
