"""Command line entrypoint.

    reddic audit  --engine nodriver --url https://example.com --html out/report.html
    reddic score  captures/signals.json
    reddic lab    --port 8787
    reddic engines
    reddic matrix --url https://example.com --engines nodriver,playwright
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import sys
from typing import Any, Dict, List, Optional

from . import __version__
from .audit import report as report_mod
from .audit.checks import evaluate, summarise
from .audit.runner import PROBE_JS, audit, audit_many, dump_signals, load_signals
from .engine.base import ENGINE_NAMES, LaunchConfig, get_engine


def _config_from_args(a: argparse.Namespace) -> LaunchConfig:
    window = (a.window or "1366x900").lower().split("x")
    try:
        size = (int(window[0]), int(window[1]))
    except (IndexError, ValueError):
        size = (1366, 900)
    return LaunchConfig(
        headless=a.headless,
        proxy=a.proxy,
        user_data_dir=a.profile,
        window=size,
        timezone=a.timezone,
        locale=a.locale,
        language=a.language,
        channel=a.channel,
        executable=a.executable,
        extra_args=a.arg or [],
    )


def _emit(rep: Any, a: argparse.Namespace, label: str = "audit") -> int:
    print(report_mod.terminal(rep, color=not a.no_color))
    if a.json:
        report_mod.write_json(rep.as_dict(), a.json)
        print(f"  json   -> {a.json}")
    if a.html:
        report_mod.write_html(rep, a.html, title=f"Detection audit -- {label}")
        print(f"  html   -> {a.html}")
    return 1 if rep.failed and not a.allow_critical else 0


def cmd_audit(a: argparse.Namespace) -> int:
    cfg = _config_from_args(a)
    shot = a.screenshot
    res = asyncio.run(
        audit(
            engine_kind=a.engine,
            config=cfg,
            url=a.url,
            measure_network=not a.no_network,
            ja4_endpoint=a.ja4_endpoint,
            screenshot_path=shot,
        )
    )
    if a.save_signals:
        dump_signals(res.signals, a.save_signals)
        print(f"  signals-> {a.save_signals}")
    return _emit(res.report, a, label=a.engine)


def cmd_score(a: argparse.Namespace) -> int:
    signals = load_signals(a.file)
    if isinstance(signals, dict) and "signals" in signals and isinstance(signals["signals"], dict):
        signals = signals["signals"]
    rep = evaluate(signals)
    return _emit(rep, a, label=os.path.basename(a.file))


def cmd_lab(a: argparse.Namespace) -> int:
    from .lab.server import serve

    serve(host=a.host, port=a.port, out_dir=a.out)
    return 0


def cmd_engines(a: argparse.Namespace) -> int:
    mods = {
        "nodriver": "nodriver",
        "patchright": "patchright",
        "playwright": "playwright",
        "camoufox": "camoufox",
    }
    print(f"\n  reddic {__version__}\n")
    for name in ENGINE_NAMES:
        mod = mods[name]
        try:
            ok = importlib.util.find_spec(mod) is not None
        except (ImportError, ValueError):
            ok = False
        mark = "\033[92mavailable\033[0m" if ok else "\033[90mnot installed\033[0m"
        print(f"  {name:<12} {mark}")
    print("\n  install:  pip install 'reddic[nodriver]'  (also: patchright, camoufox, all)\n")
    return 0


def cmd_matrix(a: argparse.Namespace) -> int:
    cfg = _config_from_args(a)
    engines: List[str] = [e.strip() for e in a.engines.split(",") if e.strip()]
    reports = asyncio.run(
        audit_many(engines, cfg, url=a.url, measure_network=not a.no_network)
    )
    print(f"\n  matrix  {a.url}\n")
    print(f"  {'engine':<14}{'score':>6}  {'verdict':<12}crit  high  med  low")
    for name, rep in reports.items():
        counts = {s: sum(1 for f in rep.findings if f.severity == s) for s in ("critical", "high", "medium", "low")}
        print(
            f"  {name:<14}{rep.score:>6}  {rep.verdict:<12}"
            f"{counts['critical']:<5} {counts['high']:<5} {counts['medium']:<4} {counts['low']:<4}"
        )
    print()
    if a.json:
        report_mod.write_json({k: v.as_dict() for k, v in reports.items()}, a.json)
        print(f"  json -> {a.json}\n")
    worst = [r for r in reports.values() if r.failed]
    return 1 if worst and not a.allow_critical else 0


def cmd_probe_dump(a: argparse.Namespace) -> int:
    """Emit the probe JS so it can be pasted into any engine or devtools."""
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(f"({PROBE_JS})()")
        print(f"  wrote {a.out}")
    else:
        print(PROBE_JS)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reddic", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=f"reddic {__version__}")
    sub = p.add_subparsers(dest="cmd")

    def common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--json", help="write machine report here")
        sp.add_argument("--html", help="write html report here")
        sp.add_argument("--no-color", action="store_true")
        sp.add_argument("--allow-critical", action="store_true", help="exit 0 even with critical findings")

    pa = sub.add_parser("audit", help="launch an engine and audit it")
    pa.add_argument("--engine", default="nodriver", choices=list(ENGINE_NAMES))
    pa.add_argument("--url", default="about:blank")
    pa.add_argument("--proxy", default=os.environ.get("REDDIC_PROXY"))
    pa.add_argument("--profile", default=os.environ.get("REDDIC_PROFILE"))
    pa.add_argument("--timezone", default=os.environ.get("TZ"))
    pa.add_argument("--locale", default="en-US")
    pa.add_argument("--language", default="en-US,en")
    pa.add_argument("--channel", default=os.environ.get("REDDIC_CHANNEL"))
    pa.add_argument("--executable", default=None)
    pa.add_argument("--window", default="1366x900")
    pa.add_argument("--arg", action="append", help="extra browser arg (repeatable)")
    pa.add_argument("--headless", action="store_true")
    pa.add_argument("--no-network", action="store_true", help="skip TLS/JA4 measurement")
    pa.add_argument("--ja4-endpoint", default="https://tls.peet.ws/api/all")
    pa.add_argument("--screenshot")
    pa.add_argument("--save-signals", help="dump raw signals json")
    common(pa)
    pa.set_defaults(fn=cmd_audit)

    ps = sub.add_parser("score", help="score a saved signals file (no browser)")
    ps.add_argument("file")
    common(ps)
    ps.set_defaults(fn=cmd_score)

    pl = sub.add_parser("lab", help="serve the local detection lab")
    pl.add_argument("--host", default="0.0.0.0")
    pl.add_argument("--port", type=int, default=8787)
    pl.add_argument("--out", default="reports")
    pl.set_defaults(fn=cmd_lab)

    pe = sub.add_parser("engines", help="show which engines are installed")
    pe.set_defaults(fn=cmd_engines)

    pm = sub.add_parser("matrix", help="compare engines on the same target")
    pm.add_argument("--engines", default="nodriver,playwright")
    pm.add_argument("--url", default="about:blank")
    pm.add_argument("--proxy", default=os.environ.get("REDDIC_PROXY"))
    pm.add_argument("--profile", default=None)
    pm.add_argument("--timezone", default=os.environ.get("TZ"))
    pm.add_argument("--locale", default="en-US")
    pm.add_argument("--language", default="en-US,en")
    pm.add_argument("--channel", default=os.environ.get("REDDIC_CHANNEL"))
    pm.add_argument("--executable", default=None)
    pm.add_argument("--window", default="1366x900")
    pm.add_argument("--arg", action="append")
    pm.add_argument("--headless", action="store_true")
    pm.add_argument("--no-network", action="store_true")
    common(pm)
    pm.set_defaults(fn=cmd_matrix)

    pd = sub.add_parser("probe", help="print the probe JS")
    pd.add_argument("--out")
    pd.set_defaults(fn=cmd_probe_dump)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "fn", None):
        parser.print_help()
        return 2
    try:
        return int(args.fn(args) or 0)
    except KeyboardInterrupt:
        return 130
    except RuntimeError as exc:
        print(f"\n  error: {exc}\n", file=sys.stderr)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
