# reddic

Engine-agnostic browser automation core with a built-in **detection audit lab**.

You cannot fix what you cannot measure. `reddic` scores a browser against ~50 real
detection rules across five layers, tells you exactly which layer leaks, and gives you
the fix — before you point it at anything that matters.

```
  reddic audit -- 20/100  grade F  DETECTABLE
  chromium 131 | linux | tz=UTC | locale=en-US | screen=[1280, 720]
  gpu=ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)

  automation   ....................   0
  consistency  ########............  44
  fingerprint  ....................   0
  headless     ....................   0
  network      ##################..  94

  [CRITICAL] automation   CDP Runtime domain is active on the page
             -> Disable Runtime.enable / Target.setAutoAttach (patchright with
                channel=chrome, or nodriver). This is the #1 remaining CDP leak.
```

---

## Why this exists

Most "anti-detect" tooling fails in the same four ways, in this order of how often
people get it wrong:

| # | Failure | What it looks like | Layer that catches it |
|---|---|---|---|
| 1 | **IP reputation** | Datacenter ASN, or a residential IP in the wrong country | Cloudflare, DataDome |
| 2 | **TLS / HTTP2 mismatch** | Perfect browser, but a Go/Node proxy terminated TLS | JA4, Akamai |
| 3 | **Realm inconsistency** | Patched top frame, unpatched iframe/worker | every serious vendor |
| 4 | **Behaviour** | Zero mouse movement, instant form fills | DataDome, HUMAN |

`reddic` measures 2, 3 and 4 (signal side) directly, and surfaces 1 through the
timezone-vs-IP and JA4 checks. Nothing here is a bypass — you still need real
residential egress, and no engine fixes a bad IP.

---

## Install

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e .

# pick at least one engine
pip install -e '.[nodriver]'      # recommended Chromium path
pip install -e '.[patchright]'    # Playwright API + CDP-leak patches, real Chrome TLS
pip install -e '.[camoufox]'      # patched Firefox (best JS-artifact score)
pip install -e '.[all]'           # A/B everything
```

Tested on Python 3.9+. Zero mandatory runtime dependencies — the audit, the rule
engine, the report renderer and the lab server are all stdlib.

---

## Use

### 1. Score a browser (no automation needed)

```bash
reddic lab --port 8787
```

Open `http://localhost:8787`. Click **Collect signals**. You get a scored report for
*the browser you are holding*. Do this first — that is your human baseline.

Now point your automation engine at `http://<host>:8787/?auto=1`. The page probes
itself inside the engine and posts the result. Same rules, same score, directly
comparable to the baseline.

### 2. Audit an engine from the CLI

```bash
reddic audit --engine nodriver \
  --url https://example.com \
  --timezone Asia/Dhaka \
  --locale bn-BD \
  --html reports/audit.html
```

Exit codes: `0` clean/usable, `1` a critical signal is present. Use it as a CI gate
so a Chromium release cannot silently break your stack.

### 3. Compare engines on the same target

```bash
reddic matrix --engines nodriver,patchright,playwright,camoufox \
  --url https://example.com
```

Runs sequentially on purpose: parallel launches contend for CPU and corrupt the
`hardwareConcurrency`, audio and timing probes.

### 4. Re-score a saved capture

```bash
reddic audit --url https://example.com --save-signals captures/run.json --no-color
reddic score captures/run.json --html reports/offline.html
```

Rules are pure functions over JSON, so a regression suite runs with no browser at all.

---

## What gets checked

**automation (35%)** — `navigator.webdriver`, window-level framework artifacts,
CDP `Runtime.enable` canary, framework names in `Error.stack`, re-patched native
function bodies, main-frame vs iframe realm diff, worker realm diff.

**consistency (25%)** — UA vs UA-CH brands and version, UA-CH vs `navigator.platform`,
timezone vs exit IP country, UTC timezone, language list coherence, mobile/touch-point
agreement, `innerWidth == outerWidth` (headless tell).

**fingerprint (20%)** — canvas availability/stability/determinism, WebGL presence,
**software renderer detection** (SwiftShader/llvmpipe is a hard block), WebGL extension
count, audio fingerprint, font count, **Linux-only fonts on a Windows persona**, TTS
voice list, stale browser version.

