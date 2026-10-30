# PROJECT_MAP — reddit-checker (restored source, mapped 2026-10-30)

> এই ফাইলটা **কোড পড়ে** বানানো — অনুমান নয়। পুরনো [`project_mapping.md`](./project_mapping.md) ১০ মাস আগের ও ভুল (দাবি করে `reddit_solver.js` ১০০৬ লাইন, বাস্তবে ৪১৪৪; আর এমন ৪টা Python ফাইলের কথা বলে যেগুলো প্রজেক্টে নেই)। এই ফাইলটাই সত্য ধরে কাজ করুন।

**Snapshot:** 18টি JS ফাইল · **11,066 LOC** · 9 runtime dependency · Node 22.22.3 (পরীক্ষিত) · npm ci = 209 packages / 4s

---

## ১. সিস্টেমটা আসলে কী

Reddit-এর Shreddit/Faceplate login handshake automate করে — reCAPTCHA Enterprise v3 টোকেন বানিয়ে `POST /svc/shreddit/account/login`-এ পাঠায়, তারপর অ্যাকাউন্টের health (active / banned / shadowban / password-reset lock) ঠিক করে। উপরে বসানো আছে একটা **zero-collision browser rotation layer**: প্রতি worker আলাদা browser brand + আলাদা TLS JA3 fingerprint পায়।

```
run.bat ──► reddit_checker.js  (bulk orchestrator, CLI + .env + accounts.txt/proxies.txt)
                │
                ├─► RotationWorkerPool ──► N × RedditSolver
                │        │                     │
                │        ├─ ProfileLeaseManager (atomic lease, burned LRU, TTL reaper)
                │        │        └─ WorkerThreadLeaseBridge (worker_threads RPC)
                │        ├─ ProfileCatalog      (9 brands × 3 engines × 62 OS/version slots)
                │        ├─ FingerprintSynthesizer (seeded RNG → canvas/WebGL/navigator)
                │        ├─ EnginePoolManager   (Playwright: chromium / firefox / webkit)
                │        └─ TlsHeaderBridge     (browser ↔ TLS/H2 header parity, 12-point check)
                │
                ├─► results/*.txt + results/hits_cookies.jsonl  (append as each account finishes)
                └─► dashboard.js (DASH_PORT, SSE live view of the run)
```

দুইটা solver path: **browser** (Playwright + real engines, BotGuard-সহ) আর **http** (node-tls-client + hand-built protobuf reload, ~1.5s, RAM শূন্য)। `SOLVER_MODE=auto` হলে hybrid।

---

## ২. ফাইল ইনভেন্টরি (root → leaf)

| ফাইল | LOC | ভূমিকা | রপ্তানি / এন্ট্রি |
|---|---:|---|---|
| `reddit_solver.js` | 4,144 | **core engine**: protobuf writer, TLS+HTTP clients, 4-step login, BotGuard, health classifier, rotation pool | `RedditSolver, RotationWorkerPool, EnginePoolManager, ProfileLeaseManager, TlsHttpClient, NativeHttpClient, ProtobufWriter, DebugLogger, JitterRateLimiter, selectBrowserProfile, buildReloadPayload, generateField20/22, …` |
| `reddit_checker.js` | 753 | **primary entrypoint**: bulk checker, parsing, output routing, CLI | `parseAccountsText, parseProxiesText, createOutPaths, recordAccountOutcome, runBulkChecker` |
| `src/rotation/EnginePoolManager.js` | 922 | shared Playwright contexts + multi-engine launch, memory recycler, `resolveEffectiveHeadless()` | `EnginePoolManager, resolveEffectiveHeadless` |
| `scripts/windows_install_runner.js` | 815 | Windows installer/bootstrapper | `main()` |
| `src/rotation/FingerprintSynthesizer.js` | 603 | seeded fingerprint synthesis + context init script | `FingerprintSynthesizer, SeededRng` |
| `src/rotation/ProfileLeaseManager.js` | 551 | atomic mutex, anti-collision scorer, burned LRU, TTL | `ProfileLeaseManager, AsyncMutex` |
| `src/rotation/RotationWorkerPool.js` | 439 | worker orchestration, burst pacer, `verifyLiveRotation()` | `RotationWorkerPool` |
| `src/rotation/ProfileCatalog.js` | 405 | brand/engine/OS catalogue + GPU/screen/locale tables | `BROWSER_BRANDS, getProfilesForMode, …` |
| `src/rotation/TlsHeaderBridge.js` | 340 | TLS session options + RFC 9113 headers + parity audit | `buildTlsSessionOptions, buildBrowserHeaders, validateProfileParity` |
| `src/rotation/WorkerThreadLeaseBridge.js` | 198 | `worker_threads` lease RPC + crash recovery | `attachLeaseManagerToWorker, WorkerLeaseClient` |
| `src/rotation/index.js` | 11 | barrel re-export | — |
| `dashboard.js` | 133 | tiny HTTP+SSE dashboard | `startRun, stopRun` |
| `scripts/windows_verify_setup.js` | 216 | post-install verification | `main()` |
| `test/phase1..phase5` | 1,600 | 5 phase suites (catalog/lease/pool/solver/health) | node scripts |
| `test/phase6_browser_launch.test.js` | 260 | **hermetic** launch-contract suite (fake Playwright: args, context options, minimize, recycle, shutdown) | node script |
| `scripts/browser_smoke.js` | 330 | `npm run doctor`: discovery + TLS asset + cache + optional real launch probe | `npm run doctor` |
| `run.bat` / `run_menu.bat` / `install.bat` | — | Windows launchers | — |
| 8 × `*.md` | — | docs (handover, master plan, audits, trackers) | — |

