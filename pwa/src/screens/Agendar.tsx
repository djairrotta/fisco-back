import { useState } from "react";
import { Button, Icone } from "../ui";

/** Próximas opções rápidas: hoje 18:00 (se ainda der tempo) e amanhã 08:00. */
export function opcoesRapidas(agora = new Date()): { rotulo: string; detalhe: string; quando: Date }[] {
  const hoje18 = new Date(agora); hoje18.setHours(18, 0, 0, 0);
  const amanha8 = new Date(agora); amanha8.setDate(amanha8.getDate() + 1); amanha8.setHours(8, 0, 0, 0);
  const dia = (d: Date) => d.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "");
  const r = [];
  if (hoje18.getTime() - agora.getTime() > 5 * 60 * 1000) r.push({ rotulo: "Hoje, 18:00", detalhe: dia(hoje18), quando: hoje18 });
  r.push({ rotulo: "Amanhã, 08:00", detalhe: dia(amanha8), quando: amanha8 });
  return r;
}

const paraInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Escolha de horário ("Enviar mais tarde" e "Reagendar"). */
export default function EscolhaHorario({ titulo, rotuloAcao, onEscolher }: { titulo: string; rotuloAcao: string; onEscolher: (d: Date) => void }) {
  const [livre, setLivre] = useState(false);
  const amanha = new Date(); amanha.setDate(amanha.getDate() + 1); amanha.setHours(9, 0, 0, 0);
  const [valor, setValor] = useState(paraInput(amanha));
  const escolhido = new Date(valor);
  const valido = !Number.isNaN(escolhido.getTime()) && escolhido.getTime() > Date.now() + 60_000 && escolhido.getTime() < Date.now() + 365 * 86400_000;
  return (
    <div className="agendar" role="group" aria-label={titulo}>
      <p className="agendar__titulo">{titulo}</p>
      {opcoesRapidas().map((o) => (
        <button key={o.rotulo} type="button" className="agendar__op" onClick={() => onEscolher(o.quando)}>
          <Icone nome="saida" tam={16} />
          <span className="agendar__rot">{o.rotulo}</span>
          <span className="agendar__det">{o.detalhe}</span>
        </button>
      ))}
      {!livre ? (
        <button type="button" className="agendar__op" onClick={() => setLivre(true)}>
          <Icone nome="calendario" tam={16} />
          <span className="agendar__rot">Escolher data e hora…</span>
        </button>
      ) : (
        <div className="agendar__livre">
          <input className="campo" type="datetime-local" aria-label="Data e hora" value={valor} min={paraInput(new Date())} onChange={(e) => setValor(e.target.value)} />
          <Button variante="liquido" tam="p" disabled={!valido} onClick={() => onEscolher(escolhido)}>{rotuloAcao}</Button>
        </div>
      )}
    </div>
  );
}