**headless (10%)** — `HeadlessChrome` in UA, empty `navigator.plugins`, missing
`window.chrome`, default viewport presets, missing taskbar geometry, single-core
`hardwareConcurrency`, zero media devices, missing WebRTC, permissions/Notification
contradiction, impossible battery state.

**network (10%)** — JA4 presence and shape, HTTP/2 SETTINGS vs claimed browser family,
and the one that catches most people: **the UA the server sees vs the UA the page
reports**.

Full rule list: `reddic/audit/checks.py`. Every finding carries an `id`, so you can
baseline a known-acceptable set in CI.

---

## Architecture

```
reddic/
  audit/
    probe.js      collect-only signal gatherer (main frame, iframe, worker)
    network.py    TLS/JA4 + HTTP2 measurement through the browser's own stack
    checks.py     ~50 rules -> category scores -> verdict   (no browser needed)
    runner.py     launch -> probe -> measure -> score
    report.py     JSON / HTML / terminal renderers
  engine/
    base.py              LaunchConfig + Engine contract + registry
    nodriver_engine.py   CDP-minimal (no Playwright shim)
    playwright_engine.py patchright | playwright | camoufox in one adapter
  lab/
    server.py     stdlib HTTP server, self-serve lab
    static/       lab UI
  cli.py
```

Swapping engines is one string (`--engine`). That is the point: when a target changes
its detection model, you re-run the matrix and switch, you do not rewrite a codebase.

### Engine choice, 2026

| Engine | Strength | Cost |
|---|---|---|
| **nodriver** | speaks CDP directly, no `Runtime.enable` startup pattern, no `navigator.webdriver` | no Playwright API, raw API surface |
| **patchright** | Playwright API + CDP-leak patches, `channel=chrome` gives genuine Chrome TLS | needs a system Chrome install |
| **camoufox** | C++-level Firefox patching, best JS-artifact score, `geoip=True` derives tz/locale from the proxy | Firefox-only, large build |
| **playwright** | baseline for A/B only | detectable as-is |

Default: **nodriver**. Compare before you commit — the winner is target-dependent.

---

## Configuration that actually matters

```python
from reddic.engine.base import LaunchConfig
from reddic.audit.runner import audit

cfg = LaunchConfig(
    headless=False,                          # headful beats headless, always
    proxy="socks5://user:pass@1.2.3.4:1080", # raw SOCKS5: the browser does the TLS
    timezone="Asia/Dhaka",                   # must match the proxy's geo
    locale="bn-BD",
    window=(1366, 900),                      # outer > inner, always
    channel="chrome",
)
```

Four non-negotiables:

1. **Never terminate TLS in your own proxy.** SOCKS5 tunnel only. A Go/Node MITM
   gives you a Chromium UA with a non-Chromium JA4 — instant flag.
2. **Timezone, locale and geolocation come from the IP**, never from a hardcoded
   identity.
3. **`outerHeight > innerHeight`.** Exact equality is the headless signature.
4. **Install fonts for the persona's OS.** A Windows UA with `DejaVu Sans` visible is a
   direct OS leak that needs no clever detection.

---

## Roadmap

| # | Module | Status | What it unlocks |
|---|---|---|---|
| 1 | Detection audit lab | **done** | measure before you build |
| 2 | Profile store + proxy binding | next | seed-derived deterministic fingerprint, sticky IP per profile |
| 3 | Behaviour layer | planned | bezier mouse paths, typing cadence, scroll and dwell modelling |
| 4 | Queue + dashboard | planned | worker pool, per-profile rate limits, retry/backoff, live view |
| 5 | Fingerprint regression CI | planned | nightly matrix run against a pinned target set |

---

## Tests

```bash
pip install -e '.[dev]'
pytest -q          # 38 tests, no browser required
```

The suite includes two anchor fixtures: a vanilla headless Playwright capture that
must score **DETECTABLE**, and a hardened Chromium capture that must score **CLEAN**.
Any rule change that flips either one is a bug.

---

## Scope

Built for: your own properties, QA, monitoring, authorised research, and managing
accounts you legitimately own.

Not built for: bulk account creation, credential abuse, vote/reputation manipulation,
or evading a ban. Those are platform-ToS and often criminal issues, and no amount of
fingerprint work makes them a good business.

## License

MIT
