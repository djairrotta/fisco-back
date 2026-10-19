export default function Segmented<T extends string>({
  opcoes, valor, onChange,
}: { opcoes: { valor: T; rotulo: string }[]; valor: T; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          aria-pressed={o.valor === valor}
          className={`seg__item${o.valor === valor ? " seg__item--on" : ""}`}
          onClick={() => onChange(o.valor)}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
