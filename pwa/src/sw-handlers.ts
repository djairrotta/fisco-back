/** Lógica do service worker, separada de sw.ts para ser testável com um escopo falso. */

interface Acao {
  acao: string;
  titulo: string;
}
interface PayloadPush {
  titulo?: string;
  corpo?: string;
  url?: string;
  acoes?: Acao[];
  tipo?: string;
  ts?: number;
}

// Tipagem mínima do escopo (evita depender de lib WebWorker nos testes).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Escopo = any;

function idsBloqueio(url: string, origem: string): string[] {
  return new URL(url, origem).searchParams.getAll("bloqueio")
    .flatMap((v) => v.split(","))
    .filter((x) => /^\d+$/.test(x));
}

/** Tag única por incidente/bloqueio: notificações diferentes do mesmo tipo não se substituem. */
function tagDe(tipo: string | undefined, url: string, origem: string): string {
  const t = tipo ?? "vigia";
  let alvo = url;
  try {
    const u = new URL(url, origem);
    const inc = u.pathname.match(/^\/incidentes\/(\d+)/);
    const bloq = idsBloqueio(url, origem);
    alvo = inc ? inc[1] : bloq.length ? `b${bloq.join(",")}` : u.pathname + u.search;
  } catch { /* url inválida: usa como veio */ }
  return `${t}:${alvo}`;
}

function urlInvestigar(url: string, origem: string): string {
  const u = new URL(url, origem);
  return `${u.pathname}?investigar=1`;
}

/** id do pedido de conector embutido na url do push (?pedido=<id>). */
function pedidoDe(url: string, origem: string): string | null {
  const v = new URL(url, origem).searchParams.get("pedido");
  return v && /^\d+$/.test(v) ? v : null;
}

/** Ações do push de conector → modo da decisão. */
const MODO_CONECTOR: Record<string, string> = {
  conector_tmp: "temporario",
  conector_perm: "permanente",
  conector_bloq: "bloquear",
};

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
    const url = p.url || "/";
    e.waitUntil(
      escopo.registration.showNotification(p.titulo || "Vigia", {
        body: p.corpo ?? "",
        data: { url },
        actions: (p.acoes ?? []).map((a) => ({ action: a.acao, title: a.titulo })),
        tag: tagDe(p.tipo, url, escopo.location.origin),
        renotify: true,
      }),
    );
  });

  escopo.addEventListener("notificationclick", (e: any) => {
    e.notification.close();
    const origem: string = escopo.location.origin;
    const url: string = e.notification.data?.url || "/";
    e.waitUntil(
      (async () => {
        if (e.action === "desfazer") {
          for (const id of idsBloqueio(url, origem)) {
            try {
              await fetch(`/api/bloqueios/${id}/desfazer`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
            } catch { /* o app mostra o estado real ao abrir */ }
          }
          await abrir(escopo, url);
        } else if (e.action in MODO_CONECTOR) {
          const id = pedidoDe(url, origem);
          if (id) {
            try {
              await fetch(`/api/conector/pedidos/${id}/decidir`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ modo: MODO_CONECTOR[e.action] }),
              });
            } catch { /* o app mostra o estado real ao abrir */ }
          }
          await abrir(escopo, url);
        } else if (e.action === "investigar") {
          await abrir(escopo, urlInvestigar(url, origem));
        } else {
          await abrir(escopo, url);
        }
      })(),
    );
  });

  escopo.addEventListener("install", () => escopo.skipWaiting?.());
  escopo.addEventListener("activate", (e: any) => e.waitUntil?.(escopo.clients?.claim?.()));
}
