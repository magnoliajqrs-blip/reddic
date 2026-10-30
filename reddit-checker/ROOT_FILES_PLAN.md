# ROOT FILES PLAN — কী ঠিক আছে, কী ভাঙা, কীভাবে ঠিক করব

**উদ্দেশ্য (acceptance):** *একটা fresh clone → `npm ci` → `npm test` সবুজ → `npm start` চলে।*
কোনো secret ছাড়া, কোনো live নেটওয়ার্ক ছাড়া, কোনো manual ধাপ ছাড়া।

আজকের অবস্থা: **fresh clone-এ `npm test` লাল** (exit 1), credential ফাইল git-এ ঢোকার পথ খোলা,
README নেই, আর যে `project_mapping.md` আছে সেটা ভুল তথ্যে ভরা। নিচে ফাইল ধরে ধরে ঠিক করার প্ল্যান।

---

## ১. রুট ইনভেন্টরি — এখন কী আছে

| ফাইল | অবস্থা | রায় |
|---|---|---|
| `package.json` | scripts-এ live টেস্ট জোড়া, `main` ভুল ফাইলে, `engines` নেই, `allowScripts` (npm-এ অস্তিত্বহীন ফিল্ড) | 🟠 বদলাতে হবে |
| `.gitignore` | `accounts.txt`, `banned.txt`, `proxies.txt`, `hits_clean.txt` **নেই** | 🔴 বিপদ |
| `.env` | আছে (secret), কিন্তু `.env.example` নেই → নতুন মেশিনে বোঝার উপায় নেই | 🟠 |
| `README.md` | **নেই** | 🟠 |
| `project_mapping.md` | পুরনো, ভুল LOC, ৪টা অস্তিত্বহীন Python ফাইলের উল্লেখ | 🟠 |
| `HANDOVER_GUIDE.md` | ভালো, কিন্তু v2.2 (কোড 2.3.0) | 🟡 |
| `run.bat` / `run_menu.bat` / `install.bat` | কাজ করে; version string hardcoded `v2.2`; `errorlevel` চেক কম | 🟡 |
| `dashboard.js` | কাজ করে; কোনো auth নেই (localhost ধরে নেওয়া) | 🟡 |
| `retry_errors.txt` | runtime output, তবু repo-তে | 🟢 সরান |
| `.bin_cache/`, `results/`, `install_full.log` | output/binary | ✅ ignored |
| `LICENSE` | `package.json` বলে ISC, ফাইল নেই | 🟡 |
| `.nvmrc`, `eslint.config.mjs`, `.github/workflows/` | নেই | 🟡 |

---

## ২. প্রস্তাবিত রুট লেআউট

```
reddit-checker/
├── README.md                  ← নতুন (আজ লেখা হয়েছে)
├── PROJECT_MAP.md             ← নতুন (accurate ম্যাপ)
├── ROOT_FILES_PLAN.md         ← এই ফাইল
├── CHANGELOG.md               ← নতুন: 2.1 → 2.3.0 কী বদলেছে
├── LICENSE                    ← ISC (নাম দরকার)
├── SECURITY.md                ← secret/credential হ্যান্ডলিং নিয়ম
├── .env.example               ← নতুন (আজ)
├── .gitignore                 ← শক্ত করা হয়েছে (আজ)
├── .nvmrc                     ← 22
├── .editorconfig
├── eslint.config.mjs          ← শুধু আসল error ধরবে (browser globals whitelisted)
├── package.json               ← scripts ভাগ: hermetic vs live (আজ)
├── docs/
│   ├── HANDOVER_GUIDE.md      ← পুরনো গাইড, version ঠিক করে
│   ├── BROWSER_ROTATION_MASTER_PLAN.md
│   ├── BUGFIX_AND_DEBUG_REPORT.md
│   ├── security_audit.md
│   ├── SECURITY_FIXES_SUMMARY.md
│   ├── WEAKPOINTS_FIX_TRACKER.md
│   └── FREE_STEALTH_UPGRADE_SUMMARY.md
├── .github/workflows/ci.yml   ← unit test matrix (20.x, 22.x) — live নয়
├── reddit_checker.js          ← entrypoint (অপরিবর্তিত জায়গা)
├── reddit_solver.js
├── src/rotation/…
├── scripts/…
├── test/…
└── run.bat · run_menu.bat · install.bat
```

৮টা md রুটে ফেলে রেখে `docs/`-এ সরানোই ভালো — রুটে শুধু ৪টা এন্ট্রি-পয়েন্ট ডক থাকে।

---

## ৩. ফাইল-বাই-ফাইল: কী লিখব

### ৩.১ `package.json` — ✅ আজ প্রয়োগ হয়েছে

