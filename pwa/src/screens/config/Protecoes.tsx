import { useEffect, useState } from "react";
import { Card, ConfirmDialog, ListRow, Segmented, Toggle } from "../../ui";
import { api } from "../../api";
import { erroMsg, useCarga } from "../../lib";

type Modo = "desligado" | "observar" | "bloquear";
interface Zona { zona: string; regra: string; rate: string; detalhe: string | null }
interface Protecoes {
  modo: Modo; rateAtivo: boolean; zonas: Zona[];
  ocorrencias24h?: { total: number; porAssinatura: Record<string, number> } | null;
}
type Mudanca = { modo?: Modo; rateAtivo?: boolean };

const ROTULO_REGRA: Record<string, string> = {
  ativa: "bloqueando",
  observando: "observando (log)",
  observando_eventos: "observando pelos eventos",
  desligada: "desligada",
  limite_plano: "não coube no plano",
  sem_permissao: "sem permissão no Cloudflare",
  nao_suportado: "não suportado no plano",
  erro: "erro",
};
const ROTULO_RATE: Record<string, string> = {
  ativo: "ativo",
  desligado: "desligado",
  limite_plano: "não permitido no plano",
  sem_permissao: "sem permissão no Cloudflare",
  nao_suportado: "não suportado no plano",
  erro: "erro",
};

export default function ProtecoesConfig() {
  const { dados } = useCarga<Protecoes>("/api/protecoes");
  const [p, setP] = useState<Protecoes | null>(null);
  const [pendente, setPendente] = useState<Mudanca | null>(null);
  const [erro, setErro] = useState("");
  useEffect(() => { if (dados) setP(dados); }, [dados]);

  async function aplicar(m: Mudanca) {
    setErro("");
    try {
      const r = await api.put<Protecoes>("/api/protecoes", m);
      setP((x) => (x ? { ...x, modo: r.modo, rateAtivo: r.rateAtivo, zonas: r.zonas ?? x.zonas } : x));
    } catch (e) {
      setErro(erroMsg(e));
    }
  }

  if (!p) return null;
  return (
    <>
      <h2 className="secao">Proteções na borda</h2>
      <Card>
        <p className="sub">
          Regra “Vigia: proteções” em cada zona: barra XSS, SQL injection, path traversal e sondagens
          (/.env, /.git/). Webhooks (exceções de caminho) e o Vigia ficam de fora.
        </p>
        <Segmented<Modo>
          opcoes={[
            { valor: "desligado", rotulo: "Desligado" },
            { valor: "observar", rotulo: "Observar" },
            { valor: "bloquear", rotulo: "Bloquear" },
          ]}
          valor={p.modo}
          onChange={(v) => v !== p.modo && setPendente({ modo: v })} />
        <ListRow titulo="Limite de login (20 req/10 s por IP)"
          fim={<Toggle rotulo="Limite de login" ligado={p.rateAtivo} onChange={(v) => setPendente({ rateAtivo: v })} />} />
        {p.ocorrencias24h && (
          <p className="sub">Últimas 24 h: {p.ocorrencias24h.total} requisição(ões) casariam a regra.</p>
        )}
        {erro && <p className="erro-txt" role="alert">{erro}</p>}
        {p.zonas.map((z) => (
          <ListRow key={z.zona} titulo={z.zona}
            detalhe={`Regra: ${ROTULO_REGRA[z.regra] ?? z.regra} · Login: ${ROTULO_RATE[z.rate] ?? z.rate}${z.detalhe ? ` — ${z.detalhe}` : ""}`} />
        ))}
      </Card>
      {pendente && (
        <ConfirmDialog titulo="Proteções na borda" texto="Isto altera regras de segurança das suas zonas no Cloudflare"
          onCancelar={() => setPendente(null)}
          onConfirmar={() => { const m = pendente; setPendente(null); void aplicar(m); }} />
      )}
    </>
  );
}
