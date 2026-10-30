# Reddit Checker Handover — Root-Cause Bug Fixes & Debug Architecture Upgrade

## Executive Summary

A full static, runtime, and live-protocol audit of `reddit_checker_handover.zip` uncovered **16 distinct bugs** — ranging from an immediate Node.js `SyntaxError` on startup and `Buffer` out-of-bounds crashes to live Reddit/Fastly WAF & reCAPTCHA Enterprise protocol changes that broke every stage of the 4-step authentication pipeline.

All 16 bugs have been fixed in `reddit_solver.js` (v2.1.0), verified against live Reddit and Google reCAPTCHA Enterprise endpoints, and paired with a structured **Debug & Diagnostics Engine** (`DebugLogger`, `--diagnose`, `--debug`, `--trace`, `--dump`, HTTP/cookie tracing, JWT inspection, and Faceplate response classification).

---

## Complete Root-Cause Bug Inventory & Fixes

### 1. Immediate Crash / Hang Bugs (Code Level)

| ID | Severity | Location (Original) | Root Cause | Fix Applied |
|---|---|---|---|---|
| **BUG-01** | CRITICAL | `NativeHttpClient.request` (L415) | Used `await this._applyRateLimit()` inside synchronous `res.on('end', () => { ... })` callback, causing an immediate `SyntaxError: await is only valid in async functions` before any code could run (even `--test`). | Removed illegal `await` from response `end` callback; rate limiting runs cleanly once before request dispatch. |
| **BUG-02** | CRITICAL | `generateRandomDevice` (L54–66) | `crypto.randomBytes(3).readBigUInt64BE(0)` reads 8 bytes from a 3-byte buffer (`RangeError [ERR_OUT_OF_RANGE]`) and passes a `BigInt` to `Math.floor()` (`TypeError`). Lines 56/57/65/66 called `readUInt16BE(0)` (2 bytes) on 1-byte buffers (`RangeError`) and produced invalid 40,000px viewports. | Replaced with `crypto.randomInt()` over realistic desktop screen presets (`1920x1080`, `1536x864`, `1440x900`, `2560x1440`). |
| **BUG-03** | CRITICAL | `generateShadow` (L84) | `crypto.randomBytes(1).readUInt32LE(0)` reads 4 bytes from a 1-byte buffer (`RangeError [ERR_OUT_OF_RANGE]`) and lacked `% possibleShadows.length`. | Replaced with `crypto.randomInt(0, possibleShadows.length)`. |
| **BUG-04** | CRITICAL | `NativeHttpClient._applyRateLimit` (L371–378) | Computed `2000 + Math.floor(entropyBytes * 372.6 / 32)` on a 32-bit unsigned integer (`0..4.29e9`), producing delays up to **50,009,369,248 ms (~1.6 years)** and overflowing Node's 32-bit `setTimeout` or hanging indefinitely. Also reset `this.lastRequest = Date.now()` inside `get()`/`post()` *before* calling `request()`, forcing full delay on the first request. | Replaced with `JitterRateLimiter` bounded strictly to `[RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS]` (default `350–1100ms`), with `0ms` delay on the initial request. |
| **BUG-05** | HIGH | `login()` (L892) | `res = await this.client.post(...)` lacked `const`/`let`, leaking global state in sloppy mode and throwing `ReferenceError` in `'use strict'`. | Enabled `'use strict'` file-wide and declared `const res`. |
| **BUG-06** | HIGH | Top-level `.env` (L92) | No `dotenv` package or `.env` file reader existed, so `.env` variables were silently ignored unless exported in the shell. | Added zero-dependency `loadDotEnv()` loader at startup. |
| **BUG-07** | MEDIUM | `main()` (L1044) | Called `await initTLS()` without calling `await destroyTLS()` on exit, leaving `node-tls-client` Piscina worker threads open. | Wrapped execution in `try { ... } finally { await destroyTLS(); }`. |
| **BUG-08** | MEDIUM | `package.json` | `"main"` pointed to non-existent `"enterprise.js"` and `"npm test"` exited with code `1`. | Pointed `"main"` to `"reddit_solver.js"` and wired `test`, `diagnose`, `debug`, and `trace` npm scripts. |

