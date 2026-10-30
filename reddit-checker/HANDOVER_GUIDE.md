# Reddit Solver (v2.2) — Hybrid Multi-Browser Rotation & Operations Guide

## 1. Project Overview

This system automates Reddit's modern **Shreddit / Faceplate** login handshake protected by **reCAPTCHA Enterprise v3**, powered by a **Zero-Collision Hybrid Multi-Browser Rotation System**:

### Hybrid Browser Rotation Architecture (`src/rotation/*`)
Combines **both** rotation methods in a single unified pool so no two concurrent workers or `worker_threads` ever share the same browser identity, TLS JA3/JA4 signature, or Canvas/WebGL fingerprint:

- **Method 1 — Single-Engine Multi-Context Pooling (`single-engine` / `hybrid`)**:
  - Runs 1 shared OS browser process per engine while allocating completely isolated incognito `BrowserContext`s per worker (`Chrome`, `Edge`, `Opera`, `Brave`, `Vivaldi`, `Ungoogled-Chromium`), saving ~65–75% RAM.
- **Method 2 — Multi-Engine Native + Open-Source Anti-Detect (`multi-engine` / `hybrid`)**:
  - Simultaneously rotates across **3 genuine browser engines** via `rebrowser-playwright-core`:
    1. **Blink / Chromium**: `Google Chrome`, `Microsoft Edge`, `Opera`, `Brave`, `Vivaldi`, `Ungoogled / Fingerprint-Chromium`
    2. **Gecko / SpiderMonkey**: `Mozilla Firefox`, `Camoufox` (Open-Source Anti-Detect)
    3. **WebKit / JavaScriptCore**: `Apple Safari`
  - Automatically passes native C++ CLI flags (`--fingerprint=<seed>`, `--fingerprint-brand=<Brand>`, `--fingerprint-platform=<os>`) when `FINGERPRINT_CHROMIUM_PATH` or `CAMOUFOX_EXECUTABLE_PATH` is configured.
- **1:1 TLS & HTTP/2 Parity (`TlsHeaderBridge.js`)**:
  - Every worker's `TlsHttpClient` (`chrome_131`, `chrome_124`, `opera_91`, `firefox_133`, `firefox_132`, `safari_16_0`, `safari_15_6_1`) matches its browser engine, OS, Client-Hints (`sec-ch-ua` strictly omitted on Firefox/Camoufox/Safari), `Accept-Encoding` (no `zstd` on Safari), and TLS extension ordering (`randomTlsExtensionOrder: false` on NSS/Apple TLS).

---

## 2. Quick Start & Installation

### Option A: Windows One-Click Setup & Bulk Checker (Recommended on Windows 10 / 11)
1. **Extract the `.zip` archive** into a normal folder (Right-Click -> **Extract All...**).
2. Double-click **`install.bat`** (one-time setup):
   - Installs all `npm` dependencies, downloads all **3 browser engines** (`Chromium`, `Firefox`, `WebKit`), pre-downloads & verifies Windows **`tls-client-64.dll`**, test-launches each browser, and shows exact on-screen errors if anything fails.
3. Paste your accounts into **`accounts.txt`** (`username:password`, one per line) and optional proxies into **`proxies.txt`**.
4. Double-click **`run.bat`**:
   - **Directly starts the Bulk Account Checker (`reddit_checker.js --headed`)** with **real visible browser windows (`HEADLESS=false`)** running in the background (`Chrome`, `Edge`, `Opera`, `Brave`, `Vivaldi`, `Firefox`, `Camoufox`, `Safari`).
   - Saves results live as each account finishes into **`hits.txt`**, **`2fa.txt`**, **`locked.txt`**, **`invalid.txt`**, **`retry_errors.txt`**, and **`results/hits_cookies.jsonl`** (full session cookies).
   - *(Tip: Set `BROWSER_MINIMIZED=true` in `.env` if you prefer browsers auto-minimized to the taskbar, or `HEADLESS=true` to hide them completely.)*
5. Optional: Double-click **`run_menu.bat`** for diagnostics (`--diagnose`, `--verify-rotation 6`, `npm test`, single-account test).

### Option B: Manual CLI Setup (Windows / Linux / macOS)

```bash
# 1. Install Node dependencies
npm install

# 2. Install real Chromium, Firefox (Gecko), and WebKit (Safari) browser engines
npx rebrowser-playwright-core install chromium firefox webkit
# (On a fresh Linux VPS, run once with root/sudo to install shared GTK/font libraries):
# sudo npx rebrowser-playwright-core install-deps chromium firefox webkit

# 3. Run all 27 automated test suites (Core Solver + Phases 1, 2, 3, and 4)
npm test

# 4. Run live 6-worker Hybrid Browser + Reddit WAF rotation verification
npm run verify-rotation

# 5. Run live end-to-end Reddit + BotGuard diagnostics
npm run diagnose
```

---

## 3. CLI Commands & Rotation Flags

