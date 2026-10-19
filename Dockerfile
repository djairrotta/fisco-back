# Vigia em um único container (API + PWA). Build na raiz do repositório
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
# ssh/ssh-keygen: comandos de leitura no servidor (lista fechada) e SMART.
# procps não é necessário: a telemetria lê /host/proc direto.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV DENO_DIR=/app/.deno
RUN mkdir -p /app/.deno /app/public /data && chown -R deno:deno /app /data
USER deno
COPY --chown=deno:deno backend/deno.json backend/deno.lock backend/main.ts ./
COPY --chown=deno:deno backend/src ./src
COPY --chown=deno:deno backend/scripts ./scripts
RUN deno cache --lock=deno.lock main.ts
COPY --from=pwa --chown=deno:deno /pwa/dist ./public

# Usuário não-root não abre a porta 80: no EasyPanel use a porta 8080.
ENV PORT=8080 \
    VIGIA_PUBLIC_DIR=/app/public \
    VIGIA_DATA_DIR=/data
# Segredos gerados (vigia-segredos.json) ficam aqui: monte um volume.
VOLUME /data
EXPOSE 8080
# Liveness (/api/vivo: só o processo). /api/saude depende do banco e do ciclo e
# fica para monitoração externa; usá-lo aqui causaria loop de restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD deno eval "const r = await fetch('http://127.0.0.1:' + (Deno.env.get('PORT') ?? '8080') + '/api/vivo'); Deno.exit(r.ok ? 0 : 1)" || exit 1
# /host: /proc e /sys do servidor montados só para leitura (tela Servidor).
# run: ssh/ssh-keygen (lista fechada, ver src/host/ssh.ts), dd (teste de disco) e df.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/app,/data,/host,/proc,/sys", "--allow-write=/data", "--allow-run=ssh,ssh-keygen,dd,df", "main.ts"]