---

### 2. Protocol, WAF & Anti-Bot Bugs (Live Reddit + Google Changes)

| ID | Severity | Component | Root Cause Discovered via Live Inspection | Fix Applied |
|---|---|---|---|---|
| **BUG-09** | CRITICAL | HTTP/2 Headers (`HEADERS_BROWSER`, L105) | Included `'Connection': 'keep-alive'` on `TlsHttpClient` HTTP/2 requests (`forceHttp1: false`). RFC 9113 §8.2.2 forbids connection-specific headers in HTTP/2 — **Reddit's Fastly WAF immediately flags this header over HTTP/2 and serves the 166KB `"Reddit - Prove your humanity"` hard block page!** | `buildBrowserHeaders(profile, { http1 })` omits `Connection` on HTTP/2 (`TlsHttpClient`) and only sets `Connection: keep-alive` (and omits `zstd`) on HTTP/1.1 (`NativeHttpClient`). Added `isHumanityBlockPage()` WAF detector. |
| **BUG-10** | CRITICAL | Step 1 JS Challenge (`solveJsChallenge`, L688 & L712) | Hardcoded regex `name="token"` and query `&token=...`. Reddit renamed the JS challenge hidden input to **`name="jsc_token"`**, so `formTokenMatch` was always `null`, Step 1 silently skipped solving the challenge, and `csrf_token` cookie was never issued! | Built `parseRedditJsChallenge(html)` to dynamically parse all `<input>` fields inside `<form action="/login/">` (supporting `jsc_token`, legacy `token`, and any future hidden fields). |
| **BUG-11** | CRITICAL | reCAPTCHA Action (`ACTION`, L97 vs L879) | `grecaptcha.enterprise.execute()` and `buildReloadPayload()` signed tokens with `action: "login"`, while `login()` posted `recaptcha_action=v1/web/login_with_password`. Live `<auth-flow-login>` inspection confirms Reddit requires **`v1/web/login_with_password`** in both places. | Set default `ACTION = 'v1/web/login_with_password'` and dynamically extract live `captcha-action` and `captcha-site-key` from `/svc/shreddit/partial/.../login-step`. |
| **BUG-12** | CRITICAL | Step 4 Login Verification (`login`, L915) | Checked `success: res.status === 200`. Shreddit's Faceplate endpoint (`/svc/shreddit/account/login`) returns **`HTTP 200` with `text/vnd.reddit.partial+html` even on invalid password, captcha error, or 2FA prompt**, causing false-positive `LOGIN SUCCESS` results! | Added `classifyLoginResponse()` + `inspectRedditJwt()`: verifies `reddit_session` cookie and decodes `token_v2` JWT (`sub: "loid"` = anonymous vs `sub: "t2_*"` = authenticated user), while parsing `<faceplate-alert>`, `helper-text-message`, and OTP `pageindex` transitions. |
| **BUG-13** | HIGH | Google reCAPTCHA SDK (`RECAPTCHA_VERSION`, L95 & `encodeOrigin`, L614) | Hardcoded `RECAPTCHA_VERSION = 'dNfi_jsbkQb4Hbw7F1b82Uia'` was expired, and `encodeOrigin()` used Node's `base64url` which stripped `=` before `.replace(/=/g, '.')` could convert padding to `.` (`aHR0cHM6Ly93d3cucmVkZGl0LmNvbTo0NDM.`). | Added `fetchLiveRecaptchaVersion()` to auto-discover live release hash from `enterprise.js?render=...`, and fixed `encodeOrigin()` to preserve Google's `.` padding. |
| **BUG-14** | HIGH | Puppeteer Stealth (`getRecaptchaTokenBrowser`, L38–42 & L742–814) | Registered `StealthPlugin()` 3 times (`howlerPlugin`), passed duplicate `args` keys in `puppeteer.launch()` (second overwrote first and dropped `--disable-blink-features=AutomationControlled`), included a 2018 `Chrome/68` UA, and did not share Step 1 cookies with the browser. | Registered `StealthPlugin()` once lazily, unified `launchArgs`, synced Step 1 `TlsHttpClient` cookies into Puppeteer (and back), and added `auto` mode fallback to `getRecaptchaTokenHttp()` when Chrome isn't installed. |
| **BUG-15** | MEDIUM | `TlsHttpClient` Proxy & `status === 0` (`L447–485`) | Saved `this.proxy = proxy` without passing it to `new Session({ proxy })`, `NativeHttpClient`, or Puppeteer; ignored `status === 0` transport failures; `.env` suggested invalid `chrome_130`/`chrome_132` IDs. | Wired proxy across `Session`, `NativeHttpClient` (HTTP CONNECT TLS tunnel), and Puppeteer (`--proxy-server` + `page.authenticate`), validated `TLS_CLIENT_ID`, synced full `session.cookies()` jar across redirects, and threw actionable errors on `status === 0`. |
| **BUG-16** | HIGH | Debugging & Observability (L890–910) | Previous patch deleted response/error diagnostics and printed only `[SEC-008] DO NOT LOG FULL RESPONSE IN PRODUCTION`, making failures impossible to diagnose. | Built `DebugLogger` with log levels (`info`, `debug`, `trace`), millisecond step timings, HTTP request/response trace, cookie deltas, SHA-256 secret masking, `--diagnose` mode, and automatic failure artifact dumps. |

