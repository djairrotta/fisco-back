import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "Correio",
        short_name: "Correio",
        description: "E-mail das caixas de domínio próprio",
        lang: "pt-BR",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: "#f2f2f7",
        background_color: "#f2f2f7",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // Só estáticos do build; /api nunca entra no precache nem em cache de runtime.
      injectManifest: { globPatterns: ["**/*.{js,css,html,png,svg}"], globIgnores: ["**/api/**"] },
      devOptions: { enabled: false },
    }),
  ],
  server: { proxy: { "/api": "http://localhost:8000" } },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
