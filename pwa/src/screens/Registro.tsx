import { useMemo, useState } from "react";
import { Badge, Button, Grupo, Icone, Segmented } from "../ui";
import Pagina from "./Pagina";
import { dataHora, useCarga } from "../lib";

type Nivel = "info" | "aviso" | "erro";
type Area =
  | "envio"
  | "recebimento"
  | "imap"
  | "smtp"
  | "sieve"
  | "auth"
  | "sistema";

interface Linha {
  id: number;
  ts: string;
  nivel: Nivel;
  area: Area;
  caixaId: number | null;
  mensagem: string;
  detalhe: Record<string, unknown> | null;
}

const NIVEIS: { valor: Nivel | "todos"; rotulo: string }[] = [
  { valor: "todos", rotulo: "Tudo" },
  { valor: "info", rotulo: "Info" },
  { valor: "aviso", rotulo: "Avisos" },
  { valor: "erro", rotulo: "Erros" },
];

const AREAS: { valor: Area | "todas"; rotulo: string }[] = [
  { valor: "todas", rotulo: "Todas as áreas" },
  { valor: "envio", rotulo: "Envio" },
  { valor: "recebimento", rotulo: "Recebimento" },
  { valor: "imap", rotulo: "IMAP" },
  { valor: "smtp", rotulo: "SMTP" },
  { valor: "sieve", rotulo: "Filtros (Sieve)" },
  { valor: "auth", rotulo: "Autenticação" },
  { valor: "sistema", rotulo: "Sistema" },
];

const TOM: Record<Nivel, "neutro" | "aviso" | "perigo"> = {
  info: "neutro",
  aviso: "aviso",
  erro: "perigo",
};

const rotuloArea = (a: Area) =>
  AREAS.find((x) => x.valor === a)?.rotulo ?? a;

export default function Registro() {
  const [nivel, setNivel] = useState<Nivel | "todos">("todos");
  const [area, setArea] = useState<Area | "todas">("todas");

  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (nivel !== "todos") q.set("nivel", nivel);
    if (area !== "todas") q.set("area", area);
    const s = q.toString();
    return `/api/registro${s ? `?${s}` : ""}`;
  }, [nivel, area]);

  const c = useCarga<{ registro: Linha[] }>(path);
  const linhas = c.dados?.registro ?? [];

  return (
    <Pagina
      titulo="Registro"
      sub="Atividade e erros de envio, recebimento e filtros (últimos 30 dias)."
      voltar={{ rotulo: "Ajustes", href: "/config" }}
      acao={
        <Button
          variante="cinza"
          onClick={() => void c.recarregar()}
          disabled={c.carregando}
        >
          <Icone nome="atualizar" tam={16} /> Atualizar
        </Button>
      }
    >
      <Grupo titulo="Filtros">
        <div className="row-form reg-filtros">
          <Segmented
            rotulo="Nível"
            opcoes={NIVEIS}
            valor={nivel}
            onChange={setNivel}
          />
          <select
            className="campo"
            aria-label="Área"
            value={area}
            onChange={(e) => setArea(e.target.value as Area | "todas")}
          >
            {AREAS.map((a) => (
              <option key={a.valor} value={a.valor}>{a.rotulo}</option>
            ))}
          </select>
        </div>
      </Grupo>

      <Grupo>
        {c.erro && (
          <p className="row-nota txt-perigo" role="alert">{c.erro}</p>
        )}
        {!c.erro && !linhas.length && (
          <p className="row-nota" role="status">
            {c.carregando ? "Carregando…" : "Nada registrado por aqui."}
          </p>
        )}
        {linhas.map((l) => (
          <div
            key={l.id}
            className={`reg-linha${l.nivel === "erro" ? " reg-linha--erro" : ""}`}
          >
            <div className="reg-linha__topo">
              <Badge tom={TOM[l.nivel]}>{l.nivel}</Badge>
              <span className="reg-linha__area">{rotuloArea(l.area)}</span>
              <span className="reg-linha__hora">{dataHora(l.ts)}</span>
            </div>
            <div className="reg-linha__msg">{l.mensagem}</div>
          </div>
        ))}
      </Grupo>
    </Pagina>
  );
}
