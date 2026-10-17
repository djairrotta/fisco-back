#!/bin/sh
# Chromium sem interface, so para o Jev. A porta de depuracao fica no
# localhost do container: ninguem de fora alcanca o navegador.
set -e
rm -rf /tmp/chrome && mkdir -p /tmp/chrome
chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --disable-extensions \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome --window-size=1120,780 --lang=pt-BR \
  about:blank >/tmp/chrome.log 2>&1 &
for i in $(seq 1 50); do
  curl -sf http://127.0.0.1:9222/json/version >/dev/null && break
  sleep 0.2
done
exec python -u servico.py
