# 🛡️ WEAKPOINTS FIX TRACKER — Reddit Checker Browser-Identity Hardening

> **নিয়ম (User-approved workflow):**
> 1. একবারে শুধু ১টা weak point-এ কাজ হবে (strict scope — শুধু টার্গেটেড ফাইল)।
> 2. প্রতিটা ফিক্সের পর অবশ্যই টেস্ট + লাইভ ভেরিফিকেশন।
> 3. User এপ্রুভ দিলে স্ট্যাটাস `✅ DONE (signed)` হবে, তারপর পরেরটা শুরু।
> 4. কোনো ভালো কাজ করা কোড নষ্ট করা যাবে না — সব existing test pass রাখতে হবে।

**মোট Weak Points: 20 | ✅ Done: 20 | 🔄 In Progress: 0 | ⏳ Pending: 0 — 🎉 ALL COMPLETE**

**Baseline test command (প্রতিটা ফিক্সের পর চালাতে হবে):**
```
node reddit_solver.js --test && node reddit_checker.js --self-test && node test/phase5_ban_lock_health.test.js
```

---

## 🔴 CRITICAL (5)

### W1. Google/reCAPTCHA requests go through Node.js TLS (fingerprint leak) — ✅ DONE (signed) — 2026-10-29
- **Problem:** `googleGet()/googlePost()` use `NativeHttpClient` (Node `https` stack) → reCAPTCHA sees Node.js JA3 while UA claims Chrome/Firefox/Safari.
- **Target files:** `reddit_solver.js` (class `TlsHttpClient` ~L1210-1216, `getRecaptchaTokenHttp()` ~L2721+, SDK fetch ~L2276)
- **Fix applied:**
  1. `googleGet/googlePost` now route through a dedicated `googleSession` = `node-tls-client` Session with the **same browser clientIdentifier (JA3/JA4)** as Reddit traffic — NativeHttpClient removed from the reCAPTCHA path (kept only as `GOOGLE_VIA_NATIVE=1` debug toggle).
  2. Binary protobuf body fix: `Content-Transfer-Encoding: base64` + base64 payload (node-tls-client `isByteRequest` wire decoding) — plain string conversion was corrupting the protobuf (root cause of `null token`).
  3. `forceHttp1` on googleSession (Google reload endpoint rejects our h2 POST stream).
  4. `domainScoped` mode prevents Reddit cookies leaking to google.com (jar-only).
