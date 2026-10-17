"""Escolhas e valores de campo por um modelo OpenAI-compatible (OpenRouter).

ALTERADO no fisco: o Jev original decidia cada passo pela API da TypeSafe.
Aqui a decisao (operacao + alvo) e uma chamada de chat ao OpenRouter com
resposta JSON validada contra os indices observados. Nada da TypeSafe.
"""

import json
import os
import time

import httpx

from .questions import NEXT_ACTION, TARGET, TEXT_VALUE

CLIENT = httpx.Client(http2=True, timeout=25)


def post_json(url, key, body):
    for attempt in range(3):
        try:
            response = CLIENT.post(url, json=body, headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError:
            raise RuntimeError("Model connection failed; no action executed.") from None
        if response.status_code in {429, 529, 503} and attempt < 2:
            time.sleep(0.5 * 2**attempt)
            continue
        if response.is_error:
            raise RuntimeError(f"Model provider returned HTTP {response.status_code}; no action executed.")
        return response.json()
    raise RuntimeError("Model unavailable")


def action_space(actions):
    """One index per observed element; each operation has its own valid target choices."""
    elements, indices, targets, controls = [], {}, {}, {}
    operations = {"click": "CLICK", "fill": "TYPE_TEXT", "select": "SELECT"}
    for action in actions:
        kind = action["kind"]
        if kind not in operations:
            controls[action["id"].upper()] = action
            continue
        node = action["node"]
        if node not in indices:
            index = str(len(elements) + 1)
            indices[node] = index
            element = {k: action[k] for k in ("role", "value", "checked", "selected", "expanded") if k in action}
            element.update(index=index, label=action["label"].split(" → ")[0], operations=[])
            if kind == "select":
                element["value"] = action.get("current_value", "")
                element["options"] = []
            elements.append(element)
        index = indices[node]
        operation = operations[kind]
        group = targets.setdefault(operation, {})
        element = elements[int(index) - 1]
        if operation not in element["operations"]:
            element["operations"].append(operation)
        target = index
        if kind == "select":
            target = f"{index}:{len(element['options']) + 1}"
            element["options"].append({"index": target, "label": action["label"], "value": action["value"]})
        group[target] = action
    return elements, targets, controls


def _modelo():
    base = os.environ.get("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
    key = os.environ.get("TEXT_MODEL_API_KEY")
    if not key:
        raise ValueError("Falta TEXT_MODEL_API_KEY (OpenRouter); nenhuma acao executada.")
    reasoning = {"reasoning": {"enabled": False}} if os.environ.get("TEXT_MODEL_REASONING") == "none" else {}
    return base, key, reasoning


def choose(state, goal, history):
    elements, targets, controls = action_space(state["actions"])
    labels = {
        "CLICK": "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
        "TYPE_TEXT": "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
        "SELECT": "Select an observed dropdown value.",
    }
    operations = {key: labels[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations.update(DONE="Every requirement is visibly satisfied.", BLOCKED="No supported operation can progress.")
    body_state = {
        "goal": goal,
        "page": {"url": state["url"], "title": state["title"], "text": state["text"][:5000]},
        "operations": operations,
        "targets": {
            op: {i: a["label"][:160] for i, a in cands.items()} for op, cands in targets.items()
        },
        "recent_actions": [
            {k: h.get(k) for k in ("action", "kind", "url", "page_changed")} for h in history[-10:]
        ],
    }
    system = (
        NEXT_ACTION + "\n\n" + TARGET + "\n\n"
        'Answer ONLY a JSON object: {"operation": one key of operations, '
        '"target": the target index (string) when the operation has targets, else null, '
        '"reason": short}. Never pick an index that is not listed.'
    )
    base, key, reasoning = _modelo()
    model = os.environ.get("NAV_MODEL") or os.environ.get("TEXT_MODEL", "inception/mercury-2.5")
    started = time.perf_counter()
    result = post_json(base + "/chat/completions", key, {
        "model": model,
        "max_tokens": 300,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        **reasoning,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": json.dumps(body_state, ensure_ascii=False)}],
    })
    try:
        bruto = result["choices"][0]["message"]["content"].strip()
        if bruto.startswith("```"):
            bruto = bruto.strip("`").removeprefix("json").strip()
        answer = json.loads(bruto)
        operation = str(answer["operation"]).upper()
        if operation not in operations:
            raise ValueError()
        target = None
        if operation in targets:
            target = str(answer.get("target"))
            if target not in targets[operation]:
                raise ValueError()
            choice = targets[operation][target]["id"]
        else:
            choice = controls[operation]["id"] if operation in controls else operation
    except (KeyError, TypeError, ValueError, IndexError):
        raise ValueError("Resposta invalida do modelo de navegacao; nenhuma acao executada.") from None
    return {
        "choice": choice,
        "operation": operation,
        "target": target,
        "confidence": 1.0,
        "probabilities": {choice: 1.0},
        "operation_probabilities": {},
        "target_probabilities": {},
        "target_confidence": None,
        "raw_answers": answer,
        "model": model,
        "usage": result.get("usage", {}),
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "request": body_state,
    }


def field_context(goal, action, page, history):
    return {
        "goal": goal,
        "field": {k: action.get(k) for k in ("label", "role", "value")},
        "page": {"title": page["title"], "text": page["text"][:6000]},
        "recent_actions": [{k: h.get(k) for k in ("action", "text")} for h in history[-6:]],
    }


def field_text(context):
    base, key, reasoning = _modelo()
    model = os.environ.get("TEXT_MODEL", "inception/mercury-2.5")
    started = time.perf_counter()
    result = post_json(
        base + "/chat/completions",
        key,
        {
            "model": model,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
            **reasoning,
            "messages": [
                {"role": "system", "content": TEXT_VALUE},
                {
                    "role": "user",
                    "content": json.dumps(context),
                },
            ],
        },
    )
    try:
        output = json.loads(result["choices"][0]["message"]["content"])
        value = output["text"]
        if set(output) != {"text"} or not isinstance(value, str) or not value.strip() or len(value) > 2000:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError("Text helper returned no valid field value; nothing typed.") from None
    return value, {
        "model": model,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": result.get("usage", {}),
    }
