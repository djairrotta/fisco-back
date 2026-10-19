import Button from "./Button";

export default function ConfirmDialog({
  titulo, texto, onConfirmar, onCancelar,
}: { titulo: string; texto: string; onConfirmar: () => void; onCancelar: () => void }) {
  return (
    <div className="dialog__fundo" onClick={onCancelar}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={titulo} onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog__titulo">{titulo}</h2>
        <p className="dialog__texto">{texto}</p>
        <div className="dialog__acoes">
          <Button variante="secundario" onClick={onCancelar}>Cancelar</Button>
          <Button onClick={onConfirmar}>Confirmar</Button>
        </div>
      </div>
    </div>
  );
}
