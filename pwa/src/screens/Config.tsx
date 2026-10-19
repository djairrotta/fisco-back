import { useState } from "react";
import { Button, Card } from "../ui";
import { ativarPush, pushSuportado } from "../push";
import { sair } from "../auth";
import GeralConfig from "./config/Geral";
import IaConfig from "./config/IaConfig";
import Notificacoes from "./config/Notificacoes";
import ProtecoesConfig from "./config/Protecoes";
import Integracoes from "./config/Integracoes";

export default function Config() {
  const [msg, setMsg] = useState("");
  async function push() {
    const r = await ativarPush().catch(() => "erro" as const);
    setMsg(
      r === "ativado" ? "Notificações ativadas neste dispositivo."
      : r === "negado" ? "Permissão negada nos ajustes do sistema."
      : r === "nao_suportado" ? "Este navegador não suporta push (no iPhone, adicione à Tela de Início)."
      : "Não foi possível ativar as notificações.",
    );
  }
  return (
    <>
      <h1 className="titulo">Config</h1>
      <GeralConfig />
      <IaConfig />
      <Notificacoes />
      <ProtecoesConfig />
      <Integracoes />
      <h2 className="secao">Este dispositivo</h2>
      <Card>
        <Button bloco onClick={push} disabled={!pushSuportado()}>Ativar notificações</Button>
        {msg && <p className="sub" role="status">{msg}</p>}
      </Card>
      <Card>
        <Button bloco variante="secundario" onClick={() => sair().finally(() => location.assign("/login"))}>Sair</Button>
      </Card>
    </>
  );
}
