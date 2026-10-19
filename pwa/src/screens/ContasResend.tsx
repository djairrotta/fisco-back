// Contas Resend (Ajustes → Diagnóstico): as CHAVES ficam só no ambiente do
// servidor (RESEND_CONTA_1..20); aqui o usuário gerencia o mapeamento
// domínio→slot, nomeia os slots e testa a chave de cada um.
import { useMemo, useState } from "react";
import { Badge, Button, Campo, Grupo, ListRow, useToast } from "../ui";
import Pagina from "./Pagina";
import { api } from "../api";
import { useCaixas } from "../caixas";
import { erroMsg, useCarga } from "../lib";

interface Slot {
  slot: number;
  nome: string;
  temChave: boolean;
  mascara: string | null;
  dominios: string[];
}

export default function ContasResend() {
  const c = useCarga<{ slots: Slot[] }>("/api/resend");
  const { caixas } = useCaixas();
  const toast = useToast();
  const [novo, setNovo] = useState<Record<number, string>>({});
  const [nomes, setNomes] = useState<Record<number, string>>({});

  const slots = c.dados?.slots ?? [];

  // domínios de caixa sem slot ativo (ou em slot sem chave) → poste.io
  const semEnvio = useMemo(() => {
    const comChave = new Set(
      slots.filter((s) => s.temChave).flatMap((s) => s.dominios),
    );
    const doms = new Set((caixas ?? []).map((cx) => cx.dominio.toLowerCase()));
    return [...doms].filter((d) => !comChave.has(d));
  }, [slots, caixas]);

  function atualizar(dados: { slots: Slot[] }) {
    c.setDados(dados);
  }

  async function atribuir(slot: number) {
    const dominio = (novo[slot] ?? "").trim();
    if (!dominio) return;
    try {
      const r = await api.post<{ slots: Slot[] }>("/api/resend/dominio", {
        slot,
        dominio,
      });
      atualizar(r);
      setNovo({ ...novo, [slot]: "" });
      toast.mostrar("Domínio atribuído.");
    } catch (e) {
      toast.mostrar(erroMsg(e), { tom: "perigo" });
    }
  }

  async function remover(dominio: string) {
    try {
      const r = await api.del<{ ok: boolean; slots: Slot[] }>(
        "/api/resend/dominio",
        { dominio },
      );
      atualizar(r);
      toast.mostrar("Domínio removido.");
    } catch (e) {
      toast.mostrar(erroMsg(e), { tom: "perigo" });
    }
  }

  async function renomear(slot: number) {
    try {
      const r = await api.patch<{ slots: Slot[] }>(`/api/resend/slot/${slot}`, {
        nome: nomes[slot] ?? "",
      });
      atualizar(r);
      toast.mostrar("Nome salvo.");
    } catch (e) {
      toast.mostrar(erroMsg(e), { tom: "perigo" });
    }
  }

  async function testar(slot: number) {
    try {
      const r = await api.post<{ ok: boolean; via?: string; erro?: string }>(
        `/api/resend/slot/${slot}/testar`,
      );
      if (r.ok) toast.mostrar(`Conexão ok (${r.via}).`);
      else toast.mostrar(`Falha: ${r.erro ?? "erro"}`, { tom: "perigo" });
    } catch (e) {
      toast.mostrar(erroMsg(e), { tom: "perigo" });
    }
  }

  return (
    <Pagina
      titulo="Contas Resend"
      sub="As chaves ficam no servidor (variáveis RESEND_CONTA_1..20). Aqui você mapeia os domínios de cada conta."
      voltar={{ rotulo: "Ajustes", href: "/config" }}
    >
      {c.erro && <p className="row-nota txt-perigo" role="alert">{c.erro}</p>}

      {semEnvio.length > 0 && (
        <Grupo titulo="Atenção">
          <p className="row-nota txt-aviso" role="status">
            Sem conta Resend com chave para: {semEnvio.join(", ")}. Essas caixas
            enviam pelo poste.io.
          </p>
        </Grupo>
      )}

      <Grupo
        titulo="Contas (slots)"
        nota="Cada domínio fica em um só slot. Slots sem chave no servidor não enviam pela Resend."
      >
        {slots.filter((s) => s.temChave || s.dominios.length).map((s) => (
          <div key={s.slot} className="reg-slot">
            <div className="reg-linha__topo">
              <strong>Slot {s.slot}</strong>
              {s.temChave
                ? <Badge tom="ok">{s.mascara}</Badge>
                : <Badge tom="perigo">sem chave</Badge>}
            </div>
            <div className="row-form">
              <Campo rotulo="Nome do slot">
                <span className="campo-linha">
                  <input
                    className="campo"
                    maxLength={100}
                    defaultValue={s.nome}
                    placeholder={`Conta ${s.slot}`}
                    onChange={(e) =>
                      setNomes({ ...nomes, [s.slot]: e.target.value })}
                  />
                  <Button variante="cinza" onClick={() => void renomear(s.slot)}>
                    Salvar
                  </Button>
                </span>
              </Campo>

              {s.dominios.map((d) => (
                <ListRow
                  key={d}
                  titulo={d}
                  fim={
                    <Button variante="simples" onClick={() => void remover(d)}>
                      Remover
                    </Button>
                  }
                />
              ))}
              {!s.dominios.length && (
                <p className="row-nota">Nenhum domínio neste slot.</p>
              )}

              <Campo
                rotulo="Adicionar domínio"
                ajuda={s.temChave
                  ? "O domínio tem de estar verificado nesta conta Resend."
                  : "Defina RESEND_CONTA_" + s.slot +
                    " no servidor para usar este slot."}
              >
                <span className="campo-linha">
                  <input
                    className="campo"
                    spellCheck={false}
                    autoCapitalize="none"
                    placeholder="djairrotta.com.br"
                    value={novo[s.slot] ?? ""}
                    disabled={!s.temChave}
                    onChange={(e) =>
                      setNovo({ ...novo, [s.slot]: e.target.value })}
                  />
                  <Button
                    onClick={() => void atribuir(s.slot)}
                    disabled={!s.temChave || !(novo[s.slot] ?? "").trim()}
                  >
                    Atribuir
                  </Button>
                </span>
              </Campo>

              {s.temChave && (
                <div className="reg-acoes">
                  <Button variante="simples" onClick={() => void testar(s.slot)}>
                    Testar chave
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
        {!slots.some((s) => s.temChave) && (
          <p className="row-nota" role="status">
            Nenhuma chave Resend no servidor. Defina RESEND_CONTA_1 (e afins). O
            envio sai pelo poste.io.
          </p>
        )}
      </Grupo>
    </Pagina>
  );
}