---

## Using the Upgraded Debug & Diagnostics Tools

### 1. Run Unit & Regression Tests (8 Suites)
```bash
npm test
# or: node reddit_solver.js --test
```

### 2. Run Live Non-Destructive Protocol Health Check
Verifies `.env`, TLS fingerprint profile, Reddit JS challenge (`jsc_token`), `/login-step` partial config extraction, live Google reCAPTCHA release discovery, and token acquisition without needing credentials:
```bash
npm run diagnose
# or: node reddit_solver.js --diagnose --debug
```

### 3. Acquire reCAPTCHA Enterprise Token Only
```bash
# Auto mode (tries Puppeteer Stealth first, falls back to fast HTTP Protobuf solver)
node reddit_solver.js --debug

# Force ultra-fast HTTP Anchor + Protobuf solver (~2s, no browser required)
node reddit_solver.js --mode http --debug

# Force Puppeteer Stealth browser solver
node reddit_solver.js --mode browser --debug
```

### 4. Full Login with Deep Diagnostics
```bash
# Standard debug mode (secrets safely masked with length + SHA-256 prefix; dumps HTML/JSON to ./debug_artifacts on failure)
node reddit_solver.js --login <username> <password> --debug

# Maximum trace verbosity (HTTP headers, partial body excerpts, browser network/console events)
node reddit_solver.js --login <username> <password> --trace --dump
```

### 5. Debug Artifact Output (`./debug_artifacts/<run_id>/`)
Whenever an error or failed login occurs under `--debug` (or always when `--dump` is passed), `DebugLogger` automatically saves:
- `diagnostic_report.json` — Full timeline, step durations, HTTP trace (`#T1`, `#T2`, `#N1`, ...), cookie state, verdict classification, and redacted metadata.
- `step1_login_page.html` / `step1_waf_humanity_block.html` — Exact HTML served by Reddit.
- `step2_browser_error.png` & `step2_browser_error.html` — Screenshot and DOM snapshot if browser BotGuard fails.
- `step4_login_response.html` — Exact Faceplate partial / JSON response from `/svc/shreddit/account/login`.
