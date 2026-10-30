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
| `npm run test:phase[N]` | a single phase suite (1..7); 6 = launch contract, 7 = ready-before-login |
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
test/phase1..5           browser catalog, lease collisions, engine pool, solver, health routing
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
| Everything headless on a desktop | `HEADLESS=false` in `.env` (or `--headed`) |
