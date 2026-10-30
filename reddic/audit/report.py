"""Report rendering: JSON (machine), HTML (human), terminal (CI logs).

No template engine on purpose -- the report must render on a box with zero
optional deps, because that is exactly where audits get run.
"""

from __future__ import annotations

import html
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict

from .checks import CATEGORIES, Report

SEV_ORDER = ("critical", "high", "medium", "low")

HTML_DOC = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>reddic audit -- {score}/100</title>
<style>
:root {{
  --bg:#0b0d12; --panel:#131721; --line:#222a38; --text:#e6ebf5; --muted:#8b97ad;
  --crit:#ff4d5e; --high:#ff9f43; --med:#ffd93d; --low:#4da3ff; --ok:#2ed573;
}}
*{{box-sizing:border-box}}
body{{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#182034 0%,var(--bg) 55%);
  color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  padding:32px 20px 64px}}
.wrap{{max-width:1020px;margin:0 auto}}
h1{{font-size:20px;font-weight:600;letter-spacing:.2px;margin:0 0 4px}}
.sub{{color:var(--muted);font-size:13px;margin-bottom:24px}}
.card{{background:linear-gradient(180deg,#161b27,#12161f);border:1px solid var(--line);
  border-radius:14px;padding:22px;margin-bottom:18px}}
.top{{display:grid;grid-template-columns:200px 1fr;gap:26px;align-items:center}}
.gauge{{position:relative;width:180px;height:180px}}
.gauge svg{{transform:rotate(-90deg)}}
.gauge .val{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center}}
.gauge .num{{font-size:42px;font-weight:700;line-height:1}}
.gauge .grade{{font-size:13px;color:var(--muted);letter-spacing:2px;margin-top:4px}}
.verdict{{display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;
  font-weight:600;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:14px}}