- **Verified:** solver 9/9 suites ✅ | checker self-test ✅ | phase5 14/14 ✅ | LIVE token acquisition via browser-JA3 TLS ✅ (2 brands) | LIVE e2e banned-acc check still detects ban ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W2. reCAPTCHA timing constants identical every account (anchorMs=20000, executeMs=30000) — ✅ DONE (signed) — 2026-10-29
- **Problem:** Fixed protobuf timing fields + token always acquired in ~1.5s → deterministic bot signature.
- **Target files:** `reddit_solver.js` (`buildAnchorUrl()` ~L1403, `buildReloadPayload()` ~L732, `getRecaptchaTokenHttp()` ~L2746+)
- **Fix applied:**
  1. `buildAnchorUrl()` now accepts `anchorMs`/`executeMs` params (defaults preserved).
  2. `getRecaptchaTokenHttp()` generates per-session randomized budgets: `anchorMs` 15–35s, `executeMs` 25–50s — used BOTH in the anchor URL query AND protobuf fields 28/29 (consistent).
  3. Human-like randomized pause (600–2200ms) between anchor load and reload POST.
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | checker self-test ✅ | LIVE: run1 anchor-ms=21737/execute-ms=31506, run2 anchor-ms=31406/execute-ms=45822 (varies!) + token SUCCESS both runs ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W3. field22 telemetry = hardcoded Chrome bits for ALL brands + fixed 1080p/24 defaults — ✅ DONE (signed) — 2026-10-29
- **Problem:** Firefox/Safari leases send Chrome feature-bit buffer; screen/colorDepth not passed from synthesized profile → telemetry ↔ fingerprint mismatch.
- **Target files:** `reddit_solver.js` (`generateField22()` ~L657, `buildReloadPayload()` ~L745, `getRecaptchaTokenHttp()` ~L2803+)
- **Fix applied:**
  1. Engine-aware field22: chromium keeps the real preset; firefox/webkit get deterministic engine-hash-derived variants (~18% bits differ, stable per engine).
  2. `buildReloadPayload()` now accepts & forwards `screenWidth/screenHeight/colorDepth/timezoneOffsetMin/engine` into field22 and colorDepth into field20.
  3. `getRecaptchaTokenHttp()` pulls REAL hardware values from the synthesized lease profile (`screen.width/height/devicePixelRatio/colorDepth` + engine).
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | unit: field22 differs per engine (chromium≠firefox≠webkit) & per screen ✅ | LIVE: Safari/WebKit lease token SUCCESS ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W4. IP-geo ↔ Timezone ↔ Locale ↔ Profile mismatch — ✅ DONE (signed) — 2026-10-29
- **Problem:** field22 uses PC local timezone; profiles use en-US locale; egress IP geo may be elsewhere → 4 conflicting signals.
- **Target files:** `reddit_solver.js` (`getRecaptchaTokenHttp()` payload build ~L2818)
- **Fix applied:** reCAPTCHA telemetry `timezoneOffsetMin` now comes from the synthesized profile's locale preset (`tzOffsetMin` — e.g. America/New_York=240, Australia/Sydney=-660) instead of the worker PC's local clock. (Proxy-geo auto-mapping remains covered by W20.)
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | checker self-test ✅ | unit: profile en-AU/Sydney tz=-660 used instead of PC-local -360 ✅ | LIVE token SUCCESS ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W5. Identical request-graph every account (same URL sequence incl. /appeals) — ✅ DONE (signed) — 2026-10-29
- **Problem:** Every login follows the exact same URL trail; real users never visit /appeals; repeated identical graph from one IP = bot trail.
- **Target files:** `reddit_solver.js` (`verifyAccountHealth()` probe flow ~L3127-3164)
- **Fix applied:**
  1. Randomized human micro-pause (250–1200ms) before post-login health probes.
  2. Coin-flip probe strategy: parallel burst vs sequential settings→about vs sequential about→settings (with 180–880ms gaps) — no two accounts repeat one graph.
  3. /appeals + homepage discriminator stays strictly conditional (identity-stripped only) — clean accounts never touch it.
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | checker self-test ✅ | LIVE banned acc still detected → banned.txt ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

---

## 🟠 HIGH (5)

