import Button from "./Button";
import Folha from "./Folha";

export default function ConfirmDialog({
  titulo, texto, onConfirmar, onCancelar,
}: { titulo: string; texto: string; onConfirmar: () => void; onCancelar: () => void }) {
  return (
    <Folha rotulo={titulo} papel="alertdialog" className="dialog--confirma" onFechar={onCancelar}>
      <h2 className="dialog__titulo">{titulo}</h2>
      <p className="dialog__texto">{texto}</p>
      <div className="dialog__acoes">
        <Button variante="secundario" onClick={onCancelar}>Cancelar</Button>
        <Button onClick={onConfirmar}>Confirmar</Button>
      </div>
    </Folha>
  );
}