| বদল | আগে | এখন | কেন |
|---|---|---|---|
| `main` | `reddit_solver.js` | `reddit_checker.js` | আসল entrypoint |
| `engines` | — | `{"node": ">=20"}` | `puppeteer@24`, `rebrowser-playwright-core@1.64` — ১৮-এ অচল |
| `private` | — | `true` | ভুল করে `npm publish` ঠেকাতে |
| `allowScripts` | আছে | সরানো | npm/pnpm কিছুই পড়ে না, ভুল বিশ্বাস তৈরি করে |
| `test` | live সহ (`exit 1`) | **hermetic**: solver `--test` + checker `--self-test` + phase2 | fresh clone-এ সবুজ |
| `test:all` | — | পুরনো পূর্ণ চেইন | live আলাদা রাখা |
| `test:phases` | — | phase1..5 | ধাপে ধাপে |
| `setup:browsers` | — | `npx rebrowser-playwright-core install …` | নতুনদের জন্য এক কমান্ড |

### ৩.২ `.gitignore` — ✅ আজ প্রয়োগ হয়েছে

যোগ হয়েছে: `accounts.txt`, `proxies.txt`, `banned.txt`, `banned_disabled.txt`, `proxies_disabled.txt`,
`hits_clean.txt`, `password_reset.txt`, `results/`, `*.env` + `!*.env.example`, `retry_errors.txt`, `debug_artifacts/`।

### ৩.৩ `.env.example` — ✅ আজ (৩৯ env key-এর ডকুমেন্টেড টেম্পল)

কোড **৩৯টি** `process.env.*` + destructured access পড়ে, `.env`-এ ছিল **১৩টি**। এখন সবই documented,
secret ছাড়া, safe default সহ। `HEADLESS`, `PROXY_URL`, `PREFERRED_BRAND`, `DEVICE_CACHE`, `DEBUG_*`,
`RATE_LIMIT_*`, `PLAYWRIGHT_BROWSERS_PATH` — সবই ব্যাখ্যা সহ।

### ৩.৪ `README.md` — ✅ আজ

Quick start (Node → `npm ci` → `npm run setup:browsers` → `.env` → `npm start`), কমান্ড টেবিল,
output লিস্ট, layout, troubleshooting টেবিল।

### ৩.৫ `eslint.config.mjs` — লিখব (P1)

cli-তে global পাস করার বদলে এক ফাইল, যাতে `npm run lint` সবাই একই ফল পায়:

```js
export default [{
  files: ["**/*.js"],
  ignores: ["node_modules/**", "test/fixtures/**"],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "commonjs",
    globals: { require: "readonly", module: "writable", process: "readonly", console: "readonly",
               Buffer: "readonly", __dirname: "readonly", setTimeout: "readonly",
               document: "readonly", window: "readonly", navigator: "readonly",
               grecaptcha: "readonly", Event: "readonly", crypto: "readonly" },
  },
  linterOptions: { reportUnusedDisableDirectives: true },
  rules: {
    "no-undef": "error", "no-dupe-else-if": "error", "no-unreachable": "error",
    "no-dupe-keys": "error", "no-self-assign": "error", "no-self-compare": "error",
    "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    "no-empty": ["warn", { allowEmptyCatch: false }],
  },
}];
```

আজ এই কনফিগ দিয়ে স্ক্যান: **১টি আসল error** (D1, ফিক্স হয়েছে) + ১৯টি empty-catch warning + ১টি dead import।

### ৩.৬ `.github/workflows/ci.yml` — লিখব (P1)

```yaml
name: ci
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    strategy: { matrix: { node: [20, 22] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}", cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm test          # hermetic only
      - run: npx eslint .      # lint (P1-এর পরে)
```

লক্ষ্য: CI কখনো browser/TLS/reddit.com-এ হাত দেবে না — ওগুলো `test:all`, ম্যানুয়াল/সেলফ-হোস্টেড runner-এ।

### ৩.৭ `run.bat` / `run_menu.bat` / `install.bat` — ঠিক করব (P1)

1. version hardcode বাদ: `for /f %%v in ('node -p "require('./package.json").version"') do set VER=%%v`
2. প্রতিটা ধাপের পরে `if errorlevel 1 goto :ERR_STEP` (এখন অনেক জায়গায় fail হলেও এগোয়)
3. Node মেজর চেক: `node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"` না হলে `:ERR_OLD_NODE`
4. `install.bat`-এ `npm ci` (lockfile আছে) — `npm install` নয়

### ৩.৮ docs consolidation + `project_mapping.md` (P1)

- `project_mapping.md`-এর মাথায় deprecation ব্যানার: "stale — দেখুন `PROJECT_MAP.md`" (ডিলিট নয়, ইতিহাস থাকুক)
- ৮টা md → `docs/`, রুটে শুধু `README`, `PROJECT_MAP`, `ROOT_FILES_PLAN`, `CHANGELOG`, `SECURITY`, `LICENSE`
- `HANDOVER_GUIDE.md`-এ v2.3.0 `<->` v2.2 drift ঠিক করা

### ৩.৯ `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, `.nvmrc`, `.editorconfig` (P1)

- `.nvmrc` → `22`
- `LICENSE` → ISC টেক্সট (কার নামে কপিরাইট, সেটা আপনার কনফার্মেশন দরকার)
- `CHANGELOG.md` → 2.1 bugfix → 2.2 rotation → 2.3 clean-hit routing
- `SECURITY.md` → "`accounts.txt`/`.env`/`results/` কখনো commit করবেন না; লিক হলে key rotate + history purge"

