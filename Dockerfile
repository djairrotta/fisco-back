# Correio em um único container (API + PWA). Build na pasta correio/
# (ou na raiz do zip gerado por scripts/empacotar-easypanel.sh).

# ---- 1) PWA ---------------------------------------------------------------
FROM node:22-alpine AS pwa
WORKDIR /pwa
COPY pwa/package.json pwa/package-lock.json ./
RUN npm ci
COPY pwa/ ./
RUN npm run build

# ---- 2) Backend Deno + PWA estático ---------------------------------------
FROM denoland/deno:2.9.7
WORKDIR /app
ENV DENO_DIR=/app/.deno
RUN mkdir -p /app/.deno /app/public /data && chown -R deno:deno /app /data
USER deno
COPY --chown=deno:deno backend/deno.json backend/deno.lock backend/main.ts ./
COPY --chown=deno:deno backend/src ./src
RUN deno cache --lock=deno.lock main.ts
COPY --from=pwa --chown=deno:deno /pwa/dist ./public

# Usuário não-root não abre a porta 80: no EasyPanel use a porta 8080.
ENV PORT=8080 \
    CORREIO_PUBLIC_DIR=/app/public \
    CORREIO_DATA_DIR=/data
# Segredos gerados (correio-segredos.json) ficam aqui: monte um volume.
VOLUME /data
EXPOSE 8080
# Liveness (/api/vivo: só o processo). /api/saude depende do banco e fica para
# monitoração externa; usá-lo aqui causaria loop de restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD deno eval "const r = await fetch('http://127.0.0.1:' + (Deno.env.get('PORT') ?? '8080') + '/api/vivo'); Deno.exit(r.ok ? 0 : 1)" || exit 1
# --allow-sys=hostname: imapflow (pino) e nodemailer leem os.hostname() ao carregar.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/app,/data", "--allow-write=/data", "--allow-sys=hostname", "main.ts"]
