import { useEffect, useState } from "react";
import { Button, Folha as FolhaModal } from "../../ui";
import { api } from "../../api";
import { dataHora, erroMsg } from "../../lib";

interface Local {
  ip: string; pais: string | null; pais_codigo: string | null; regiao: string | null; cidade: string | null;
  lat: number | null; lon: number | null; provedor: string | null; asn: number | null; fuso: string | null;
  fonte: string; consultado_em: string; mapa_url: string | null;
}

const caminho = (ip: string, r: "local" | "dossie") => `/api/ip/${encodeURIComponent(ip)}/${r}`;

function Folha({ ip, onFechar }: { ip: string; onFechar: () => void }) {
  const [local, setLocal] = useState<Local | null>(null);
  const [erro, setErro] = useState("");
  const [copia, setCopia] = useState("");
  // Dossiê buscado ao abrir a folha: o toque em "Copiar" chama writeText na
  // hora, dentro do gesto do usuário (exigência do Safari/iOS).
  const [dossie, setDossie] = useState<string | null>(null);
  const [erroDossie, setErroDossie] = useState("");

  useEffect(() => {
    let vivo = true;
    api.get<Local>(caminho(ip, "local"))
      .then((l) => { if (vivo) setLocal(l); })
      .catch((e) => { if (vivo) setErro(erroMsg(e)); });
    api.get<string>(caminho(ip, "dossie"))
      .then((t) => { if (vivo) setDossie(String(t)); })
      .catch((e) => { if (vivo) setErroDossie(erroMsg(e)); });
    return () => { vivo = false; };
  }, [ip]);

  function copiar() {
    setCopia("");
    if (dossie === null) return;
    if (!navigator.clipboard?.writeText) {
      setCopia("Não foi possível copiar: este navegador não permite copiar automaticamente.");
      return;
    }
    // Síncrono no handler do toque: nada de await antes do writeText.
    navigator.clipboard.writeText(dossie).then(
      () => setCopia("Dados copiados. Cole na petição ou no ofício."),
      (e) => setCopia(`Não foi possível copiar: ${erroMsg(e)}`),
    );
  }

  const linha = (rotulo: string, valor: string | null | undefined) => (
    <div className="row" key={rotulo}>
      <div className="row__main row__detalhe" style={{ marginTop: 0 }}>{rotulo}</div>
      <div className="row__titulo">{valor || "—"}</div>
    </div>
  );

  return (
    <FolhaModal rotulo={`Localização de ${ip}`} onFechar={onFechar}>
      <h2 className="dialog__titulo">Localizar {ip}</h2>
      {!local && !erro && <p className="dialog__texto">Consultando…</p>}
      {erro && <p className="erro-txt" role="alert">{erro}</p>}
      {local && (
        <>
          {linha("País", local.pais ? `${local.pais}${local.pais_codigo ? ` (${local.pais_codigo})` : ""}` : null)}
          {linha("Região/estado", local.regiao)}
          {linha("Cidade", local.cidade)}
          {linha("Provedor", local.provedor)}
          {linha("ASN", local.asn !== null ? `AS${local.asn}` : null)}
          {linha("Fuso", local.fuso)}
          {linha("Coordenadas", local.lat !== null && local.lon !== null ? `${local.lat}, ${local.lon}` : null)}
          <p className="row__detalhe">Fonte: {local.fonte} · consultado em {dataHora(local.consultado_em)}</p>
        </>
      )}
      <p className="aviso-txt">Localização aproximada: cidade e provedor, não endereço.</p>
      <div className="campos">
        {local?.mapa_url && (
          <a className="btn btn--secundario btn--link" href={local.mapa_url} target="_blank" rel="noopener noreferrer">Abrir no mapa</a>
        )}
        <Button variante="secundario" disabled={dossie === null} onClick={copiar}>Copiar dados para requisição judicial</Button>
        {dossie === null && !erroDossie && <p className="sub" style={{ margin: 0 }}>Preparando dados…</p>}
        {erroDossie && <p className="erro-txt" role="alert">Não foi possível preparar os dados: {erroDossie}</p>}
        {copia && <p className="sub" role="status" style={{ margin: 0 }}>{copia}</p>}
        <Button onClick={onFechar}>Fechar</Button>
      </div>
    </FolhaModal>
  );
}

/** Botão "Localizar" que abre a folha com a localização aproximada do IP. */
export default function LocalizarIp({ ip, rotulo = "Localizar" }: { ip: string; rotulo?: string }) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <Button className="btn--mini" variante="secundario" onClick={() => setAberto(true)}>{rotulo}</Button>
      {aberto && <Folha ip={ip} onFechar={() => setAberto(false)} />}
    </>
  );
}
