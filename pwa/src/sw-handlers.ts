/** Lógica do service worker, separada de sw.ts para ser testável com um escopo falso. */

/** Payload do backend (notify/push.ts): {tipo, titulo, corpo, url, icone?, tag?, ts}. */
interface PayloadPush {
  tipo?: string;
  titulo?: string;
  corpo?: string;
  url?: string;
  icone?: string;
  tag?: string;
  ts?: number;
}

export const ICONE_APP = "/icons/icon-192.png";

/** O SW nunca guarda nem serve /api do cache (a navegação SPA também não cobre /api). */
export const NEGAR_API = [/^\/api(\/|$)/];

// Tipagem mínima do escopo (evita depender de lib WebWorker nos testes).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Escopo = any;

/** Só caminhos internos: um payload nunca abre outro site. */
function urlSegura(url: string | undefined, origem: string): string {
  if (!url) return "/";
  try {
    const u = new URL(url, origem);
    if (u.origin !== origem) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

function iconeSeguro(icone: string | undefined, origem: string): string {
  if (!icone) return ICONE_APP;
  try {
    const u = new URL(icone, origem);
    return u.origin === origem ? u.pathname + u.search : ICONE_APP;
  } catch {
    return ICONE_APP;
  }
}

async function abrir(escopo: Escopo, url: string) {
  const origem: string = escopo.location.origin;
  const janelas: any[] = await escopo.clients.matchAll({ type: "window", includeUncontrolled: true });
  const j = janelas.find((w) => String(w.url).startsWith(origem));
  if (j) {
    try {
      await j.navigate?.(url);
    } catch { /* navegação pode falhar; ao menos foca */ }
    await j.focus?.();
    return;
  }
  await escopo.clients.openWindow(url);
}

export function registrarSw(escopo: Escopo): void {
  escopo.addEventListener("push", (e: any) => {
    let p: PayloadPush = {};
    try {
      p = e.data?.json() ?? {};
    } catch { /* payload inválido: notificação genérica */ }
    const origem: string = escopo.location.origin;
    const url = urlSegura(p.url, origem);
    const tag = p.tag || undefined;
    e.waitUntil(
      escopo.registration.showNotification(p.titulo || "Correio", {
        body: p.corpo ?? "",
        icon: iconeSeguro(p.icone, origem),
        badge: ICONE_APP,
        data: { url },
        ...(tag ? { tag, renotify: true } : {}),
      }),
    );
  });

  escopo.addEventListener("notificationclick", (e: any) => {
    e.notification.close();
    const url = urlSegura(e.notification.data?.url, escopo.location.origin);
    e.waitUntil(abrir(escopo, url));
  });

  escopo.addEventListener("install", () => escopo.skipWaiting?.());
  escopo.addEventListener("activate", (e: any) => e.waitUntil?.(escopo.clients?.claim?.()));
}
