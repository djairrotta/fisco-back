/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NEGAR_API, registrarSw } from "./sw-handlers";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

cleanupOutdatedCaches();
// Só o build (js/css/html/ícones). Sem cache de runtime: /api vai sempre à rede.
precacheAndRoute(self.__WB_MANIFEST.filter((e) => !NEGAR_API[0].test(typeof e === "string" ? e : e.url)));
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: NEGAR_API }));
registrarSw(self);
