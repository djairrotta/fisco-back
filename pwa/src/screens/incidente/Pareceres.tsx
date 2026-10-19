import { Card } from "../../ui";

export interface Parecer { papel: string; modelo: string; classe: string; confianca: number; justificativa: string; ok: boolean }

const ORDEM = ["jev", "segunda", "terceira"];

export default function Pareceres({ itens }: { itens: Parecer[] }) {
  return (
    <Card>
      <div className="pareceres">
        {ORDEM.map((papel) => {
          const p = itens.find((x) => x.papel === papel);
          return (
            <div className="parecer" key={papel}>
              <h3>{papel}</h3>
              {!p || !p.ok ? (
                <span>sem resposta</span>
              ) : (
                <>
                  <div>{p.classe}</div>
                  <div className="parecer__conf">{Math.round(p.confianca * 100)}%</div>
                  <div>{p.justificativa}</div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
