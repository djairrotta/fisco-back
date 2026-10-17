"""
Pesquisa de empresa na internet com o Jev (Browser Use), decidido por modelo do OpenRouter.

Servico separado do backend: precisa de um Chromium rodando, e um
navegador nao cabe no container da API. O backend chama:

    POST /pesquisar   {"nome", "cnpj", "municipio", "uf"}   (cabecalho X-Chave)
    GET  /health

O Jev parte de uma busca no DuckDuckGo (versao HTML, sem JavaScript e sem
captcha), escolhe o site oficial da empresa e abre a pagina de contato. Ele
so navega: quem extrai telefone, e-mail e redes e o modelo de texto, sobre o
texto das paginas VISITADAS, e cada valor so e aceito se aparecer literalmente
nesse texto. Resultado de busca (snippet de terceiros) nao vira contato.

Limites que o codigo impoe, alem dos do Jev:
  - uma pesquisa por vez (um navegador, uma aba de trabalho);
  - teto de passos e de tempo por pesquisa;
  - captcha ou bloqueio: o Jev responde BLOCKED e a pesquisa para. Nada aqui
    tenta contornar protecao de site.
"""

import json
import os
import re
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

from jev_ultrafast import Agent
from jev_ultrafast import browser as _browser
from jev_ultrafast.model import post_json

# So navegar: o Jev nao enxerga campo de texto nem botao de envio, entao nao
# tem como preencher formulario, mandar mensagem ou comprar nada. Clique em
# link, rolagem e espera continuam.
RX_ENVIO = re.compile(r"\b(enviar|envie|submit|send|comprar|assinar|cadastr|inscrev|login|entrar|registr|pagar|checkout)", re.I)
_observar = _browser.Browser.observe


def _observar_so_navegacao(self, screenshot=True):
    p = _observar(self, screenshot=screenshot)
    p["actions"] = [
        a for a in p["actions"]
        if a["kind"] not in ("fill", "select") and a.get("role") not in ("textbox", "searchbox", "combobox") and not (a["kind"] == "click" and a.get("role") != "link" and RX_ENVIO.search(a.get("label", "")))
    ]
    return p


_browser.Browser.observe = _observar_so_navegacao

CHAVE = os.environ.get("JEV_SERVICO_CHAVE", "")
PASSOS_MAX = int(os.environ.get("JEV_PASSOS_MAX", "14"))
TEMPO_MAX_S = float(os.environ.get("JEV_TEMPO_MAX_S", "90"))
BUSCA = "https://html.duckduckgo.com/html/?q={q}"
SITES_DE_BUSCA = ("duckduckgo.com", "bing.com", "google.")
TRAVA = threading.Lock()

RX_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
RX_FONE = re.compile(r"(?:\+?55\s*)?\(?\s*\d{2}\s*\)?\s*(?:9\s*)?\d{4}[\s.-]?\d{4}")


def digitos(s):
    return re.sub(r"\D", "", s or "")


def objetivo(e):
    local = " em ".join(x for x in [e.get("municipio"), e.get("uf")] if x)
    return (
        f"Find the official website of the Brazilian company \"{e['nome']}\""
        + (f" (trade name \"{e['fantasia']}\")" if e.get("fantasia") else "")
        + (f" (CNPJ {e['cnpj']})" if e.get("cnpj") else "")
        + (f", located {local}" if local else "")
        + ". From the search results, open the result that is the company's OWN website "
        "(not a CNPJ directory, not a news site, not a social network). Then open its contact page "
        "('Contato', 'Fale conosco', 'Contact') if there is one. Stop with DONE when the company's phone "
        "number or e-mail is visible on its own website. If no result is clearly this company's own "
        "website, stop with DONE on the search results. Never fill forms or send messages."
    )


