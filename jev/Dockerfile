# Servico de pesquisa na internet (Jev). Contexto de build: esta pasta (jev/).
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "browser-harness==0.1.13" "httpx[http2]"

WORKDIR /app
COPY jev_ultrafast ./jev_ultrafast
COPY servico.py entrypoint.sh LICENSE-jev-ultrafast ./

ENV PORT=8000 \
    BU_CDP_URL=http://127.0.0.1:9222 \
    BH_TELEMETRY=off \
    ANONYMIZED_TELEMETRY=false \
    BH_UPDATE_CHECK=off \
    TYPESAFE_MODEL=jev-latest \
    TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1 \
    TEXT_MODEL=inception/mercury-2.5 \
    TEXT_MODEL_REASONING=none

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["./entrypoint.sh"]
