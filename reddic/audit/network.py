"""Network-layer signals that JavaScript cannot see.

The single most common reason a "perfect" stealth browser still gets blocked is a
TLS/JA4 or HTTP/2 fingerprint that does not belong to the browser presenting it.
This module measures that layer directly.

Method
------
Ask an echo service to describe our TLS/JA4 + HTTP/2 fingerprint, then compare the
result with the browser's own claimed identity. Because the request is made *from
inside the browser page* (same cookies not needed; CORS is open on the echo
services), the observation describes the real network stack of the browser under
test -- not of Python.

If you want a fully offline measurement, run the bundled capture server
(``reddic lab --capture``) and point the browser at it; it records :peet-style
details locally. That path is opt-in because it needs local CA work.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

DEFAULT_JA4_ENDPOINT = "https://tls.peet.ws/api/all"

# The probe runs inside the page so the fingerprint belongs to the browser.
JS_FETCH_JSON = """
async (url) => {
  try {
    const r = await fetch(url, { cache: "no-store", credentials: "omit" });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
"""

# Lightweight fallbacks if the main endpoint is unreachable.
FALLBACK_ENDPOINTS = [
    "https://tls.peet.ws/api/all",
    "https://tls.browserleaks.com/json",
]


@dataclass
class NetworkSignals:
    endpoint: Optional[str] = None
    ok: bool = False
    error: Optional[str] = None
    ja3: Optional[str] = None
    ja3_hash: Optional[str] = None
    ja4: Optional[str] = None
    http_version: Optional[str] = None
    akamai_fingerprint: Optional[str] = None
    akamai_fingerprint_hash: Optional[str] = None
    user_agent_seen: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "ok": self.ok,
            "error": self.error,
            "ja3": self.ja3,
            "ja3_hash": self.ja3_hash,
            "ja4": self.ja4,
            "http_version": self.http_version,
            "akamai_fingerprint": self.akamai_fingerprint,
            "akamai_fingerprint_hash": self.akamai_fingerprint_hash,
            "user_agent_seen": self.user_agent_seen,
        }


# Settings-frame fragments observed for real Chrome builds. Used as a soft check:
# an unknown value is not an automatic fail, it is a "verify this" flag.
# Real Chrome sends exactly four SETTINGS entries and omits values that equal the
# protocol default (MAX_CONCURRENT_STREAMS, MAX_FRAME_SIZE are absent). Firefox
# instead advertises a 128 KiB INITIAL_WINDOW_SIZE and an explicit MAX_FRAME_SIZE.
CHROME_H2_HINTS = (
    "1:65536",     # HEADER_TABLE_SIZE
    "2:0",         # ENABLE_PUSH = 0 (Chrome)
    "4:6291456",   # INITIAL_WINDOW_SIZE
)
CHROME_H2_FORBIDDEN = (
    "4:131072",    # that is Firefox's window size
)
FIREFOX_H2_HINTS = ("2:0", "4:131072", "5:16384")


def _get(d: Dict[str, Any], *paths: str) -> Optional[Any]:
    """Fetch the first available key from one of several JSON shapes."""
    for p in paths:
        cur: Any = d
        ok = True
        for part in p.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, "", []):
            return cur
    return None


def parse_ja4_payload(data: Dict[str, Any]) -> NetworkSignals:
    """Normalise tls.peet.ws / browserleaks response into NetworkSignals."""
    sig = NetworkSignals(ok=True, raw=data if len(json.dumps(data)) < 200_000 else {})

    sig.ja3 = _get(data, "tls.ja3", "ja3")
    sig.ja3_hash = _get(data, "tls.ja3_hash", "ja3_hash")
    sig.ja4 = _get(data, "tls.ja4", "ja4")
    sig.akamai_fingerprint = _get(data, "http2.akamai_fingerprint", "akamai_fingerprint")
    sig.akamai_fingerprint_hash = _get(
        data, "http2.akamai_fingerprint_hash", "akamai_fingerprint_hash"
    )
    sig.user_agent_seen = _get(data, "user_agent", "http2.sent_frames.0.user_agent")

    # browserleaks shape
    if not sig.ja3:
        sig.ja3 = _get(data, "tls.ja3_hash", "ja3_hash")

    # Derive HTTP version from the sent frames if the service reports it.
    sent = _get(data, "http2.sent_frames")
    if isinstance(sent, list) and sent:
        first = sent[0] if isinstance(sent[0], dict) else {}
        settings = str(first.get("settings", "")) if first.get("settings") else None
        if settings:
            sig.raw.setdefault("sent_settings", settings)
    sig.http_version = _get(data, "http_version", "http2.http_version") or (
        "h2" if sig.akamai_fingerprint else None
    )
    return sig


async def collect(engine: Any, endpoint: str = DEFAULT_JA4_ENDPOINT) -> NetworkSignals:
    """Collect network-layer signals through the browser under test.

    ``engine`` is any object exposing ``await evaluate(js, arg=None)`` -- see
    ``reddic.engine.base.Engine``. The JS is evaluated in the *page* context so the
    TLS handshake is the browser's own.
    """
    last: Optional[NetworkSignals] = None
    for url in [endpoint] + [u for u in FALLBACK_ENDPOINTS if u != endpoint]:
        try:
            res = await engine.evaluate(JS_FETCH_JSON, url)
        except Exception as exc:  # pragma: no cover - engine specific
            last = NetworkSignals(endpoint=url, ok=False, error=str(exc)[:300])
            continue
        if not res or not res.get("ok"):
            last = NetworkSignals(
                endpoint=url,
                ok=False,
                error=str((res or {}).get("error") or (res or {}).get("status")),
            )
            continue
        sig = parse_ja4_payload(res.get("data") or {})
        sig.endpoint = url
        return sig
    return last or NetworkSignals(ok=False, error="no endpoint reachable")


def http2_findings(sig: NetworkSignals, family: str = "chromium") -> List[str]:
    """Soft checks on HTTP/2 settings consistency.

    Returns human-readable findings; empty list means "looks consistent".
    """
    findings: List[str] = []
    settings = (sig.raw or {}).get("sent_settings")
    if not settings:
        return findings
    if family == "chromium":
        missing = [h for h in CHROME_H2_HINTS if h not in settings]
        if missing:
            findings.append(
                "HTTP/2 SETTINGS missing Chrome-typical values: " + ", ".join(missing)
            )
        if re.search(r"(?:^|;)2:(?!0)\d+", settings):
            findings.append("HTTP/2 ENABLE_PUSH is not 0 (Chrome always sends 0)")
        wrong = [h for h in CHROME_H2_FORBIDDEN if h in settings]
        if wrong:
            findings.append(
                "HTTP/2 SETTINGS contains Firefox-only values: " + ", ".join(wrong)
            )
    elif family == "firefox":
        if "4:131072" not in settings:
            findings.append("HTTP/2 INITIAL_WINDOW_SIZE does not match Firefox (expected 131072)")
    return findings


def ip_matches_geo(
    client_ip: Optional[str], country: Optional[str], tz: Optional[str]
) -> Optional[str]:
    """Cross-check IP country vs. browser timezone. Returns finding or None."""
    if not client_ip or not country or not tz:
        return None
    # Minimal offline map -- correct for the common residential exit countries.
    tz_country = {
        "Asia/Dhaka": "BD",
        "Asia/Kolkata": "IN",
        "Asia/Karachi": "PK",
        "Asia/Singapore": "SG",
        "America/New_York": "US",
        "America/Chicago": "US",
        "America/Denver": "US",
        "America/Los_Angeles": "US",
        "Europe/London": "GB",
        "Europe/Berlin": "DE",
        "Europe/Paris": "FR",
        "Europe/Amsterdam": "NL",
    }
    expect = tz_country.get(tz)
    if expect and expect != country.upper():
        return (
            f"IP geolocates to {country.upper()} but browser timezone is {tz} "
            f"(expected {expect}) -- classic exit-node mismatch"
        )
    return None