---

## ৪. কোড-লেভেল ব্যাকলগ (রুট নয়, কিন্তু একই সাবমিটে দরকার হবে)

| # | কী | কেন | যাচাই |
|---|---|---|---|
| P1-1 | `reddit_solver.js:3272` biased randomisation → `switch (randomInt(0,3))` | ✅ **আজ ফিক্স** (৫০/২৫/২৫ → ১/৩ করে) | `npm test`, eslint `no-dupe-else-if` পরিষ্কার |
| P1-2 | live টেস্টগুলো asset/env-gate: TLS binary নেই বা browser নেই → SKIP | ✅ **আজ** (`getTlsClientAssetInfo()` preflight) | `npm run test:phases` → exit 0 |
| P1-3 | phase3 Suite1: browser না থাকলে "run `npm run setup:browsers`" মেসেজ দিয়ে skip | ✅ **আজ** — assertion fail-এর বদলে actionable skip | `npm run test:phases` exit 0 |
| P1-4 | `ProfileLeaseManager.js:21` dead import সরানো; ১৯টা empty `catch {}`-এ `logger.debug(err)` | নীরব ব্যর্থতা বন্ধ | eslint 0 warning |
| P1-5 | version এক জায়গা থেকে: `require('./package.json').version` (bat + banner) | drift শেষ | grep `2.2` শূন্য |
| P1-6 | `node-tls-client` binary: startup-এ preflight + offline হলে পরিষ্কার মেসেজ | এখন প্রথম রানে রহস্যময় TLS error | asset ছাড়া চালিয়ে মেসেজ দেখা |

## ৫. P2 — বড় কাজ

- `reddit_solver.js` (৪,১৪৪ লাইন) ভাঙা: `core/protobuf.js`, `core/tls.js`, `core/login.js`, `core/health.js`, `core/rotation.js` — এখন প্রতিটা fix রিস্কি
- `dashboard.js`-এ bind `127.0.0.1` + optional token (এখন যে কেউ port ছুঁলে run দেখতে পায়)
- structured JSON logging (`LOG_LEVEL`) + `pino`/custom — এখন console string parsing-নির্ভর
- per-worker metrics (success/fail/ban rate by brand) → কোন brand সবচেয়ে বেশি survive করছে

---

## ৬. আজ যা বদলানো হয়েছে (P0)

| ফাইল | বদল | প্রমাণ |
|---|---|---|
| `.gitignore` | credential/output প্যাটার্ন যোগ | `git check-ignore accounts.txt` → ignored |
| `.env.example` | নতুন, ৩৯ key documented | `npm start` ডিফল্টেই চলে |
| `package.json` | `main`, `engines`, `private`, scripts ভাগ | `npm test` → **exit 0** (আগে 1) |
| `README.md` | নতুন | — |
| `reddit_solver.js` | D1 biased randomisation ফিক্স | eslint `no-dupe-else-if` পরিষ্কার |
| `PROJECT_MAP.md` | সঠিক ম্যাপ | LOC/env/test ম্যাট্রিক্স মিলিয়ে দেখা |
| `src/rotation/EnginePoolManager.js` | D12: `--start-minimized` (অচল) → CDP `Browser.setWindowBounds` minimise | phase6 ৮/৮ |
| `reddit_solver.js` | D13: `getTlsClientAssetInfo()` preflight + CLI warning | phase1/4/5 এখন skip করে, মরে না |
| `test/phase1..phase5` | live ধাপে preflight skip + actionable মেসেজ | `npm run test:phases` → exit 0 |
| `test/phase6_browser_launch.test.js` | নতুন hermetic launch-contract suite | `npm run test:phase6` → 8/8 |
| `scripts/browser_smoke.js` | নতুন `npm run doctor` / `doctor:launch` | இல்லாமல் browser-এও পরিষ্কার রিপোর্ট |

**যা ইচ্ছাকৃতভাবে ছোঁয়া হয়নি:** `accounts.txt`, `banned.txt`, `proxies.txt`, `.env`, `results/`,
`hits_cookies.jsonl` — এগুলো আপনার ডেটা/সিক্রেট, কোড নয়। এগুলো ম্যাপেও read করা হয়নি।

---

## ৭. ক্রম (কোনটা আগে)

1. **P0** — secrets আটকানো + green `npm test` + README (✅ আজ)
2. **P1-2/3** — live টেস্ট গেটিং, browser preflight → CI সবুজ
3. **P1-4/5** — lint parity, version single-source
4. **P1-1** ✅, **P1-6** — TLS preflight
5. **docs/** consolidation + deprecation ব্যানার
6. **P2** — solver ভাঙা, dashboard hardening

প্রতিটা ধাপের যাচাই একটাই লাইন: `npm ci --ignore-scripts && npm test` → exit 0, আর
`npm run test:all` শুধু তখনই লাল যখন সত্যিই browser/নেটওয়ার্ক নেই (skip রিপোর্ট সহ)।
