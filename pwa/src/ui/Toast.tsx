import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import Icone, { type NomeIcone } from "./Icone";
import { Portal } from "./Camadas";

interface Aviso { id: number; texto: string; icone?: NomeIcone; tom: "neutro" | "perigo"; acao?: { rotulo: string; fn: () => void } }
interface Ctx { mostrar: (texto: string, opc?: { icone?: NomeIcone; tom?: "neutro" | "perigo"; acao?: Aviso["acao"] }) => void }

const ToastCtx = createContext<Ctx>({ mostrar: () => {} });
export const useToast = () => useContext(ToastCtx);

/** Cápsula discreta na base; some sozinha em 3,6 s. Uma por vez. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [saindo, setSaindo] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mostrar = useCallback<Ctx["mostrar"]>((texto, opc = {}) => {
    t.current.forEach(clearTimeout);
    setSaindo(false);
    setAviso({ id: Date.now(), texto, icone: opc.icone, tom: opc.tom ?? "neutro", acao: opc.acao });
    t.current = [
      setTimeout(() => setSaindo(true), 3600),
      setTimeout(() => setAviso(null), 3800),
    ];
  }, []);
  const valor = useMemo(() => ({ mostrar }), [mostrar]);
  return (
    <ToastCtx.Provider value={valor}>
      {children}
      <Portal>
        <div className="toasts" role="status" aria-live="polite">
          {aviso && (
            <div key={aviso.id} className={`toast toast--${aviso.tom}${saindo ? " toast--saindo" : ""}`}>
              {aviso.icone && <Icone nome={aviso.icone} tam={16} />}
              <span>{aviso.texto}</span>
              {aviso.acao && <button type="button" className="toast__acao" onClick={() => { aviso.acao!.fn(); setAviso(null); }}>{aviso.acao.rotulo}</button>}
            </div>
          )}
        </div>
      </Portal>
    </ToastCtx.Provider>
  );
}