def pesquisar(e):
    """Roda o Jev e devolve o que foi visto. Uma por vez (TRAVA)."""
    termo = (e.get("busca") or e["nome"]).strip()
    consulta = " ".join(x for x in [f"\"{termo}\"", e.get("municipio"), e.get("uf")] if x)
    url = BUSCA.format(q=urllib.parse.quote_plus(consulta))
    paginas, passos, status, erro = {}, [], "ready", None
    inicio = time.monotonic()

    def guardar(estado):
        p = estado["page"]
        if p.get("url") and p.get("text"):
            paginas[p["url"]] = {"url": p["url"], "titulo": p.get("title", ""), "texto": p["text"][:12000]}

    with TRAVA:
        agente = Agent(url, objetivo(e))
        try:
            guardar(agente.state)
            for estado in agente.run():
                guardar(agente.state)
                passos = [
                    {k: h.get(k) for k in ("step", "action", "kind", "url")} for h in estado["history"]
                ]
                status = estado["status"]
                if len(estado["history"]) >= PASSOS_MAX or time.monotonic() - inicio > TEMPO_MAX_S:
                    status = "limite"
                    break
            status = agente.state["status"] if status != "limite" else status
        except Exception as ex:  # noqa: BLE001 - qualquer falha vira resposta, nao derruba o servico
            erro = str(ex)[:300]
            status = "erro"
        finally:
            try:
                agente.close()
            except Exception:  # noqa: BLE001
                pass

    return {
        "status": status,
        "erro": erro,
        "passos": passos,
        "paginas": list(paginas.values()),
        "duracao_ms": round((time.monotonic() - inicio) * 1000),
    }


EXTRAIR = """Você recebe o texto de páginas de sites visitadas ao pesquisar uma empresa brasileira.
Extraia SOMENTE dados que estejam escritos nas páginas e que sejam da própria empresa pesquisada.
Ignore páginas de buscador e de diretórios de CNPJ. Não invente nada. Responda um JSON:
{"site": url do site oficial ou null, "telefones": [], "emails": [], "whatsapp": null,
 "instagram": null, "facebook": null, "linkedin": null, "endereco": null,
 "atividade": "o que a empresa faz, em uma frase, ou null",
 "mesma_empresa": true|false|null, "observacao": "curta, em português"}"""


