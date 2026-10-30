"""Orchestrates one audit run: launch -> probe -> network -> score."""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
from dataclasses import dataclass
from typing import Any, Dict, Optional

from ..engine.base import Engine, LaunchConfig, get_engine
from . import network as net
from .checks import Report, evaluate

HERE = pathlib.Path(__file__).parent
PROBE_JS = (HERE / "probe.js").read_text(encoding="utf-8")


@dataclass
class AuditResult:
    report: Report
    signals: Dict[str, Any]
    engine: Dict[str, Any]


async def audit(
    engine_kind: str = "nodriver",
    config: Optional[LaunchConfig] = None,
    url: str = "about:blank",
    measure_network: bool = True,
    ja4_endpoint: str = net.DEFAULT_JA4_ENDPOINT,
    screenshot_path: Optional[str] = None,
    engine: Optional[Engine] = None,
) -> AuditResult:
    """Run one detection audit and return scored report + raw signals."""
    cfg = config or LaunchConfig()
    eng = engine or get_engine(engine_kind, cfg)
    signals: Dict[str, Any] = {}
    try:
        await eng.start()
        if url and url != "about:blank":
            await eng.goto(url)
        signals = await eng.run_probe(PROBE_JS)
        if not isinstance(signals, dict):
            signals = {"errors": [f"probe returned {type(signals).__name__}, expected object"]}

        if measure_network:
            sig = await net.collect(eng, ja4_endpoint)
            signals["network"] = sig.as_dict()
            signals["network"]["raw"] = sig.raw
            # cache country so the timezone check has something to compare to
            country = (sig.raw or {}).get("geoip", {}).get("country") if isinstance(sig.raw, dict) else None
            if not country:
                country = _country_from_ip((sig.raw or {}).get("ip")) if isinstance(sig.raw, dict) else None
            if country:
                signals["network"]["country"] = country

        if screenshot_path:
            try:
                await eng.screenshot(screenshot_path)
            except Exception:
                pass
    finally:
        try:
            await eng.close()
        except Exception:
            pass

    report = evaluate(signals)
    report.meta["engine"] = eng.describe()
    return AuditResult(report=report, signals=signals, engine=eng.describe())


def _country_from_ip(ip: Any) -> Optional[str]:
    """Optional GeoIP if a database is available; never a network call."""
    if not ip:
        return None
    try:
        import geoip2.database  # type: ignore

        db = os.environ.get("REDDIC_GEOIP_DB")
        if not db:
            return None
        with geoip2.database.Reader(db) as reader:
            return reader.city(str(ip)).country.iso_code
    except Exception:
        return None


async def audit_many(engines: list, config: LaunchConfig, url: str, **kw: Any) -> Dict[str, Report]:
    """Run the same audit across several engines, sequentially.

    Sequential on purpose: parallel browser launches contend for CPU and the
    fingerprint results become noisy (hardwareConcurrency, timing, audio).
    """
    out: Dict[str, Report] = {}
    for e in engines:
        res = await audit(engine_kind=e, config=config, url=url, **kw)
        out[e] = res.report
    return out


def load_signals(path: str) -> Dict[str, Any]:
    """Score an already-captured signals file (used by tests and by the lab)."""
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def dump_signals(signals: Dict[str, Any], path: str) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(signals, fh, indent=2, ensure_ascii=False, default=str)
    return path


def run_sync(**kwargs: Any) -> AuditResult:
    """Blocking helper for CLIs and scripts."""
    return asyncio.run(audit(**kwargs))
