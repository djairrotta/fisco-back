import { Badge, Ip } from "../../ui";
import { dataHora } from "../../lib";

export interface EstadoIp {
  ip: string;
  bloqueado: boolean;
  bloqueadoAte: string | null;
  geo: { barrados: number; passou: number; passaram: { caminho: string; motivo: string }[] } | null;
  /** Localização do cache do servidor (nunca consulta o provedor). */
  local?: LocalCache | null;
}

export interface LocalCache {
  cidade: string | null; regiao: string | null; pais: string | null; provedor: string | null; asn: number | null;
}

/** "📍 Augsburg/Bavaria, Germany · Feo Prest SRL (AS208137)" (mesmo formato do push). */
export function textoLocal(l: LocalCache | null | undefined): string | null {
  if (!l) return null;
  const lugar = [l.cidade, l.regiao].filter(Boolean).join("/");
  const onde = [lugar, l.pais].filter(Boolean).join(", ");
  const asn = l.asn ? `AS${l.asn}` : "";
  const quem = l.provedor && asn ? `${l.provedor} (${asn})` : l.provedor || asn;
  const partes = [onde, quem].filter(Boolean);
  return partes.length ? `📍 ${partes.join(" · ")}` : null;
}

/** Linha 📍 do IP (com o IP na frente quando a lista tem vários). */
export function LinhaLocal({ e, comIp = false }: { e: Pick<EstadoIp, "ip" | "local">; comIp?: boolean }) {
  const t = textoLocal(e.local);
  if (!t) return null;
  return <div className="row__detalhe">{comIp ? t.replace("📍 ", `📍 ${e.ip} · `) : t}</div>;
}

/** Selos curtos (listas): bloqueio ativo do Vigia e barrado pela regra geo. */
export function SelosIp({ e }: { e: Pick<EstadoIp, "bloqueado" | "bloqueadoAte" | "geo"> }) {
  return (
    <>
      {e.bloqueado && (
        <Badge tom="perigo">{e.bloqueadoAte ? `Bloqueado até ${dataHora(e.bloqueadoAte)}` : "Bloqueado (sem validade)"}</Badge>
      )}
      {e.geo && e.geo.barrados > 0 && <Badge tom="ok">Bloqueado (fora do Brasil)</Badge>}
    </>
  );
}

/** Selos de vários IPs numa linha: no máximo `max`, depois "+N". */
export function SelosLimitados({ estados, max }: { estados: EstadoIp[]; max: number }) {
  const selos: { k: string; tom: "perigo" | "ok"; texto: string }[] = [];
  for (const e of estados) {
    if (e.bloqueado) {
      selos.push({
        k: `${e.ip}:b`,
        tom: "perigo",
        texto: e.bloqueadoAte ? `Bloqueado até ${dataHora(e.bloqueadoAte)}` : "Bloqueado (sem validade)",
      });
    }
    if (e.geo && e.geo.barrados > 0) selos.push({ k: `${e.ip}:g`, tom: "ok", texto: "Bloqueado (fora do Brasil)" });
  }
  return (
    <>
      {selos.slice(0, max).map((s) => <Badge key={s.k} tom={s.tom}>{s.texto}</Badge>)}
      {selos.length > max && <Badge>+{selos.length - max}</Badge>}
    </>
  );
}

/** Aviso de acesso estrangeiro que passou pela regra geo (primeiro caminho). */
export function AvisoPassou({ e }: { e: Pick<EstadoIp, "geo"> }) {
  const p = e.geo && e.geo.passou > 0 ? e.geo.passaram[0] : null;
  if (!e.geo || e.geo.passou <= 0) return null;
  return (
    <div className="row__detalhe aviso-passou">
      {p ? `⚠️ Acesso estrangeiro passou: ${p.caminho} (${p.motivo})` : "⚠️ Acesso estrangeiro passou"}
    </div>
  );
}

/** Bloco completo por IP (detalhe do incidente). */
export function EstadoIpDetalhe({ e }: { e: EstadoIp }) {
  return (
    <div className="row row--selos">
      <div className="row__main">
        <div className="row__titulo"><Ip ip={e.ip} /></div>
        <LinhaLocal e={e} />
        {e.geo && e.geo.barrados > 0 && (
          <div className="row__detalhe">Bloqueado pela regra Fora do Brasil · {e.geo.barrados} requisições barradas</div>
        )}
        <AvisoPassou e={e} />
        {e.geo && e.geo.passou > 0 && e.geo.passaram.slice(1).map((p) => (
          <div key={p.caminho} className="row__detalhe aviso-passou">{`⚠️ ${p.caminho} (${p.motivo})`}</div>
        ))}
      </div>
      {e.bloqueado && (
        <div className="row__fim">
          <Badge tom="perigo">{e.bloqueadoAte ? `Bloqueado até ${dataHora(e.bloqueadoAte)}` : "Bloqueado (sem validade)"}</Badge>
        </div>
      )}
    </div>
  );
}