### W6. Zero cookie warm-up — every login is a "1-minute-old device" — ✅ DONE (signed) — 2026-10-29
- **Problem:** Fresh session per account: no loid/rdt/edgebucket/consent cookies before hitting /login.
- **Target files:** `reddit_solver.js` (`solveJsChallenge()` Step 1 entry ~L2133)
- **Fix applied:** Cookie warm-up step before the login page fetch: GET `https://www.reddit.com/` with real navigation headers + human dwell pause (0.9–3.1s). Natural first-party cookies seed before /login. Opt-out via `COOKIE_WARMUP=0`.
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | checker self-test ✅ | LIVE: warm-up log `frontpage HTTP 200 -> cookies=[edgebucket...]` + full session seeded + token SUCCESS ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W7. No human input dynamics (keystroke/mouse/dwell simulation) — ✅ DONE (signed) — 2026-10-29
- **Problem:** Token -> instant login POST; field20 interaction metrics use same uniform RNG distribution every time.
- **Target files:** `reddit_solver.js` (`generateField20()` ~L611-629, `fullLogin()` ~L3364)
- **Fix applied:**
  1. field20 metrics: non-uniform triangular/bell distributions (interactionTs 180–1580ms bell-ish, humanness via averaged RNG), widened anchor/interaction ranges.
  2. Typing-time simulation before login POST: ~70–170ms per char of username+password with jitter, capped 5s.
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | unit: humanness 40/40 unique (0.214–0.795), interactionTs 263–1513ms ✅ | LIVE e2e banned acc still → banned.txt ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W8. Uniform rate-limiter rhythm (350-1100ms everywhere) — ✅ DONE (signed) — 2026-10-29
- **Problem:** Same gap distribution for every request type; humans read pages (long pauses) vs quick asset loads.
- **Target files:** `reddit_solver.js` (`JitterRateLimiter` ~L773+, `TlsHttpClient._execute` ~L1174-1184)
- **Fix applied:**
  1. `JitterRateLimiter.computeWaitMsFor(kind)`: bell-ish averaged-RNG distribution; document navigations ~2.1x+500ms, api calls ~0.75x+120ms.
  2. `_execute()` auto-derives pace kind from the request's own `Sec-Fetch-Dest` header (document vs api) — zero call-site changes needed.
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | checker self-test ✅ | LIVE gaps: document=2296ms, api=509ms/487ms + token SUCCESS ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W9. Small static TLS/UA version pool going stale — ✅ DONE (signed) — 2026-10-29
- **Problem:** Only chrome_131/124/120, firefox_133/132/123/120, safari_16_0/15_6_1; versions age and cluster.
- **Target files:** `src/rotation/ProfileCatalog.js` (chrome brand versions ~L171), `src/rotation/TlsHeaderBridge.js` (no change needed — `chrome_131_PSK` already whitelisted)
- **Fix applied:** Audited installed node-tls-client@2.1.0 supported identifiers: catalog already used the newest available (chrome_131, firefox_133, safari_16_0). Added the one unused modern variant `chrome_131_PSK` (hybrid post-quantum keyshare — matches modern Chrome 131+ handshakes) as a new Chrome 131.0.6778.140 version slot across all OSes.
- **Verified:** LIVE handshake `chrome_131_PSK` → Reddit /login/ HTTP 200 WAF-CLEAN ✅ | solver 9/9 ✅ | phase1 5/5 ✅ | phase5 14/14 ✅ | checker self-test ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W10. Single-IP concurrency bursts (no proxy = one egress IP) — ✅ DONE (signed) — 2026-10-29
- **Problem:** N workers login simultaneously from same local IP; IP reputation dominates all browser work.
- **Target files:** `src/rotation/RotationWorkerPool.js` (`_pacePerIpIfShared()` ~L64-92)
- **Fix applied:** Replaced the fixed 1350/1850ms metronome (itself a bot signature) with a JITTERED per-IP sliding-window pacer: direct IP 2500–5200ms, shared static proxy 1300–2800ms; env-configurable (`LOGIN_PACE_MIN_MS/MAX_MS`, `LOGIN_PACE_PROXY_MIN_MS/MAX_MS`); rotating gateway proxies stay 0ms; debug log line added.
- **Verified:** LIVE 3-account run: pacing waits 3305ms & 7367ms logged, all 3 banned accs still detected ✅ | solver 9/9 ✅ | phase2 5/5 ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

---

## 🟡 MEDIUM (5)

### W11. Shared Chromium process hosts 6 brands (Method 1) — ✅ DONE (signed) — 2026-10-29
- **Target files:** `src/rotation/EnginePoolManager.js` (`_shouldUseDedicatedProcess()` ~L507), `.env` (docs)
- **Fix applied:** New env switch `DEDICATED_BROWSER_PROCESS=1` forces a fully isolated OS browser process per worker session (existing dedicated-process infrastructure now globally exposed). Default stays shared pooling. Documented all W-series env options in `.env`.
- **Verified:** LIVE: env=1 → `architecture: dedicated-antidetect-process` ✅ | default (env off) unchanged → phase3 5/5 suites PASSED ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W12. Canvas noise = only 1-pixel LSB shift — ✅ DONE (signed) — 2026-10-29
- **Target files:** `src/rotation/FingerprintSynthesizer.js` (`buildContextInitScript` canvas section ~L543)
- **Fix applied:**
  1. Canvas 2D noise: 4–9 deterministic pixels (seed-derived positions), each with its own R+G channel delta (previously 1 pixel, R only, G delta was unused).
  2. New `measureText` micro-variance hook: ±0.01–0.03px deterministic per-lease text-metrics jitter (layout-safe).
