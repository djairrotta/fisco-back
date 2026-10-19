/** Controle segmentado com marcador deslizante (posição via CSS custom properties). */
export default function Segmented<T extends string>({
  opcoes, valor, onChange, rotulo, className = "",
}: { opcoes: { valor: T; rotulo: string }[]; valor: T; onChange: (v: T) => void; rotulo?: string; className?: string }) {
  const i = Math.max(0, opcoes.findIndex((o) => o.valor === valor));
  return (
    <div className={`seg ${className}`.trim()} role="group" aria-label={rotulo}
      style={{ "--seg-n": opcoes.length, "--seg-i": i } as React.CSSProperties}>
      <span className="seg__marcador" aria-hidden="true" />
      {opcoes.map((o) => (
        <button key={o.valor} type="button" aria-pressed={o.valor === valor}
          className={`seg__item${o.valor === valor ? " seg__item--on" : ""}`} onClick={() => onChange(o.valor)}>
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