---

## ৩. Entrypoints ও flag

| কমান্ড | কী করে |
|---|---|
| `node reddit_checker.js [--headed\|--headless]` | bulk checker (এটাই `run.bat` চালায়) |
| `node reddit_solver.js --test` | 9 core unit suites |
| `node reddit_checker.js --self-test` | parser + outcome routing |
| `node reddit_solver.js --diagnose [--brand firefox]` | live end-to-end |
| `node reddit_solver.js --verify-rotation N` | N concurrent browser+TLS parity |
| `node reddit_solver.js --login <user> <pass>` | একটার full 4-step login |
| `node pipeline/bridge.js` | (n/a — নেই) |
| `node dashboard.js` | SSE dashboard (`DASH_PORT`) |

`--headed/--headless`, `--mode auto|browser|http`, `--rotation-mode hybrid|single-engine|multi-engine`, `--brand <id>`, `--proxy <url>`, `--debug/--trace`, `--concurrency N`.

---

## ৪. কনফিগ ম্যাট্রিক্স

কোডে **৩৯টি `process.env.*`** প্লাস destructured access (`env.HEADLESS`, `env.CHROME_PATH` — `EnginePoolManager.js:81`)। কিন্তু `.env`-এ আছে মাত্র **১৩টি**:

```
BROWSER_MINIMIZED  HEADLESS  LEASE_HISTORY_SIZE  LOG_LEVEL  MAX_CONTEXTS_PER_ENGINE
NODE_ENV  RATE_LIMIT_MAX_MS  RATE_LIMIT_MIN_MS  RECAPTCHA_ACTION  RECAPTCHA_SITE_KEY
ROTATION_MODE  SOLVER_MODE  WORKER_CONCURRENCY
```

যেগুলো কোড পড়ে কিন্তু `.env`-এ নেই (ডিফল্টে চলে, override করতে `.env.example` দরকার):
`PROXY_URL, ROTATING_PROXY, PROXY_GEO_FILE, PREFERRED_BRAND, PREFER_HTTP_SOLVER, TLS_CLIENT_ID, CHROME_PATH, PLAYWRIGHT_BROWSERS_PATH, DEVICE_CACHE, DEBUG, DEBUG_DUMP, DEBUG_DUMP_DIR, DEBUG_UNMASKED, DISABLE_RATE_LIMIT, COOKIE_WARMUP, GOOGLE_VIA_NATIVE, DEDICATED_BROWSER_PROCESS, DASH_PORT, USER_AGENT, ACCEPT_LANGUAGE, RECAPTCHA_VERSION`

CLI flag > env > কোড-ডিফল্ট — এই ক্রমটাই `parseCheckerCliArgs()` মেনে চলে।

---

## ৫. I/O চুক্তি

| ধরন | পাথ | কে লেখে |
|---|---|---|
| input | `accounts.txt` (`user:pass`) | user |
| input | `proxies.txt`, `proxy_geo.example.json` | user |
| output | `hits.txt`, `hits_clean.txt`, `banned.txt`, `password_reset.txt`, `2fa.txt`, `invalid.txt`, `retry_errors.txt` | `recordAccountOutcome()` |
| output | `results/hits_cookies.jsonl`, `results/device_cache.json` | checker |
| cache/bin | `.bin_cache/tls-client-64.dll` (Windows) | `ensureWindowsTlsDllReady()` |
| debug | `DEBUG_DUMP_DIR/` | `DebugLogger` |

**সব output append-mode** — run থামলেও যতটা হয়েছে ততটা থাকে। `createOutPaths()` প্রতিবার `results/` বানায়।

---

## ৬. টেস্ট ম্যাট্রিক্স — আজকের আসল ফল (Linux, fresh `npm ci`)

| Suite | ফল | কারণ |
|---|---|---|
| `reddit_solver.js --test` | ✅ 9/9 PASS | pure unit |
| `reddit_checker.js --self-test` | ✅ PASS | pure unit |
| `phase1_catalog` | ✅ 4/5 + Test 5 SKIP | live TLS handshake বাদে সব পাস; asset ছাড়া `initTLS()` প্রসেস kill করত — এখন preflight |
| `phase2_lease_collision` | ✅ 5/5 PASS | pure + worker_threads |
| `phase3_engine_pool` | ⏭ SKIP (exit 0) | browser binary নেই → `npm run setup:browsers` মেসেজ দিয়ে skip (আগে assertion fail হতো) |
| `phase6_browser_launch` | ✅ 8/8 PASS | fake Playwright — আসল browser ছাড়াই launch contract যাচাই |
| `phase4_solver_rotation` | ⏭ SKIP (exit 0) | TLS asset নেই → স্পষ্ট মেসেজসহ skip |
| `phase5_ban_lock_health` | ⚠️ 3/4 PASS, Suite 4 skip/fail | live Reddit OAuth probe — নেটওয়ার্ক |
| **`npm test` (পুরো চেইন)** | ❌ **exit 1** | live টেস্টগুলো unit টেস্টের সাথে `&&` দিয়ে জোড়া |

