import { api } from "./api";

function b64urlParaBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const pushSuportado = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

export type ResultadoPush = "ativado" | "negado" | "nao_suportado";

/** Pede permissão, assina com a chave VAPID do backend e registra a inscrição. */
export async function ativarPush(): Promise<ResultadoPush> {
  if (!pushSuportado() || typeof Notification === "undefined") return "nao_suportado";
  const permissao = await Notification.requestPermission();
  if (permissao !== "granted") return "negado";
  const { chave } = await api.get<{ chave: string }>("/api/push/chave-publica");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlParaBytes(chave),
    }));
  await api.post("/api/push/inscrever", sub.toJSON());
  return "ativado";
}

/** Inscrição atual deste dispositivo (null se não há). */
export async function inscricaoAtual(): Promise<PushSubscription | null> {
  if (!pushSuportado()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Cancela no navegador e no backend (idempotente). */
export async function desativarPush(): Promise<void> {
  const sub = await inscricaoAtual();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await api.post("/api/push/cancelar", { endpoint });
}
