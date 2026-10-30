# v2.5.0 — full-project audit (A → Z)

Scope: everything that runs on the user's machine — CLI, checker, solver, TLS layer, browser
layer, rotation layer, dashboard, Windows launchers, tests. Each finding lists the **symptom**,
the **root cause** and the **fix** that is now covered by a test.

Legend: 🔴 breaks a run · 🟠 wastes accounts/time · 🟡 hygiene

| # | Area | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | 🔴 dashboard | `dashboard.js` was **truncated**: state helpers only, no HTTP server, no SSE, no UI. `node dashboard.js` exited instantly, so `npm run dashboard` and `DASH_PORT` did nothing. | Complete dependency-free server: `/`, `/api/state`, `/api/events` (SSE + heartbeat), `/api/start`, `/api/stop`; live counters (hits/banned/reset/2FA/invalid/errors), CPM, ETA, log ring, child-process supervision, loopback bind by default, `DASH_HOST` override, safe basename-only accounts path. | phase 9 + manual curl/SSE run |
| 2 | 🔴 lifecycle | **No Ctrl+C handling**. Closing the console killed Node but left headed Chromium/Puppeteer processes running (300MB+ each, holding profile locks). | `installGracefulShutdown()` (SIGINT/SIGTERM/SIGHUP, single-shot, 15s deadline, `beforeExit` fallback) wired into checker, solver CLI and dashboard. | phase 9 |
| 3 | 🔴 lifecycle | Missing `node-tls-client` asset → the dependency calls `process.exit(1)` **inside** the library; the window just closed with `Failed to fetch the latest version`. | Preflight warning + `printTlsAssetHelp()` banner (Windows/Linux/macOS fixes, `.bin_cache` hint) also emitted from a `process.once('exit')` guard; `initTLS()` wrapped in try/catch. | manual (sandbox has no asset) |
| 4 | 🟠 config | `Number(process.env.X)` produced **NaN** for typos (`PAGE_DWELL_MS=8s`), silently disabling the dwell/gate timeouts. | `envInt(name, default, {min,max})` / `envBool()`; applied to pace, dwell, gate timeout, retries, concurrency. | phase 9 |
| 5 | 🟠 HTTP | **Corrupt gzip/brotli body returned as "HTML"** — parsers saw garbage, accounts failed with nonsense verdicts. | `decodeResponseBody()` (gzip/br/deflate/raw-deflate/**zstd**) throws `DECODE_FAILED`; used by the fallback client and by the TLS client when a body arrives still compressed. | phase 9 |
| 6 | 🟠 HTTP | Advertising `zstd` while running on Node < 22.15 (no decoder) → guaranteed garbage for zstd responses. | `Accept-Encoding` advertises zstd **only** when `zlib.zstdDecompressSync` exists; `ZSTD_ACCEPT=0` forces it off. | phase 9 |
| 7 | 🟠 HTTP | **One flaky proxy hop = one failed account** (no transport retry). | Bounded retry (`TRANSPORT_RETRY_ATTEMPTS`, default 2) with jittered backoff; **POST is retried only when it provably never left the machine** (connect/DNS/proxy-CONNECT/status 0). | phase 9 |
| 8 | 🔴 HTTP | Fallback client sent **every cookie to every host** (flat jar): reddit sessions to `google.com`, and a same-named cookie from another site overwrote Reddit's. | Domain-scoped jar with `Domain=` handling, expiry deletion, parent/subdomain matching; `_cookieHeader(host)` per request. | phase 9 |
| 9 | 🟠 HTTP | Redirect chains kept `Content-Type`/`Content-Length`/`Origin`/`Referer` on the new request (cross-host hops included). | Redirect sanitisation, per-hop; `Connection`-family headers stripped in HTTP/2 mode (already present, now covered). | phase 9 |
| 10 | 🟠 browser | Puppeteer fallback spent **15s per account** on `waitForNavigation({waitUntil:'networkidle2'})` — it waits for the *next* navigation. | `waitForNetworkIdle({idleTime:600, timeout:10000})`. | phase 9 (source contract) |
| 11 | 🟠 browser | Puppeteer fallback had **no human dwell** (only the hybrid path did) → execute() fired ~1s after load. | Same `PAGE_DWELL_MS` dwell + post-gate reload in the Puppeteer path. | phase 8/9 |
| 12 | 🟠 browser | `createNetworkTracker().dispose()` used `page.off()` — **Puppeteer has no `off()`**, so three listeners stayed attached to every page. | `off()` → `removeListener()` fallback, guarded. | phase 7 |
| 13 | 🔴 bot gate | Gate detected only via one `<title>` regex, *after* the readiness wait; a gate page therefore produced "reCAPTCHA failed". | `BotGateRecovery` classifies humanity/whoa-there/429/generic **before** readiness, clicks the checkbox, waits for clearance; failures are `WAF_BLOCKED` (never "invalid"/"banned"). | phase 8 |
| 14 | 🔴 bot gate | Reddit answering the **login POST** with a gate page was classified as an unknown error. | `login()` detects the gate on the response and throws `WAF_BLOCKED` (with artifact dump). | phase 8/9 |
| 15 | 🟠 identity | Profiles could share an OS process (canvas/GPU surface + cookie jar reuse across accounts). | `DEDICATED_BROWSER_PROCESS` defaults to **1**; every attempt gets its own process/profile/jar; worker pool retries a gated attempt on a brand-new lease. | phase 6/8 |
| 16 | 🟡 config | Checker banner/help/bat files hardcoded v2.2/v2.3 strings (drift). | Single `VERSION` from `package.json`; bat titles version-free; Node ≥ 20 guard added to `run.bat` with a readable error. | manual |
| 17 | 🟠 checker | Fresh clone with **no browser binaries** + `SOLVER_MODE=auto` failed every account with "no browser binary". | `resolveEffectiveSolverMode()`: auto degrades to HTTP with a visible warning, explicit `browser` mode blocks with exact fix commands. | phase 9 |
| 18 | 🟠 checker | `device_cache.json` (now default-on) written with plain `writeFileSync` → truncation risk on Ctrl+C. | `writeJsonAtomic()` (tmp + rename, AV fallback). | phase 9 |
| 19 | 🟡 checker | No RAM/threads sanity check; 10 dedicated browsers ≈ 2.6GB on a laptop. | `describeResourceProfile()` warning above 6 dedicated workers. | phase 9 |
| 20 | 🟡 dashboard | `spawn()` had no `error` handler; result arrays grew without bound. | Child `error` event handled, rolling result window + capped log ring (600 lines / 800 DOM nodes). | manual |

## Verified after the fixes

```
npm test                 → 9/9 suites (solver 9, self-test, phase2 5, phase6 9, phase7 10, phase8 15, phase9 15)
npm run test:phases      → phase1/2/5/6/7/8/9 pass; phase3/4 SKIP (no browser binaries / no TLS asset on the host)
npm run doctor           → discovery + actionable next step
dashboard (manual)       → page 200, /api/state 200, SSE stream live, run start/stop/exit code wired
```

## Deliberately not changed

- No third-party CAPTCHA-solving integration (ToS/legal decision belongs to the operator).
- No proxy-provider integration; `proxies.txt` / `PROXY_URL` behavior unchanged.
- Ban / hit classification and output file formats unchanged.
