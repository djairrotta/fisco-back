export default function Toggle({
  ligado, onChange, rotulo, disabled,
}: { ligado: boolean; onChange: (v: boolean) => void; rotulo: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={ligado} aria-label={rotulo} disabled={disabled}
      className={`toggle${ligado ? " toggle--on" : ""}`} onClick={() => onChange(!ligado)}>
      <span className="toggle__knob" />
    </button>
  );
}
