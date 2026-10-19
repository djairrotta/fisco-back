// Ações sobre mensagens, compartilhadas por barra de ferramentas, deslize,
// atalhos e seleção em lote — tudo pelas rotas 2.0 (API.md §2 e §5).
import { useCallback } from "react";
import { api2, type AcaoLote, type RespostaLote } from "./api2";
import { erroMsg } from "./lib";
import { useShell } from "./shell/contexto";
import { useToast, type NomeIcone } from "./ui";

const AVISO: Partial<Record<AcaoLote, [string, string, NomeIcone]>> = {
  arquivar: ["Arquivada", "arquivadas", "arquivo"],
  spam: ["Marcada como spam", "marcadas como spam", "spam"],
  nao_spam: ["Devolvida para a Entrada", "devolvidas para a Entrada", "naoSpam"],
  mover: ["Movida", "movidas", "mover"],
};

export function useAcoes(caixaId: number | null) {
  const { pastas, recarregarPastas } = useShell();
  const { mostrar } = useToast();
  const tipoDe = useCallback((caminho: string) => pastas?.find((p) => p.caminho === caminho)?.tipo ?? (caminho === "INBOX" ? "entrada" : null), [pastas]);
  const nomeDe = useCallback((caminho: string) => pastas?.find((p) => p.caminho === caminho)?.nome ?? caminho, [pastas]);
  const falhou = useCallback((e: unknown) => { mostrar(erroMsg(e), { tom: "perigo", icone: "alerta" }); return null; }, [mostrar]);

  /** Executa uma ação de lote e avisa. Devolve a resposta ou null em erro. */
  const lote = useCallback(async (acao: AcaoLote, pasta: string, uids: number[], destino?: string): Promise<RespostaLote | null> => {
    if (!caixaId || uids.length === 0) return null;
    try {
      const r = await api2.acaoLote(caixaId, { pasta, uids, acao, ...(destino ? { destino } : {}) });
      const n = r.afetadas;
      if (acao === "excluir") {
        mostrar(r.resultado === "apagadas" ? (n === 1 ? "Apagada definitivamente" : `${n} apagadas definitivamente`) : (n === 1 ? "Movida para a Lixeira" : `${n} movidas para a Lixeira`), { icone: "lixeira" });
      } else if (AVISO[acao]) {
        const [um, varias, icone] = AVISO[acao]!;
        const sufixo = acao === "mover" && destino ? ` para ${nomeDe(destino)}` : "";
        mostrar(n === 1 ? `${um}${sufixo}` : `${n} ${varias}${sufixo}`, { icone });
      }
      recarregarPastas();
      return r;
    } catch (e) { return falhou(e); }
  }, [caixaId, mostrar, nomeDe, recarregarPastas, falhou]);

  const marcarLida = useCallback(async (pasta: string, uid: number, lida: boolean) => {
    if (!caixaId) return null;
    try {
      const r = await api2.marcar(caixaId, pasta, uid, { lida });
      recarregarPastas();
      return r.lida ?? lida;
    } catch (e) { return falhou(e); }
  }, [caixaId, recarregarPastas, falhou]);

  const marcarEstrela = useCallback(async (pasta: string, uid: number, estrela: boolean) => {
    if (!caixaId) return null;
    try {
      const r = await api2.marcar(caixaId, pasta, uid, { estrela });
      return r.estrela ?? estrela;
    } catch (e) { return falhou(e); }
  }, [caixaId, falhou]);

  const redirecionar = useCallback(async (pasta: string, uid: number, para: string[]) => {
    if (!caixaId) return false;
    try {
      const r = await api2.redirecionar(caixaId, pasta, uid, para);
      if (r.rejeitados?.length) mostrar(`Redirecionada; recusados: ${r.rejeitados.join(", ")}`, { icone: "alerta", tom: "perigo" });
      else mostrar(r.aviso ?? "Mensagem redirecionada", { icone: "externo" });
      return true;
    } catch (e) { falhou(e); return false; }
  }, [caixaId, mostrar, falhou]);

  const um = (acao: AcaoLote) => async (pasta: string, uid: number, destino?: string) => !!(await lote(acao, pasta, [uid], destino));

  return {
    lote, marcarLida, marcarEstrela, redirecionar, tipoDe, nomeDe,
    arquivar: um("arquivar"), excluir: um("excluir"), spam: um("spam"), naoSpam: um("nao_spam"),
    mover: (pasta: string, uid: number, destino: string) => um("mover")(pasta, uid, destino),
  };
}
