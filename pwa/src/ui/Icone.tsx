// Um só conjunto de ícones (Lucide, traço fino como os SF Symbols) com
// espessura padronizada pelo CSS (.ic). Nada de SVG feito à mão.
import {
  Archive, ArrowUpRight, Ban, Bell, Bold, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown,
  CircleAlert, Clock, Download, File, FileText, Fingerprint, Folder, FolderInput, Forward, Inbox,
  Italic, KeyRound, Link, List, LogOut, Mail, MailOpen, Maximize2, Menu, Minimize2, Minus, MoreHorizontal,
  PanelLeft, Paperclip, PenLine, Plus, RefreshCw, Reply, ReplyAll, Search, Send, Settings, ShieldAlert,
  ShieldCheck, SlidersHorizontal, Sparkles, SquarePen, Star, Trash2, X, Mails, Image as Imagem, Signature, CalendarClock, Copy, Palette, Eye, Undo2, Workflow, PlaneTakeoff, Upload, Loader,
  type LucideIcon,
} from "lucide-react";

export const I = {
  entrada: Inbox, favoritos: Star, rascunhos: FileText, saida: Clock, enviados: Send, arquivo: Archive,
  spam: ShieldAlert, lixeira: Trash2, pasta: Folder, mover: FolderInput, responder: Reply, todos: ReplyAll,
  encaminhar: Forward, mais: MoreHorizontal, buscar: Search, escrever: SquarePen, caneta: PenLine, ajustes: Settings,
  caixas: Mails, menu: Menu, lateral: PanelLeft, abaixo: ChevronDown, voltar: ChevronLeft, avancar: ChevronRight,
  trocar: ChevronsUpDown, alerta: CircleAlert, baixar: Download, arquivo_: File, passkey: Fingerprint, chave: KeyRound,
  negrito: Bold, italico: Italic, lista: List, link: Link, sair: LogOut, lida: MailOpen, naoLida: Mail,
  maximizar: Maximize2, restaurar: Minimize2, minimizar: Minus, fechar: X, ok: Check, mais_: Plus, atualizar: RefreshCw,
  clipe: Paperclip, filtros: SlidersHorizontal, notificacoes: Bell, ia: Sparkles, seguro: ShieldCheck, naoSpam: ShieldCheck,
  bloquear: Ban, externo: ArrowUpRight, imagem: Imagem, assinatura: Signature, calendario: CalendarClock, copiar: Copy,
  aparencia: Palette, olho: Eye, desfazer: Undo2, regras: Workflow, ferias: PlaneTakeoff, enviar_: Upload, carregando: Loader,
} satisfies Record<string, LucideIcon>;

export type NomeIcone = keyof typeof I;

export default function Icone({ nome, tam = 18, className = "", rotulo }: { nome: NomeIcone; tam?: number; className?: string; rotulo?: string }) {
  const C = I[nome];
  return (
    <C className={`ic ${className}`.trim()} width={tam} height={tam} strokeWidth={1.75}
      aria-hidden={rotulo ? undefined : true} aria-label={rotulo} role={rotulo ? "img" : undefined} />
  );
}