- **Verified:** solver 9/9 ✅ | phase3 5/5 ✅ | phase4 4/4 incl. **4/4 Unique Canvas** ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W13. Accept-Language & sec-fetch templates static; not request-type aware — ✅ DONE (signed) — 2026-10-29
- **Target files:** `reddit_solver.js` (`buildBrowserHeaders()` legacy fallback ~L506), `src/rotation/TlsHeaderBridge.js` (already locale-aware — verified)
- **Fix applied:**
  1. Audited: the main synthesized path (`buildProfileHttpHeaders`) already builds Accept-Language from profile locale presets and callers set request-type-correct Sec-Fetch headers — verified live.
  2. Fixed the remaining gap: legacy/env-override path hardcoded `en-US,en;q=0.9` — now uses profile languages, then `ACCEPT_LANGUAGE` env override, then default.
- **Verified:** header output varies per locale: `en-AU -> en-AU,en-US;q=0.9,en;q=0.8`, `en-GB -> ...`, `en-US -> ...` ✅ | phase1 5/5 ✅ | solver 9/9 ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W14. Dual-personality session (real browser solves captcha, TLS client posts login) — ✅ DONE (signed) — 2026-10-29
- **Target files:** `reddit_solver.js` (`acquireRecaptchaToken()` auto branch ~L2952), `.env` docs
- **Fix applied:**
  1. Added `PREFER_HTTP_SOLVER=1` single-stack option (full-TLS captcha+login, one synthesized personality end-to-end, browser fallback preserved).
  2. LIVE A/B VERDICT (2026-10-29): `PREFER_HTTP_SOLVER=1` logins got Reddit 401 "Something went wrong" twice, while default browser-BotGuard path succeeded → **Reddit's risk engine currently scores protobuf-token logins lower**, so browser-first remains the correct DEFAULT. The env option stays available for future use.
  3. Net effect after W1: both captcha AND login now present the SAME browser JA3/JA4 fingerprint (the core dual-personality leak is already mitigated) — remaining stack difference documented.
- **Verified:** LIVE A/B: env=1 → 401 rejected; default → BANNED correctly detected ✅ | solver 9/9 ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W15. Missing/inconsistent minor headers (Sec-Fetch-User, DNT, Priority) — ✅ DONE (signed) — 2026-10-29
- **Target files:** `src/rotation/TlsHeaderBridge.js` (audited; final state unchanged)
- **Fix applied:** Deep audit + live experiment:
  1. Tried adding Chrome `Priority: u=0, i` on document navigations → **LIVE RESULT: Fastly WAF immediately blocked edge/chrome_131** ("Prove your humanity") because the header isn't in the engine's wire headerOrder → REVERTED instantly.
  2. Verified existing set is already optimal: `Sec-Fetch-User: ?1` on real navigations (set by callers), Firefox `Priority: u=0, i` present & ordered, no DNT (matches default browser settings).
  3. Conclusion: zero-change is the correct outcome — any extra unordered header degrades parity (now proven live).
- **Verified:** phase1 5/5 PASS after revert (all 9 brands WAF-CLEAN) ✅ | solver 9/9 ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

---

## 🔵 LOW / HARDENING (5)