➡️ মানে: **কোড ঠিক, কিন্তু "clean machine-এ `npm test` সবুজ" — এটা সত্য নয়।** এটা root-level design সমস্যা (§ ROOT_FILES_PLAN.md P1-3)।

---

## ৭. ডিফেক্ট রেজিস্টার (প্রমাণসহ)

| # | ফাইল:লাইন | সমস্যা | সিভিয়ারিটি |
|---|---|---|---|
| D1 | `reddit_solver.js:3272-3281` | step-5-এ ordering randomisation **biased**: `randomInt(0,2)===0` তারপর *আবার* `randomInt(0,2)===0` → ৫০/২৫/২৫, intend ছিল ১/৩ করে | 🟡 logic bug (ফিক্স করা হয়েছে) |
| D2 | `.gitignore` | `accounts.txt`, `banned.txt`, `proxies.txt`, `hits_clean.txt`, `password_reset.txt` **ignore-এ নেই** → credential/output git-এ ঢুকে যাবে | 🔴 critical |
| D3 | `package.json` `test` | live TLS + browser দরকার এমন suite `&&`-এ জোড়া → fresh clone-এ fail | 🟠 |
| D4 | `package.json` | `main` = `reddit_solver.js` কিন্তু আসল entry `reddit_checker.js`; `engines` নেই; `allowScripts` npm-এর ফিল্ড নয় (উপেক্ষিত) | 🟡 |
| D5 | root | `README.md` নেই — নতুন কেউ `run.bat`/`HANDOVER_GUIDE.md` না পড়ে ঢুকতে পারে না | 🟡 |
| D6 | `project_mapping.md` | stale: ভুল LOC, ৪টা অস্তিত্বহীন Python ফাইল, "reddit_checker.js not in root" | 🟠 |
| D7 | docs | ভার্সন drift: `HANDOVER_GUIDE` v2.2 vs `package.json` 2.3.0 vs `run.bat` title v2.2 | 🟡 |
| D8 | `.env` ↔ code | ৩৯ env key, `.env`-এ ১৩টি; `.env.example` নেই | 🟠 |
| D9 | repo | `retry_errors.txt` (runtime output) version-controlled | 🟡 |
| D10 | `src/rotation/ProfileLeaseManager.js:21` | `listBrandsForMode` import করা কিন্তু অব্যবহৃত (dead import) | 🟢 |
| D11 | 19 × empty `catch {}` | error গিলে ফেলা — `DEBUG=1` ছাড়া কারণ জানা যায় না | 🟢 |
| **D12** | `EnginePoolManager` launch args | `--start-minimized` কোনো Chromium সুইচ নয় → `BROWSER_MINIMIZED=true` কখনো কাজ করেনি | 🟠 **ফিক্সড** (CDP `Browser.setWindowBounds`) |
| **D13** | `initTLS()` | asset না পেলে dependency-র ভেতর `process.exit(1)` → suite/runs নীরবে মরে | 🔴 **mitigated** (`getTlsClientAssetInfo()` preflight + skip + warning) |
| **D14** | `test/phase3` | browser না থাকলে `Chromium binary must be discovered` — ব্যবহারকারীর কিছুই বোঝার উপায় নেই | 🟡 **ফিক্সড** (actionable skip) |

---

## ৮. ঝুঁকি (আগে জানা দরকার)

1. **`reddit_checker_handover_fixed (2).rar` এখনো git history-তে আছে** এবং তার ভেতরে `accounts.txt` (17.9 KB), `banned.txt`, `.env` — repo public হলে ওগুলো সবাই দেখতে পায়। `.gitignore` এখন থেকে বাঁচাবে, **history থেকে মুছবে না** (`git filter-repo`/BFG দরকার — ধ্বংসাত্মক, আপনার অনুমতি ছাড়া করব না)।
2. `node-tls-client` রানটাইমে নিজের binary নামায় → অফলাইন/প্রতিষ্ঠান-ফায়ারওয়ালে অচল; pin করা দরকার।
3. ৪,১৪৪ লাইনের এক ফাইল (`reddit_solver.js`) — refactor ছাড়া প্রতিটা fix risky।

---

## ৯. পরের ধাপ

রুট ফাইল ঠিক কীভাবে ঠিক করব তার ধাপে-ধাপে প্ল্যান: **[`ROOT_FILES_PLAN.md`](./ROOT_FILES_PLAN.md)**