.kv{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}}
.kv div{{background:#0e131c;border:1px solid var(--line);border-radius:9px;padding:10px 12px}}
.kv span{{display:block;color:var(--muted);font-size:11px;letter-spacing:.8px;text-transform:uppercase}}
.kv b{{font-weight:600;font-size:13px;word-break:break-all}}
.bars{{display:grid;gap:12px;margin-top:6px}}
.bar{{display:grid;grid-template-columns:110px 1fr 42px;gap:12px;align-items:center;font-size:13px}}
.track{{height:8px;background:#0e131c;border-radius:99px;overflow:hidden;border:1px solid var(--line)}}
.fill{{height:100%;border-radius:99px}}
h2{{font-size:14px;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted);
  margin:34px 0 14px;font-weight:600}}
.f{{border:1px solid var(--line);border-left:3px solid var(--low);background:#10141d;
  border-radius:10px;padding:14px 16px;margin-bottom:10px}}
.f.critical{{border-left-color:var(--crit)}} .f.high{{border-left-color:var(--high)}}
.f.medium{{border-left-color:var(--med)}} .f.low{{border-left-color:var(--low)}}
.f .head{{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px}}
.chip{{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
  padding:3px 8px;border-radius:5px;background:#1c2230;color:var(--muted)}}
.chip.critical{{background:rgba(255,77,94,.15);color:var(--crit)}}
.chip.high{{background:rgba(255,159,67,.15);color:var(--high)}}
.chip.medium{{background:rgba(255,217,61,.13);color:var(--med)}}
.chip.low{{background:rgba(77,163,255,.13);color:var(--low)}}
.title{{font-weight:600;font-size:14px}}
.detail{{color:#c3ccdd;font-size:13px;white-space:pre-wrap}}
.fix{{margin-top:9px;padding:9px 12px;background:#0c1a12;border:1px solid #1d3b29;
  border-radius:8px;font-size:12.5px;color:#a8e6c1}}
.fix b{{color:var(--ok)}}
details{{margin-top:9px}} summary{{cursor:pointer;color:var(--muted);font-size:12px}}
pre{{background:#0a0e15;border:1px solid var(--line);border-radius:8px;padding:12px;
  overflow:auto;font-size:11.5px;color:#9fb0c9;max-height:340px}}
.muted{{color:var(--muted);font-size:12px}}
footer{{margin-top:36px;color:#5d6779;font-size:12px;text-align:center}}
</style></head><body><div class="wrap">
<h1>{title}</h1>
<div class="sub">{ua}</div>
<div class="card top">
  <div class="gauge">
    <svg width="180" height="180">
      <circle cx="90" cy="90" r="78" fill="none" stroke="#1b2231" stroke-width="12"></circle>
      <circle cx="90" cy="90" r="78" fill="none" stroke="{ring}" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="{dash}" stroke-dashoffset="0"></circle>
    </svg>
    <div class="val"><div class="num">{score}</div><div class="grade">{grade} / 100</div></div>
  </div>
  <div>
    <div class="verdict" style="background:{vbg};color:{vfg}">{verdict}</div>
    <div class="kv">{kv}</div>
  </div>
</div>
<div class="card"><div class="bars">{bars}</div></div>
<h2>Findings ({n})</h2>
{findings}
<footer>reddic {version} -- generated {stamp}</footer>
</div></body></html>"""


def _ring_colour(score: int) -> str:
    if score >= 90:
        return "#2ed573"
    if score >= 75:
        return "#ffd93d"
    if score >= 55:
        return "#ff9f43"
    return "#ff4d5e"


def _bar_colour(score: int) -> str:
    return _ring_colour(score)


def render_html(rep: Report, title: str = "Detection audit") -> str:
    circumference = 2 * 3.14159265 * 78
    dash = f"{circumference * rep.score / 100:.1f} {circumference:.1f}"
    vcol = {
        "CLEAN": ("rgba(46,213,115,.15)", "#2ed573"),
        "USABLE": ("rgba(77,163,255,.15)", "#4da3ff"),
        "FRAGILE": ("rgba(255,159,67,.15)", "#ff9f43"),
        "DETECTABLE": ("rgba(255,77,94,.15)", "#ff4d5e"),
    }.get(rep.verdict, ("#1c2230", "#8b97ad"))

    b = rep.browser or {}
    kv_pairs = [
        ("browser", f"{b.get('family','?')} {b.get('version') or ''}".strip()),
        ("platform", b.get("platform") or "?"),
        ("timezone", b.get("timezone") or "?"),
        ("locale", b.get("locale") or "?"),
        ("screen", "x".join(str(x) for x in (b.get("screen") or []) if x) or "?"),
        ("gpu", (b.get("webgl_renderer") or "?")[:44]),
        ("JA4", (b.get("ja4") or "not measured")[:38]),
        ("engine", (rep.meta.get("engine") or {}).get("engine", "captured")),
    ]
    kv = "".join(
        f"<div><span>{html.escape(k)}</span><b>{html.escape(str(v))}</b></div>" for k, v in kv_pairs
    )
    bars = "".join(
        f'<div class="bar"><div class="muted">{c}</div>'
        f'<div class="track"><div class="fill" style="width:{rep.category_scores.get(c,0)}%;'
        f'background:{_bar_colour(rep.category_scores.get(c,0))}"></div></div>'
        f'<div><b>{rep.category_scores.get(c,0)}</b></div></div>'
        for c in CATEGORIES
    )

    if not rep.findings:
        findings = '<div class="card muted">No findings. Re-run against a hostile target before trusting this.</div>'
    else:
        chunks = []
        for f in rep.findings:
            ev = ""
            if f.evidence is not None:
                try:
                    ev = json.dumps(f.evidence, indent=2, ensure_ascii=False, default=str)
                except Exception:
                    ev = str(f.evidence)
                if len(ev) > 4000:
                    ev = ev[:4000] + "\n... truncated"
                ev = (
                    "<details><summary>evidence</summary><pre>"
                    + html.escape(ev)
                    + "</pre></details>"
                )
            fix = f'<div class="fix"><b>fix</b> &nbsp;{html.escape(f.fix)}</div>' if f.fix else ""
            chunks.append(
                f'<div class="f {f.severity}"><div class="head">'
                f'<span class="chip {f.severity}">{f.severity}</span>'
                f'<span class="chip">{f.category}</span>'
                f'<span class="title">{html.escape(f.title)}</span></div>'
                f'<div class="detail">{html.escape(f.detail)}</div>{fix}{ev}</div>'
            )
        findings = "".join(chunks)

    from .. import __version__

    return HTML_DOC.format(
        title=html.escape(title),
        ua=html.escape((b.get("user_agent") or "")[:190]),
        score=rep.score,
        grade=rep.grade,
        ring=_ring_colour(rep.score),
        dash=dash,
        verdict=rep.verdict,
        vbg=vcol[0],
        vfg=vcol[1],
        kv=kv,
        bars=bars,
        n=len(rep.findings),
        findings=findings,
        version=__version__,
        stamp=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    )


def write_html(rep: Report, path: str, title: str = "Detection audit") -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(render_html(rep, title))
    return path


def write_json(payload: Dict[str, Any], path: str) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False, default=str)
    return path


def terminal(rep: Report, color: bool = True) -> str:
    C = {
        "critical": "\033[91m", "high": "\033[38;5;208m", "medium": "\033[93m",
        "low": "\033[94m", "dim": "\033[90m", "b": "\033[1m", "r": "\033[0m",
        "ok": "\033[92m",
    }
    use = (lambda k, s: f"{C[k]}{s}{C['r']}") if color else (lambda k, s: s)
    vcol = {"CLEAN": "ok", "USABLE": "low", "FRAGILE": "high", "DETECTABLE": "critical"}
    b = rep.browser or {}
    lines = [
        "",
        use("b", f"  reddic audit -- {rep.score}/100  grade {rep.grade}  ")
        + use(vcol.get(rep.verdict, "dim"), rep.verdict),
        use("dim", f"  {b.get('family')} {b.get('version') or ''} | {b.get('platform')} | "
                   f"tz={b.get('timezone')} | locale={b.get('locale')} | "
                   f"screen={b.get('screen')}"),
        use("dim", f"  gpu={str(b.get('webgl_renderer'))[:70]}"),
        use("dim", f"  ja4={b.get('ja4')}"),
        "",
    ]
    for c in CATEGORIES:
        sc = rep.category_scores.get(c, 0)
        filled = int(sc / 5)
        key = "ok" if sc >= 90 else ("medium" if sc >= 70 else "critical")
        lines.append(
            f"  {c:<12} {use(key, '#' * filled)}{use('dim', '.' * (20 - filled))} {sc:>3}"
        )
    lines.append("")
    if not rep.findings:
        lines.append(use("ok", "  no findings"))
    for f in rep.findings:
        lines.append(
            f"  {use(f.severity, f'[{f.severity.upper():8}]')} "
            f"{use('dim', f'{f.category:<12}')} {f.title}"
        )
        if f.fix:
            lines.append(use("dim", f"             -> {f.fix[:150]}"))
    if rep.probe_errors:
        lines.append("")
        lines.append(use("dim", f"  probe errors: {len(rep.probe_errors)}"))
        for e in rep.probe_errors[:5]:
            lines.append(use("dim", f"    - {e[:140]}"))
    lines.append("")
    return "\n".join(lines)
