#!/usr/bin/env python3
"""fallback_router.py - one function, many free providers, automatic failover.

Every provider in data/providers.json speaks the OpenAI Chat Completions shape, so a
"router" is just: try lane 1 -> on 429/5xx/DNS error -> try lane 2 -> ... Each lane is
(model, base_url, key). The first lane that answers wins; you get back (text, lane_name).

Run as a script to smoke-test whichever keys you have in .env:
    python3 examples/fallback_router.py "explain rate limits in one sentence"

Import it in your project:
    from fallback_router import complete
    text, used = complete([...], "hello")
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# lane order = your preference. Swap in the models you actually have access to.
DEFAULT_LANES = [
    # (name, base_url, model, key env)
    ("groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b", "GROQ_API_KEY"),
    ("cerebras", "https://api.cerebras.ai/v1", "gpt-oss-120b", "CEREBRAS_API_KEY"),
    ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-3.5-flash", "GEMINI_API_KEY"),
    ("openrouter", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat-v3.1:free", "OPENROUTER_API_KEY"),
    ("nous", "https://inference-api.nousresearch.com/v1", "stepfun/step-3.7-flash:free", "NOUS_PORTAL_API_KEY"),
    ("llm7", "https://api.llm7.io/v1", "gpt-4o-mini", "LLM7_API_KEY"),
    ("ollama", "http://localhost:11434/v1", "qwen3:8b", "OLLAMA_API_KEY"),  # local, always free
]

RETRYABLE = {0, 408, 409, 425, 429, 500, 502, 503, 504}


def load_env() -> None:
    p = ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line.strip()
        if not line.strip() or line.strip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def _one(base_url: str, model: str, key: str, prompt: str, timeout: int, system: str | None) -> str:
    msgs = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": prompt}
    ]
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": msgs, "max_tokens": 512}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return data["choices"][0]["message"]["content"]


def complete(prompt: str, lanes=None, system: str | None = None, timeout: int = 45) -> tuple[str, str]:
    """Return (answer, lane_name). Raises RuntimeError if every lane fails."""
    load_env()
    lanes = lanes or DEFAULT_LANES
    errors = []
    for name, base_url, model, env in lanes:
        key = os.environ.get(env) or ("local" if "localhost" in base_url else "")
        if not key:
            errors.append(f"{name}: {env} missing")
            continue
        try:
            return _one(base_url, model, key, prompt, timeout, system), name
        except urllib.error.HTTPError as e:
            body = e.read(200).decode("utf-8", "replace")
            errors.append(f"{name}: HTTP {e.code} {body[:80]}")
            continue
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {type(e).__name__} {e}")
            continue
    raise RuntimeError("all lanes failed:\n  " + "\n  ".join(errors))


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "Say hello in five words."
    try:
        answer, lane = complete(q)
        print(f"[{lane}] {answer}")
    except RuntimeError as e:
        print(e)
        raise SystemExit(1)
