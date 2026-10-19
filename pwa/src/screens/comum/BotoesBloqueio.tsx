import { useState } from "react";
import { Button, ConfirmDialog } from "../../ui";

export type Duracao = "24h" | "7d";
export const ROTULO_DURACAO: Record<Duracao, string> = { "24h": "24 h", "7d": "7 dias" };
export const DURACOES: Duracao[] = ["24h", "7d"];

/** "Bloquear 24 h" / "Bloquear 7 dias", sempre com confirmação (ConfirmDialog). */
export default function BotoesBloqueio({
  alvo, onBloquear, disabled,
}: { alvo: string; onBloquear: (d: Duracao) => void; disabled?: boolean }) {
  const [pedido, setPedido] = useState<Duracao | null>(null);
  return (
    <>
      {DURACOES.map((d) => (
        <Button key={d} className="btn--mini" variante="perigo" disabled={disabled} onClick={() => setPedido(d)}>
          Bloquear {ROTULO_DURACAO[d]}
        </Button>
      ))}
      {pedido && (
        <ConfirmDialog
          titulo={`Bloquear por ${ROTULO_DURACAO[pedido]}?`}
          texto={`${alvo} ficará bloqueado em todos os sites por ${ROTULO_DURACAO[pedido]}.`}
          onCancelar={() => setPedido(null)}
          onConfirmar={() => { const d = pedido; setPedido(null); onBloquear(d); }}
        />
      )}
    </>
  );
}
