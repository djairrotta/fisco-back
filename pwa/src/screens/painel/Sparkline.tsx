/** Sparkline de área (SVG inline, sem biblioteca): incidentes por hora. */
export default function Sparkline({ dados }: { dados: { h: string; n: number }[] }) {
  const w = 300, h = 64, pad = 2;
  const n = Math.max(1, dados.length);
  const max = Math.max(1, ...dados.map((d) => d.n));
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);
  const y = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  const pts = dados.map((d, i) => `${x(i).toFixed(1)},${y(d.n).toFixed(1)}`);
  const linha = pts.length ? `M${pts.join(" L")}` : "";
  const area = pts.length
    ? `M${x(0).toFixed(1)},${(h - pad).toFixed(1)} L${pts.join(" L")} L${x(n - 1).toFixed(1)},${(h - pad).toFixed(1)} Z`
    : "";
  const ultimo = dados.length - 1;
  const total = dados.reduce((s, d) => s + d.n, 0);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      role="img" aria-label={`Incidentes por hora nas últimas 24 horas: ${total} no total`}>
      {area && <path className="spark__area" d={area} />}
      {linha && <path className="spark__linha" d={linha} vectorEffect="non-scaling-stroke" />}
      {dados.length > 0 && <circle className="spark__ponto" cx={x(ultimo)} cy={y(dados[ultimo].n)} r="2.6" />}
    </svg>
  );
}