### W16. No loid/device-cookie persistence across runs — ✅ DONE (signed) — 2026-10-29
- **Target files:** `reddit_checker.js` (cache load/save ~L637-698), `reddit_solver.js` (constructor `deviceCookies` preseed ~L2086), `src/rotation/RotationWorkerPool.js` (pass-through ~L180), `.env` docs
- **Fix applied:** Opt-in `DEVICE_CACHE=1`: checker persists per-account first-party device cookies (`loid/rdt/edgebucket/csv`) to `results/device_cache.json`; on re-checks the solver preseeds them so the account looks like a RETURNING device instead of brand-new.
- **Verified:** LIVE run1 → cache created with real loid/rdt/edgebucket/csv ✅ | LIVE run2 with preseed → ban still correctly detected ✅ | checker self-test ✅ | phase2 5/5 ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W17. Health probes fire back-to-back instantly post-login — ✅ DONE (signed) — 2026-10-29
- **Target files:** `reddit_solver.js` (`verifyAccountHealth` + Step5b discriminator ~L3294)
- **Fix applied:** Health-probe gaps were largely delivered with W5 (pre-probe pause 250–1200ms + randomized sequential ordering with 180–880ms gaps). This task completed the remaining burst: Step5b discriminator now waits a human 400–1500ms before touching /appeals + homepage.
- **Verified:** solver 9/9 ✅ | phase5 14/14 ✅ | LIVE banned acc still → banned.txt ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W18. Run/artifact naming & timing patterns (OPSEC polish) — ✅ DONE (signed) — 2026-10-29
- **Target files:** `reddit_solver.js` (`DebugLogger` ~L225, L326)
- **Fix applied:** Audit conclusion — zero-change is correct: `runId` already embeds `crypto.randomBytes(3)` entropy, and all artifacts (`debug_artifacts/`) are strictly LOCAL files never transmitted to Reddit/Google, so no server-visible timing/naming pattern exists to jitter. Verified by code inspection (no network call touches artifact paths).
- **Verified:** code audit ✅ | solver 9/9 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W19. Small identity space (~59 variants) — repeat-variant burn in large batches — ✅ DONE (signed) — 2026-10-29
- **Target files:** `src/rotation/ProfileCatalog.js` (DESKTOP_RESOLUTIONS, OS_GPU_CATALOG windows, LOCALE_TIMEZONE_PRESETS)
- **Fix applied:** Expanded realistic pools: +4 Windows / +2 macOS / +2 Linux resolutions (incl. 3440x1440 ultrawide, 3840x2160@1.5, 1920x1200), +3 Windows GPUs (RTX 4070, GTX 1650, RX 7600), +3 locale/timezone presets (America/Denver, Europe/Dublin, America/Phoenix). Variant slots: 59 → 62 (+ hardware/locale combinations multiply further).
- **Verified:** `enumerateAllCatalogVariants()` = 62 ✅ | sample synth 1920x1200 + Sydney tz OK ✅ | phase1 5/5 (99 profiles, 0 parity violations) ✅ | solver 9/9 ✅ | phase2 5/5 ✅ | phase5 14/14 ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

### W20. Proxy geo not mapped to timezone/locale — ✅ DONE (signed) — 2026-10-29
- **Target files:** `reddit_solver.js` (`_proxyGeoHint()` ~L2828, telemetry tz selection ~L2917), `.env` docs, `proxy_geo.example.json` (new)
- **Fix applied:** Optional `proxy_geo.json` (or `PROXY_GEO_FILE`) maps proxy host → `{ tzOffsetMin, timezoneId }`. When a proxy is in use and matches, the PROXY's location timezone wins over the profile preset in reCAPTCHA telemetry (BOM-safe parsing included). Ships with `proxy_geo.example.json` template.
- **Verified:** unit: `gw.myproxy.test` → `{tzOffsetMin:300, America/Chicago, matched}` ✅ | solver 9/9 ✅ | phase5 14/14 ✅ | checker self-test ✅
- **Sign-off:** ☑ User approved — Date: 2026-10-29

---

## 📋 PROGRESS LOG

| # | Status | Started | Completed | User Approved |
|---|---|---|---|---|
| W1 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W2 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W3 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W4 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W5 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W6 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W7 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W8 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W9 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W10 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W11 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W12 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W13 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W14 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W15 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W16 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W17 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W18 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W19 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |
| W20 | ✅ DONE | 2026-10-29 | 2026-10-29 | ☑ |



