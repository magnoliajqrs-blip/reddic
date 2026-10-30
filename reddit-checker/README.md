# reddit-checker

Bulk Reddit account checker + Shreddit/reCAPTCHA-Enterprise login solver with a
zero-collision hybrid browser-rotation layer (Chromium / Firefox / WebKit).

> ⚠️ **Status:** personal research tool, not a hosted service. It automates logins against a
> third-party site — you are responsible for complying with Reddit's Terms of Service and
> local law. Credentials live only in `accounts.txt` / `.env`, both git-ignored.

---

## Quick start

```bash
# 1. requirements: Node >= 20  (tested on 22.22.3)
node -v

# 2. dependencies  (209 packages, ~5s)
npm ci

# 3. browser engines used by the rotation layer (Chromium + Firefox + WebKit)
npm run setup:browsers
#    Linux server: sudo npx rebrowser-playwright-core install-deps chromium firefox webkit

# 4. configuration
cp .env.example .env          # Windows: copy .env.example .env
#    then fill accounts.txt (user:pass per line) and proxies.txt (optional)

# 5. run the bulk checker (visible browsers on Windows by default)
npm start                     # == node reddit_checker.js --headed
npm run dashboard             # optional live SSE dashboard on DASH_PORT
```

## Commands

| Command | What it does |
|---|---|
| `npm start` / `npm run check` | bulk checker, headed browsers |
| `npm run solver` | solver entry (`reddit_solver.js`) |
| `npm run dashboard` | SSE dashboard for a running check |
| `npm run doctor` | **start here when browsers misbehave**: discovery table, TLS asset, cache, next step |
| `npm run doctor:launch` | same, but it really launches every engine and prints the fingerprint it presents |
| `npm test` | **hermetic** unit suites — passes offline, no browsers needed (includes phase 6, the launch contract) |
| `npm run test:all` | everything incl. live TLS / browser / Reddit probes (needs network + browsers; those steps SKIP with a reason when impossible) |
| `npm run test:phase[N]` | a single phase suite (1..9); 6 = launch contract, 7 = ready-before-login, 8 = bot gate, 9 = hardening |
| `npm run verify-rotation` | live N-worker rotation + WAF check |
| `npm run diagnose` | end-to-end login diagnostics |
| `npm run debug` / `trace` | structured debug / full trace |

`npm test` is deliberately offline-safe. Anything that needs a real browser binary, a
downloaded TLS client, or reddit.com lives behind `npm run test:all` — and those steps SKIP with
a reason instead of failing when the machine cannot do them.

### The login ordering guarantee

```
Step 1  TLS client → /login/ → csrf_token, loid, session
Step 2  browser     → wait for load + network quiet + real login form → grecaptcha.execute()
                    → settle network → harvest final cookies (csrf/session/loid) into the TLS jar
Step 4  TLS client  → ensureLoginSessionReady() → POST /svc/shreddit/account/login
```

Step 4 cannot fire while the page is still streaming, and it refreshes the login page once if the
cookie handover from the browser was incomplete (`src/rotation/BrowserReadiness.js`).

### "Prove your humanity" — the bot gate (v2.4.0)

If Reddit serves `Reddit - Prove your humanity` (a reCAPTCHA v2 checkbox) instead of the login
form, the request never reached the account at all: the **egress IP** is flagged. No fingerprint
trick fixes a datacenter IP — but the checker now handles that case properly instead of failing
with a misleading "reCAPTCHA failed":

- the gate is detected **before** the readiness wait (`src/rotation/BotGateRecovery.js`),
  including `humanity`, `whoa there pardner`, `429` and generic block pages;
- a checkbox gate is clicked for real (anchor iframe → bounding-box mouse click → DOM click),
  then the redirect back to `/login/` is awaited (`BOT_GATE_TIMEOUT_MS`, default 45s);
- Chromium launches with `--disable-http2` (Reddit fingerprints the HTTP/2 layer) and every
  account attempt gets its **own OS browser process**, own profile, own cookie jar;
- a gated attempt is retried once on a **brand-new identity** (`WAF_RETRY_ATTEMPTS`), then
  reported as `WAF_BLOCKED`, written to `retry_errors.txt` and **not** counted as invalid/banned;
- `DEVICE_CACHE` is now on by default and keyed per username, so a re-checked account returns
  with its own `loid/rdt/edgebucket/csv` instead of looking like a new device.

What actually fixes the gate: retry on a **home/residential IP** (phone hotspot or a Tailscale
exit node on your home connection), keep `HEADLESS=false`, leave `DISABLE_HTTP2=1`. Checkbox
CAPTCHAs cannot be solved programmatically on a blocked IP — the code says so honestly instead of
pretending the account failed. Full scope: **[PLAN_bot_gate.md](./PLAN_bot_gate.md)**.

### v2.5.0 — project-wide hardening

A full top-to-bottom audit (findings + fixes + tests: **[AUDIT_v2.5.md](./AUDIT_v2.5.md)**).
Highlights:

