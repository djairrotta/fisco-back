import { Fragment } from "react";

/**
 * Endereço IP que nunca quebra no meio (IPv4: nowrap, reticências só se não
 * couber de jeito nenhum). IPv6 pode quebrar apenas depois de ":".
 */
export function Ip({ ip }: { ip: string }) {
  if (!ip.includes(":")) {
    return <span className="ip" title={ip} style={{ whiteSpace: "nowrap" }}>{ip}</span>;
  }
  const partes = ip.split(":");
  return (
    <span className="ip ip--v6" title={ip}>
      {partes.map((p, i) => (
        <Fragment key={i}>{p}{i < partes.length - 1 && <>:<wbr /></>}</Fragment>
      ))}
    </span>
  );
}

/** "a, b +N": cada IP inteiro; a lista quebra só entre IPs. */
export function ListaIps({ ips, max = Infinity }: { ips: string[]; max?: number }) {
  const vis = ips.slice(0, max);
  return (
    <>
      {vis.map((ip, i) => <Fragment key={ip}>{i > 0 && ", "}<Ip ip={ip} /></Fragment>)}
      {ips.length > vis.length && ` +${ips.length - vis.length}`}
    </>
  );
}
