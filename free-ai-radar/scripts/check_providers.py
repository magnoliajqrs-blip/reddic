#!/usr/bin/env python3
"""check_providers.py - probe every free-tier provider in data/providers.json with YOUR keys.

What it does, per provider:
  1. GET <base_url>/models  (auth: Bearer <key>)  -> is the key alive? how many models?
  2. optional: POST <base_url>/chat/completions with a 2-token prompt -> is generation working?

Nothing is sent anywhere except the provider itself. Keys are read from the environment
(or a .env file next to this repo root). Missing keys are skipped, not failed.

Usage:
    cp .env.example .env      # then paste the keys you actually have
    python3 scripts/check_providers.py                 # models endpoint only
    python3 scripts/check_providers.py --chat          # + one tiny completion per provider
    python3 scripts/check_providers.py --only groq,cerebras
    python3 scripts/check_providers.py --json          # machine-readable

Output: HEALTH.md (table) + console summary. Exit code 0 always unless nothing was probed.
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "providers.json"
OUT_MD = ROOT / "HEALTH.md"
TIMEOUT = 20


def load_env() -> None:
    """Minimal .env loader (no python-dotenv dependency)."""
    for name in (".env", ".env.local"):
        p = ROOT / name
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def call(url: str, key: str | None, payload: dict | None = None) -> tuple[int, dict | str, float]:
    body = json.dumps(payload).encode() if payload else None
    headers = {"Accept": "application/json", "User-Agent": "free-ai-radar/1.0"}
    if body:
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = f"Bearer {key}"
        headers["x-api-key"] = key  # some Anthropic-shaped endpoints want this
    req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body else "GET")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl.create_default_context()) as r:
            raw = r.read(400_000)
            ms = (time.perf_counter() - t0) * 1000
            try:
                return r.status, json.loads(raw), ms
            except json.JSONDecodeError:
                return r.status, raw.decode("utf-8", "replace")[:200], ms
    except urllib.error.HTTPError as e:
        ms = (time.perf_counter() - t0) * 1000
        detail = e.read(400).decode("utf-8", "replace")
        return e.code, detail, ms
    except Exception as e:  # noqa: BLE001 - DNS, TLS, timeout...
        return 0, str(e)[:160], (time.perf_counter() - t0) * 1000


def model_count(data: dict | str) -> int:
    if isinstance(data, dict):
        for key in ("data", "models", "result"):
            if isinstance(data.get(key), list):
                return len(data[key])
    return 0


def pick_model(data: dict | str) -> str | None:
    if not isinstance(data, dict):
        return None
    rows = data.get("data") or data.get("models") or []
    for row in rows:
        if isinstance(row, dict):
            mid = row.get("id") or row.get("name")
            if mid:
                return str(mid)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma separated provider ids")
    ap.add_argument("--chat", action="store_true", help="also send one tiny completion")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    load_env()
    spec = json.loads(DATA.read_text())
    wanted = {s.strip() for s in args.only.split(",")} if args.only else None

    results = []
    for p in spec["providers"]:
        if wanted and p["id"] not in wanted:
            continue
        base = p["base_url"].rstrip("/")
        key = os.environ.get(p["key_env"], "").strip()
        if "{" in base:  # Cloudflare-style: needs an account id we cannot guess
            acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
            if not acct:
                results.append({"id": p["id"], "status": "skip", "detail": "needs CLOUDFLARE_ACCOUNT_ID"})
                continue
            base = base.replace("{ACCOUNT_ID}", acct)
        if not key:
            results.append({"id": p["id"], "status": "skip", "detail": f"{p['key_env']} not set"})
            continue

        code, data, ms = call(base + "/models", key)
        row = {"id": p["id"], "http": code, "ms": round(ms), "models": model_count(data)}
        if code == 200:
            row.update(status="ok", detail=f"{row['models']} models")
            row["model"] = pick_model(data)
        elif code in (401, 403):
            row.update(status="bad-key", detail=str(data)[:80])
        elif code == 404:
            row.update(status="no-/models", detail="endpoint lacks /models; try --chat")
        elif code == 429:
            row.update(status="rate-limited", detail="key valid, quota hit")
        else:
            row.update(status="error", detail=str(data)[:80])

        if args.chat and code in (200, 404):
            model = row.get("model") or (p.get("free_models") or "").split(",")[0].strip()
            ccode, cdata, cms = call(base + "/chat/completions", key, {
                "model": model,
                "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
                "max_tokens": 8,
            })
            row["chat_http"] = ccode
            row["chat_ms"] = round(cms)
            if ccode == 200 and isinstance(cdata, dict):
                try:
                    row["chat_text"] = cdata["choices"][0]["message"]["content"][:40]
                except Exception:  # noqa: BLE001
                    row["chat_text"] = "(unparsed)"
            else:
                row["chat_text"] = str(cdata)[:80]

        results.append(row)
        icon = {"ok": "OK ", "bad-key": "KEY", "no-/models": "...", "rate-limited": "429", "error": "ERR"}[row["status"]]
        print(f"[{icon}] {p['id']:<20} {row.get('ms', 0):>5}ms  {row['detail']}")

    probed = [r for r in results if r["status"] != "skip"]
    if args.json:
        print(json.dumps(results, indent=2))
        return 0 if probed else 3

    ok = [r for r in results if r["status"] == "ok"]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "<!-- generated by scripts/check_providers.py -->",
        f"# Provider health check - {stamp}",
        "",
        f"{len(ok)} alive · {len(probed)} probed · {len(results) - len(probed)} skipped (no key).",
        "",
        "| Provider | Status | Models | Latency | Chat | Detail |",
        "|----------|--------|-------:|--------:|------|--------|",
    ]
    for r in results:
        chat = "-"
        if "chat_http" in r:
            chat = "ok" if r["chat_http"] == 200 else f"HTTP {r['chat_http']}"
        lines.append(
            f"| `{r['id']}` | {r['status']} | {r.get('models', '-')} | "
            f"{str(r.get('ms', '-')) + ' ms' if r.get('ms') else '-'} | {chat} | {r.get('detail', '')} |"
        )
    OUT_MD.write_text("\n".join(lines) + "\n")
    print(f"\n{len(ok)} alive / {len(probed)} probed -> wrote HEALTH.md")
    return 0 if probed else 3


if __name__ == "__main__":
    raise SystemExit(main())
