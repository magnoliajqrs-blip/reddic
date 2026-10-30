"""Self-hosted detection lab.

Two ways to use it:

1. Open http://<host>:8787 in any browser -> "Collect signals" runs the probe
   against *that* browser and renders a scored report. This gives you a baseline
   from a browser you trust as human.

2. Point an automation engine at http://<host>:8787/?auto=1 -> the page probes
   itself inside the engine and posts the result back. Same rules, same score,
   so the two numbers are directly comparable.

Stdlib only: no framework to install on the box you are testing.
"""

from __future__ import annotations

import json
import os
import pathlib
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

from .. import __version__
from ..audit import report as report_mod
from ..audit.checks import evaluate

HERE = pathlib.Path(__file__).parent
STATIC = HERE / "static"
PROBE_JS = HERE.parent / "audit" / "probe.js"

MAX_BODY = 8 * 1024 * 1024
REPORTS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def _store(signals: Dict[str, Any], out_dir: str) -> Dict[str, Any]:
    rep = evaluate(signals)
    rid = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    os.makedirs(out_dir, exist_ok=True)
    payload = {
        "version": __version__,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "report": rep.as_dict(),
        "signals": signals,
    }
    report_mod.write_json(payload, os.path.join(out_dir, f"{rid}.json"))
    report_mod.write_html(
        rep, os.path.join(out_dir, f"{rid}.html"), title="Detection audit -- local lab"
    )
    with _LOCK:
        REPORTS[rid] = payload
        if len(REPORTS) > 200:
            REPORTS.pop(next(iter(REPORTS)))
    return {
        "id": rid,
        "score": rep.score,
        "grade": rep.grade,
        "verdict": rep.verdict,
        "findings": len(rep.findings),
        "critical": [f.id for f in rep.critical],
        "html": f"/report/{rid}",
        "json": f"/report/{rid}.json",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = f"reddic-lab/{__version__}"
    out_dir = "reports"

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
        if "/report/" in (self.path or ""):
            return
        print(f"  [lab] {self.address_string()} {fmt % args}", flush=True)

    # -- helpers ----------------------------------------------------------- #
    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj: Any) -> None:
        self._send(code, json.dumps(obj, default=str).encode(), "application/json")

    def _file(self, path: pathlib.Path, ctype: str) -> None:
        try:
            self._send(200, path.read_bytes(), ctype)
        except FileNotFoundError:
            self._json(404, {"error": "not found"})

    # -- routes ------------------------------------------------------------ #
    def do_GET(self) -> None:  # noqa: N802
        u = urllib.parse.urlparse(self.path)
        path = u.path
        if path in ("/", "/index.html"):
            return self._file(STATIC / "index.html", "text/html; charset=utf-8")
        if path == "/probe.js":
            return self._file(PROBE_JS, "application/javascript; charset=utf-8")
        if path == "/health":
            return self._json(200, {"ok": True, "version": __version__, "reports": len(REPORTS)})
        if path.startswith("/report/"):
            rest = path[len("/report/") :]
            if rest.endswith(".json"):
                rid = rest[:-5]
                with _LOCK:
                    payload = REPORTS.get(rid)
                if payload:
                    return self._json(200, payload)
                return self._file(pathlib.Path(self.out_dir) / f"{rid}.json", "application/json")
            rid = rest
            target = pathlib.Path(self.out_dir) / f"{rid}.html"
            return self._file(target, "text/html; charset=utf-8")
        if path == "/examples":
            files = sorted(pathlib.Path(self.out_dir).glob("*.html"), reverse=True)[:50]
            rows = "".join(
                f'<li><a href="/report/{f.stem}" style="color:#4da3ff">{f.stem}</a></li>'
                for f in files
            )
            body = (
                "<body style='background:#0b0d12;color:#e6ebf5;font:14px system-ui;"
                f"padding:32px'><h3>audits</h3><ul>{rows or '<li>none yet</li>'}</ul>"
                '<p><a href="/" style="color:#8b97ad">back to lab</a></p></body>'
            )
            return self._send(200, body.encode(), "text/html; charset=utf-8")
        return self._json(404, {"error": "not found", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        u = urllib.parse.urlparse(self.path)
        if u.path != "/submit":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "bad body length"})
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return self._json(400, {"error": f"invalid json: {exc}"})
        signals = payload.get("signals", payload)
        if not isinstance(signals, dict):
            return self._json(400, {"error": "signals must be an object"})
        try:
            result = _store(signals, self.out_dir)
        except Exception as exc:  # never 500 the lab
            return self._json(500, {"error": f"scoring failed: {exc}"})
        return self._json(200, result)


def serve(host: str = "0.0.0.0", port: int = 8787, out_dir: str = "reports") -> None:
    Handler.out_dir = out_dir
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"\n  reddic lab listening on http://{host}:{port}\n", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  shutting down", flush=True)
    finally:
        httpd.server_close()
