#!/usr/bin/env bash
# =====================================================================
# Instalador automatico — fisco-backend
# Sobe o app no EasyPanel/Docker Swarm, cria o .env e aplica migracoes.
# Uso:  ./instalar.sh
# =====================================================================
set -euo pipefail
APP="fisco-backend"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

azul(){ printf '\033[1;34m%s\033[0m\n' "$*"; }
ok(){   printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
erro(){ printf '\033[1;31merro:\033[0m %s\n' "$*" >&2; exit 1; }

azul "== instalando $APP =="

command -v docker >/dev/null || erro "docker nao encontrado"
docker compose version >/dev/null 2>&1 || erro "docker compose v2 nao encontrado"

# --- .env ---
if [ ! -f .env ]; then
  cp .env.example .env
  if grep -q '^JWT_SECRET=' .env; then
    SEG="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
    sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$SEG|" .env && rm -f .env.bak
    ok "JWT_SECRET gerado"
  fi
  ok ".env criado a partir de .env.example"
  azul "   Edite .env antes de usar em producao (chaves de API e banco)."
else
  ok ".env ja existe, mantido"
fi

# --- rede externa compartilhada do EasyPanel ---
if ! docker network inspect judinfo >/dev/null 2>&1; then
  docker network create judinfo >/dev/null && ok "rede 'judinfo' criada"
else
  ok "rede 'judinfo' ja existe"
fi

azul "-- build --"
docker compose build

azul "-- subindo --"
docker compose up -d

azul "-- aguardando o banco --"
for i in $(seq 1 30); do
  if docker compose exec -T api node -e "process.exit(0)" >/dev/null 2>&1; then break; fi
  sleep 2
done

azul "-- migracoes (schema, 54 particoes, indices, views) --"
docker compose exec -T api npm run migrate || erro "migracao falhou — confira DATABASE_URL no .env"
ok "banco pronto"

azul "-- carregando regras de tese --"
docker compose exec -T api npm run teses:load || true

azul ""
azul "PROXIMO PASSO — a carga dos dados e manual, de proposito:"
azul "  1. baixe os CSV em https://dadosabertos.pgfn.gov.br"
azul "  2. docker compose exec api npm run etl:pgfn -- /app/data/download/x.csv PGFN_GERAL 2026-06-30"
azul "  3. docker compose exec api npm run etl:refresh"

azul ""
azul "== $APP no ar =="
docker compose ps