```bash
# Live verify 9 simultaneous workers (9 distinct browsers across 3 engines + live Reddit WAF check)
node reddit_solver.js --verify-rotation 9 --rotation-mode hybrid

# Live diagnostics forcing genuine Mozilla Firefox (Gecko + firefox_133 TLS)
node reddit_solver.js --diagnose --mode browser --brand firefox

# Live diagnostics forcing genuine Apple Safari (WebKit + safari_16_0 TLS)
node reddit_solver.js --diagnose --mode browser --brand safari

# Token-only mode via fast HTTP Anchor + Protobuf (~1.5s, zero browser RAM)
node reddit_solver.js --mode http --debug

# Full 4-step Reddit login (auto-rotates browser brand & syncs TLS + Browser cookies)
node reddit_solver.js --login <username> <password> --rotation-mode hybrid --debug

# Route all traffic (TLS client, Native HTTPS & Playwright BrowserContext) via proxy
node reddit_solver.js --login <username> <password> --proxy http://user:pass@host:port --debug
```

| Flag | Environment Variable | Description |
|---|---|---|
| `--test` | — | Runs the core unit & regression test suites |
| `--diagnose` | — | Live end-to-end Reddit JS challenge + Hybrid Pool + reCAPTCHA check |
| `--verify-rotation [N]` | — | Launches `N` concurrent workers across real browsers + live Reddit WAF |
| `--rotation-mode <mode>` | `ROTATION_MODE` | `hybrid` (default), `single-engine` (Method 1), or `multi-engine` (Method 2) |
| `--brand <brandId>` | `PREFERRED_BRAND` | Force `chrome`, `edge`, `opera`, `brave`, `vivaldi`, `ungoogled_chromium`, `firefox`, `camoufox`, or `safari` |
| `--mode <auto\|browser\|http>` | `SOLVER_MODE` | Token strategy (`auto` uses Hybrid Browser Pool + HTTP Protobuf fallback) |
| `--proxy <url>` | `PROXY_URL` | Routes `TlsHttpClient`, `NativeHttpClient`, and `BrowserContext` via proxy |
| `--debug` / `--trace` | `LOG_LEVEL` | Structured debug / full trace logging + failure artifact dumps |

---

## 4. Programmatic Multi-Worker Usage (`RotationWorkerPool` & `worker_threads`)

### A. Parallel Batch Account Checking (`RotationWorkerPool`)
```js
const { initTLS, destroyTLS } = require('node-tls-client');
const { RotationWorkerPool } = require('./reddit_solver');

(async () => {
  await initTLS();
  const pool = new RotationWorkerPool({
    rotationMode: 'hybrid', // 9 brands across Chromium + Firefox/Camoufox + Safari/WebKit
    solverMode: 'auto',
    concurrency: 6,         // 6 workers -> guaranteed 6 completely different browsers!
    proxies: [
      // Provide per-worker proxies or set isRotatingGatewayProxy: true for a rotating gateway
    ],
  });

  try {
    const results = await pool.runAccountBatch(
      [
        { username: 'account_one', password: 'password_one' },
        { username: 'account_two', password: 'password_two' },
      ],
      {
        onResult: (res) => {
          console.log(`[${res.workerId}] ${res.username} via ${res.brandId}(${res.tlsClientId}) -> ${res.verdict}`);
        },
      }
    );
  } finally {
    await pool.shutdown();
    await destroyTLS();
  }
})();
```

### B. Multi-Threading with Node.js `worker_threads` (`WorkerThreadLeaseBridge`)
If you spawn OS threads with `new Worker(...)`, attach them to a single central `ProfileLeaseManager` on the main thread via `attachLeaseManagerToWorker(worker, leaseManager)` and use `new WorkerLeaseClient()` inside each worker thread — ensuring zero cross-thread browser collisions and automatic lease cleanup if a thread crashes.

---

## 5. Module Reference (`src/rotation/`)

| File | Responsibility |
|---|---|
| `src/rotation/ProfileCatalog.js` | 9 browser brands, 3 engines, 59 WAF-clean `(brand, version, os)` base variants, OS-locked GPU/screen/locale tables |
| `src/rotation/FingerprintSynthesizer.js` | 64-bit `SeededRng`, Apify Bayesian `FingerprintGenerator`, C++ `fingerprint-chromium` CLI flags, engine-safe `buildContextInitScript()` |
| `src/rotation/TlsHeaderBridge.js` | 1:1 `node-tls-client` session options, RFC 9113 HTTP/2 headers, 12-point `validateProfileParity()` |
| `src/rotation/ProfileLeaseManager.js` | Atomic `AsyncMutex`, 4-tier anti-collision scorer, burned LRU history, `markBurned()` WAF cooldown, TTL reaper |
| `src/rotation/WorkerThreadLeaseBridge.js` | `worker_threads` RPC bridge + automatic crashed-thread lease recovery |
| `src/rotation/EnginePoolManager.js` | Shared multi-context + multi-engine Playwright runner (`Chromium`, `Firefox`/`Camoufox`, `WebKit`/`Safari`) + memory recycler |
| `src/rotation/RotationWorkerPool.js` | High-concurrency `RedditSolver` orchestrator, per-IP Fastly burst pacer, and `verifyLiveRotation()` |

See [`BUGFIX_AND_DEBUG_REPORT.md`](./BUGFIX_AND_DEBUG_REPORT.md) for the v2.1 bug fixes and [`BROWSER_ROTATION_MASTER_PLAN.md`](./BROWSER_ROTATION_MASTER_PLAN.md) for the full 4-phase architecture specification.