def extrair(e, visto):
    paginas = [p for p in visto["paginas"] if not any(s in p["url"] for s in SITES_DE_BUSCA)]
    resultado = {"site": None, "telefones": [], "emails": [], "whatsapp": None, "instagram": None,
                 "facebook": None, "linkedin": None, "endereco": None, "atividade": None,
                 "mesma_empresa": None, "observacao": None}
    if not paginas:
        resultado["observacao"] = "Nenhum site próprio da empresa foi aberto."
        return resultado, []

    corpo = "\n\n".join(f"### {p['url']}\n{p['titulo']}\n{p['texto'][:6000]}" for p in paginas[:4])
    chave = os.environ.get("TEXT_MODEL_API_KEY")
    if chave:
        try:
            r = post_json(
                os.environ.get("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/") + "/chat/completions",
                chave,
                {
                    "model": os.environ.get("EXTRACAO_MODEL", os.environ.get("TEXT_MODEL", "inception/mercury-2.5")),
                    "max_tokens": 900,
                    "response_format": {"type": "json_object"},
                    "reasoning": {"enabled": False},
                    "messages": [
                        {"role": "system", "content": EXTRAIR},
                        {"role": "user", "content": json.dumps(
                            {"empresa": {k: e.get(k) for k in ("nome", "cnpj", "municipio", "uf")},
                             "paginas": corpo}, ensure_ascii=False)},
                    ],
                },
            )
            bruto = json.loads(r["choices"][0]["message"]["content"])
            if isinstance(bruto, dict):
                resultado.update({k: bruto.get(k) for k in resultado})
        except Exception as ex:  # noqa: BLE001
            resultado["observacao"] = f"Extração por modelo falhou: {str(ex)[:120]}"

    # O modelo leu as paginas e disse que o site e de OUTRA empresa: nenhum
    # contato dali serve (nem o achado por regex).
    if resultado.get("mesma_empresa") is False:
        return {**{k: (None if not isinstance(v, list) else []) for k, v in resultado.items()},
                "mesma_empresa": False, "observacao": resultado.get("observacao") or "O site aberto é de outra empresa."}, []

    # Prova: cada contato tem que estar escrito em alguma pagina visitada.
    texto_total = "\n".join(p["texto"] for p in paginas)
    numeros = digitos(texto_total)
    evidencias = []

    def fonte(trecho):
        for p in paginas:
            if trecho.lower() in p["texto"].lower() or (digitos(trecho) and digitos(trecho) in digitos(p["texto"])):
                return p["url"]
        return None

    fones = []
    for f in [*(resultado.get("telefones") or []), *RX_FONE.findall(texto_total)]:
        d = digitos(f)
        if d.startswith("55") and len(d) > 11:
            d = d[2:]
        if 10 <= len(d) <= 11 and d in numeros and d not in fones:
            fones.append(d)
            evidencias.append({"campo": "telefone", "valor": d, "url": fonte(d)})
    emails = []
    for m in [*(resultado.get("emails") or []), *RX_EMAIL.findall(texto_total)]:
        m = (m or "").strip().lower().rstrip(".")
        if RX_EMAIL.fullmatch(m) and m in texto_total.lower() and m not in emails and not m.endswith((".png", ".jpg")):
            emails.append(m)
            evidencias.append({"campo": "email", "valor": m, "url": fonte(m)})
    resultado["telefones"], resultado["emails"] = fones[:6], emails[:6]

    # Site: so vale um endereco efetivamente visitado.
    visitados = [p["url"] for p in paginas]
    site = resultado.get("site")
    if site and not any(urllib.parse.urlparse(site).netloc in v for v in visitados):
        site = None
    resultado["site"] = site or (urllib.parse.urlunparse(urllib.parse.urlparse(visitados[0])._replace(path="/", query="", fragment="")) if visitados else None)
    for rede in ("instagram", "facebook", "linkedin", "whatsapp"):
        v = resultado.get(rede)
        if v and str(v).lower() not in texto_total.lower() and digitos(str(v)) not in numeros:
            resultado[rede] = None
    return resultado, evidencias


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, corpo):
        dados = json.dumps(corpo, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def log_message(self, fmt, *args):
        print("[jev]", fmt % args, flush=True)

    def do_GET(self):
        if self.path != "/health":
            return self._json(404, {"erro": "rota"})
        try:
            httpx.get(os.environ.get("BU_CDP_URL", "http://127.0.0.1:9222") + "/json/version", timeout=3).raise_for_status()
            navegador = "ok"
        except Exception:  # noqa: BLE001
            navegador = "fora"
        return self._json(200, {
            "ok": navegador == "ok",
            "navegador": navegador,
            "modelo": bool(os.environ.get("TEXT_MODEL_API_KEY")),
            "ocupado": TRAVA.locked(),
        })

    def do_POST(self):
        if self.path != "/pesquisar":
            return self._json(404, {"erro": "rota"})
        if not CHAVE or self.headers.get("x-chave") != CHAVE:
            return self._json(401, {"erro": "chave inválida"})
        if not os.environ.get("TEXT_MODEL_API_KEY"):
            return self._json(412, {"erro": "Falta TEXT_MODEL_API_KEY (OpenRouter) no serviço de pesquisa (fiscojev)."})
        try:
            e = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except ValueError:
            return self._json(400, {"erro": "JSON inválido"})
        if not (e.get("nome") or "").strip():
            return self._json(400, {"erro": "Informe o nome da empresa"})
        if TRAVA.locked():
            return self._json(429, {"erro": "Outra pesquisa está em andamento. Tente em um minuto."})
        try:
            visto = pesquisar(e)
            dados, evidencias = extrair(e, visto)
            return self._json(200, {
                **dados,
                "evidencias": evidencias,
                "status_navegacao": visto["status"],
                "erro_navegacao": visto["erro"],
                "paginas_visitadas": [p["url"] for p in visto["paginas"]],
                "passos": visto["passos"],
                "duracao_ms": visto["duracao_ms"],
            })
        except Exception as ex:  # noqa: BLE001
            traceback.print_exc()
            return self._json(500, {"erro": f"Pesquisa falhou: {str(ex)[:200]}"})


if __name__ == "__main__":
    porta = int(os.environ.get("PORT", "8000"))
    print(f"[jev] ouvindo em {porta}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", porta), Handler).serve_forever()