- **Ctrl+C now actually stops the run** — the checker, solver CLI and dashboard close every
  browser and TLS session on SIGINT/SIGTERM (no more orphaned Chromium windows on Windows).
- **Missing TLS asset is explained**, not silently crashed: the `node-tls-client` download failure
  that used to close the window now prints the exact fix (install.bat / `.bin_cache` / Node path).
- **Transport retry**: one flaky proxy hop no longer costs an account; a POST is retried only when
  it provably never left the machine.
- **No more corrupt bodies**: gzip/brotli/zstd decoding is centralised and fails loudly instead of
  handing compressed bytes to the HTML parsers (`zstd` is only advertised when Node can decode it).
- **Domain-scoped cookies** in the fallback HTTP client (reddit session cookies never leak to
  google.com and vice versa).
- **Preflight**: no browser binaries → `auto` mode degrades to HTTP with a warning, explicit
  `browser` mode refuses to start and prints the exact commands; >6 dedicated browsers triggers a
  RAM warning.
- **`device_cache.json` is written atomically**; numeric `.env` typos can no longer become `NaN`.
- **`dashboard.js` was a stub** (no server/UI, it exited immediately). It is now a complete,
  dependency-free local dashboard.

### Dashboard

```
npm run dashboard          # http://127.0.0.1:8787  (DASH_PORT / DASH_HOST)
```

Start/stop a run, watch hits/bans/resets/2FA/invalid live, CPM + ETA, and the full checker log.
It binds to loopback by default because it can start a credential-checking run; set
`DASH_HOST=0.0.0.0` only on a trusted machine.

## Outputs (append-only, written as each account finishes)

```
hits.txt  hits_clean.txt  banned.txt  password_reset.txt  2fa.txt  invalid.txt  retry_errors.txt
results/hits_cookies.jsonl      # full session cookies per hit
results/device_cache.json       # reusable device profiles (DEVICE_CACHE=1)
```

All of these are git-ignored. `accounts.txt`, `proxies.txt`, `.env` are git-ignored too.

## Layout

```
reddit_checker.js        bulk orchestrator + CLI (entrypoint)
reddit_solver.js         core solver: protobuf, TLS/HTTP clients, 4-step login, health classifier
src/rotation/            catalog → fingerprint → lease → engine pool → TLS bridge
dashboard.js             tiny SSE dashboard
scripts/                 Windows installer + post-install verification
test/phase1..9           catalog, lease collisions, engine pool, solver, health, launch, readiness, bot gate, hardening
```

Architecture, env matrix and the defect register: **[PROJECT_MAP.md](./PROJECT_MAP.md)**.
Root-file improvement backlog: **[ROOT_FILES_PLAN.md](./ROOT_FILES_PLAN.md)**.
Original operating manual: **[HANDOVER_GUIDE.md](./HANDOVER_GUIDE.md)** (v2.2 — see drift note in PROJECT_MAP).

## Windows one-click

`install.bat` → dependencies + 3 browser engines + TLS dll verification.
`run.bat` → bulk checker. `run_menu.bat` → diagnostics menu.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tls-client-x64.so` / `.dll` missing | Windows: `install.bat`. Linux/macOS: first run downloads it, or set `TLS_CLIENT_ID` after `npm rebuild node-tls-client` |
| `Chromium binary must be discovered` | `npm run setup:browsers`, then `npm run doctor` |
| Process dies instantly, log ends at `tls-client-x64.so` missing | first `npm run diagnose` needs network to fetch the ~15MB native lib; offline → use `--mode browser`, or copy the file into `os.tmpdir()` / `.bin_cache/` |
| `BROWSER_MINIMIZED=true` but windows still show | fixed in 2.3.1 — minimisation now goes through CDP after the page exists (Chromium only) |
| `npm test` failing on live steps | expected offline — use `npm test`, not `npm run test:all` |
| Checker refuses to start with `SOLVER_MODE=browser` | `npm run setup:browsers` first, or run `--mode auto` |
| Everything headless on a desktop | `HEADLESS=false` in `.env` (or `--headed`) |
| `[WAF/GATE]` rows / "Prove your humanity" page | that IP is flagged — switch to a residential/home IP; see the bot-gate section above |
| Checkbox visible but never turns green | keep the window visible (`HEADLESS=false`, `BROWSER_MINIMIZED=false` once) and raise `BOT_GATE_TIMEOUT_MS` |
| Browser windows still show with `DEDICATED_BROWSER_PROCESS=1` | minimisation goes through CDP; on very slow machines raise `BROWSER_MINIMIZED` startup delay |
| `node-tls-client` "Failed to fetch the latest version" then the window closes | run `install.bat`, or copy `tls-client-64.dll` into the path printed by the banner, or drop it in `.bin_cache/` |
| `node dashboard.js` exits instantly (older build) | fixed in 2.5.0 — the dashboard now serves `http://127.0.0.1:8787` |
| Everything too slow / account takes minutes | check `PAGE_DWELL_MS` (8s default) and `BOT_GATE_TIMEOUT_MS` (45s); a gated IP waits for the checkbox |
