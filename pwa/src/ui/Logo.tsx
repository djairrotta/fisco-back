let seq = 0;

/**
 * Marca do Vigia: escudo sentinela com uma íris vigilante e uma varredura de
 * radar. Gradiente sutil e brilho metálico (estilo Apple); funciona no claro e
 * no escuro porque traz o próprio fundo. Cada instância usa IDs únicos para os
 * gradientes, então pode aparecer mais de uma vez na mesma página.
 */
export default function Logo({
  size = 96,
  decorativo = true,
  className = "",
}: {
  size?: number;
  decorativo?: boolean;
  className?: string;
}) {
  const id = `vg${++seq}`;
  return (
    <svg
      className={`logo-vigia ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={decorativo ? "img" : undefined}
      aria-hidden={decorativo ? true : undefined}
      aria-label={decorativo ? undefined : "Vigia"}
    >
      <defs>
        <linearGradient id={`${id}-corpo`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3aa0ff" />
          <stop offset="0.5" stopColor="#0a84ff" />
          <stop offset="1" stopColor="#0052cc" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-iris`} cx="0.5" cy="0.42" r="0.62">
          <stop offset="0" stopColor="#eaf4ff" />
          <stop offset="0.55" stopColor="#bcd9ff" />
          <stop offset="1" stopColor="#5aa8ff" />
        </radialGradient>
        <linearGradient id={`${id}-varredura`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0a84ff" stopOpacity="0" />
          <stop offset="1" stopColor="#0a84ff" stopOpacity="0.9" />
        </linearGradient>
      </defs>

      {/* escudo */}
      <path
        d="M32 3.5 56 12v18.5c0 15-10.2 25.4-24 30-13.8-4.6-24-15-24-30V12L32 3.5Z"
        fill={`url(#${id}-corpo)`}
        stroke="#003f99"
        strokeWidth="0.6"
      />
      {/* brilho metálico no topo */}
      <path
        d="M32 3.5 56 12v18.5c0 15-10.2 25.4-24 30-13.8-4.6-24-15-24-30V12L32 3.5Z"
        fill={`url(#${id}-sheen)`}
      />

      {/* varredura de radar (setor) */}
      <path
        d="M32 31.5 L32 12.5 A19 19 0 0 1 48.5 22 Z"
        fill={`url(#${id}-varredura)`}
        opacity="0.5"
      />
      {/* anéis do radar */}
      <circle cx="32" cy="31.5" r="16.5" fill="none" stroke="#fff" strokeOpacity="0.22" strokeWidth="1" />
      <circle cx="32" cy="31.5" r="11" fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="1" />

      {/* olho vigilante */}
      <path
        d="M16 31.5 C21 24 43 24 48 31.5 C43 39 21 39 16 31.5 Z"
        fill="#06142e"
        fillOpacity="0.55"
        stroke="#fff"
        strokeOpacity="0.75"
        strokeWidth="1.4"
      />
      <circle cx="32" cy="31.5" r="7.4" fill={`url(#${id}-iris)`} />
      <circle cx="32" cy="31.5" r="3.5" fill="#06142e" />
      <circle cx="33.6" cy="29.8" r="1.4" fill="#fff" fillOpacity="0.9" />
    </svg>
  );
}
