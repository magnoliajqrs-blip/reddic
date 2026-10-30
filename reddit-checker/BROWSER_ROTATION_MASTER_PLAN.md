# Hybrid Browser Rotation & Multi-Worker Anti-Detect Master Plan

## ১. মূল লক্ষ্য (Core Objective)

এমন একটি **Unified Hybrid Browser Rotation System** তৈরি করা যেখানে:
1. **Method 1 (Single-Engine Multi-Context Pool):** ১টি সিঙ্গেল Chromium/Patched-Chromium ইঞ্জিন প্রসেসের ভেতরে হালকা `BrowserContext` ব্যবহার করে **Chrome, Edge, Opera, Brave, Vivaldi** ইত্যাদি ব্রাউজার খুব কম RAM-এ রোটেট করা যাবে।
2. **Method 2 (Multi-Engine Native Pool):** একই কন্ট্রোলারের অধীনে আসল **Chromium**, আসল **Mozilla Firefox / Camoufox (Gecko)**, এবং আসল **Safari (WebKit)** ইঞ্জিন একসাথে পুল (Pool) আকারে চলবে—যাতে ইঞ্জিন-লেভেল মিসম্যাচ (যেমন Chrome V8 দিয়ে ফেক Firefox সাজানো) কখনো না ঘটে।
3. **Zero-Collision Worker Guarantee:** একাধিক Worker/Thread একসাথে চলার সময় **কোনো দুটি ওয়ার্কার কখনোই একই ব্রাউজার প্রোফাইল বা একই ফিঙ্গারপ্রিন্ট চালাবে না**।
4. **1:1 Network & TLS Synchronization:** প্রতিটি ওয়ার্কার যে ব্রাউজারটি পাবে, তার `TlsHttpClient` (`node-tls-client`) ও ঠিক সেই ব্রাউজারের আসল TLS/JA3 ফিঙ্গারপ্রিন্ট এবং HTTP/2 হেডার রুলস ব্যবহার করবে।

---

## ২. মাস্টার আর্কিটেকচার ডায়াগ্রাম (System Architecture)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CENTRAL ROTATION COORDINATOR (Singleton)                 │
│                                                                              │
│  ┌─────────────────────────┐    ┌─────────────────────────────────────────┐  │
│  │   ProfileCatalog &      │    │         ProfileLeaseManager             │  │
│  │  Fingerprint Generator  │───▶│  - Mutex Lock (Zero Race Condition)     │  │
│  │  (Real OS+GPU+Browser)  │    │  - Active Brand Lock Set                │  │
│  └─────────────────────────┘    │  - Burned Seed LRU History (No Repeat)  │  │
│                                 └───────────────────┬─────────────────────┘  │
└─────────────────────────────────────────────────────┼────────────────────────┘
                                                      │
              ┌───────────────────────────────────────┴──────────────────────┐
              ▼                                                              ▼
┌─────────────────────────────────────────┐    ┌─────────────────────────────────────────┐
│   METHOD 1: Single-Engine Context Pool  │    │    METHOD 2: Multi-Engine Native Pool   │
│   (High Speed, ~20-30MB RAM / Worker)   │    │    (True Engine Diversity: 3 Engines)   │
│                                         │    │                                         │
│  [1x Persistent Patched Chromium]       │    │  [Daemon A: fingerprint-chromium]       │
│    ├── Context: Google Chrome 131       │    │  [Daemon B: Camoufox / Gecko Firefox]   │
│    ├── Context: Microsoft Edge 131      │    │  [Daemon C: Playwright WebKit (Safari)] │
│    ├── Context: Opera 114               │    │                                         │
│    ├── Context: Brave 131               │    │  Each worker gets an isolated context   │
│    └── Context: Vivaldi / Chrome 124    │    │  from a DIFFERENT engine family!        │
└────────────────────┬────────────────────┘    └────────────────────┬────────────────────┘
                     └──────────────────────┬───────────────────────┘
                                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                 1:1 TLS & HEADER PARITY BRIDGE (TlsHttpClient)               │
│  - Chrome/Edge/Brave -> TLS: chrome_131 / chrome_124 + Branded sec-ch-ua     │
│  - Opera             -> TLS: opera_91 / chrome_131   + Opera sec-ch-ua       │
│  - Firefox/Camoufox  -> TLS: firefox_133 / 132       + NO sec-ch-ua (!)      │
│  - Safari (WebKit)   -> TLS: safari_16_0             + NO sec-ch-ua, no zstd │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## ৩. ওপেন-সোর্স অ্যান্টি-ডিটেক্ট ব্রাউজার ও টুলস স্ট্যাক (100% Free & Open-Source)

একসাথে সব ধরনের ওপেন-সোর্স অ্যান্টি-ডিটেক্ট সক্ষমতা পাওয়ার জন্য নিচের ৫টি ফ্রি ওপেন-সোর্স প্রজেক্টকে একীভূত করা হবে:

| লেয়ার | ওপেন-সোর্স টুল / ইঞ্জিন | কাজ ও কেন প্রয়োজন |
|---|---|---|
| **Unified Automation** | **`playwright-core`** + **`rebrowser-playwright`** | একই API দিয়ে Chromium, Firefox (Gecko), এবং WebKit (Safari) ৩টি ইঞ্জিন নিয়ন্ত্রণ করে এবং CDP `Runtime.enable` লিক বন্ধ করে। |
| **Chromium Anti-Detect (C++)** | **`fingerprint-chromium`** (`adryfish/fingerprint-chromium`) | C++ সোর্স লেভেলে প্যাচ করা ফ্রি অ্যান্টি-ডিটেক্ট ব্রাউজার। JS ওভাররাইড ছাড়াই `--fingerprint=<seed>` ও `--fingerprint-brand=Chrome\|Edge\|Opera\|Brave\|Vivaldi` সাপোর্ট করে। |
| **Firefox Anti-Detect (C++)** | **`Camoufox`** (`daijro/camoufox`) | Mozilla Firefox ইঞ্জিনের C++ লেভেলে প্যাচ করা ওপেন-সোর্স অ্যান্টি-ডিটেক্ট ব্রাউজার। Playwright-এর Firefox প্রোটোকল দিয়ে সরাসরি চলে। |
| **Safari / WebKit Engine** | **Playwright Native `webkit`** | আসল WebKit ইঞ্জিন চালায় (macOS/Safari হ্যান্ডশেক ও আচরণের জন্য)। |
| **Statistical Fingerprint** | **Apify `fingerprint-suite`** (`fingerprint-generator` + `fingerprint-injector`) | বাস্তব দুনিয়ার হার্ডওয়্যার পরিসংখ্যান মেনে OS + Screen + WebGL GPU + Audio + Font + Navigator প্রোফাইল তৈরি ও ইনজেক্ট করে। |

> **Graceful Degradation (অটো-ফলব্যাক সুবিধা):** যদি কোনো মেশিনে কাস্টম `fingerprint-chromium` বা `Camoufox` বাইনারি ইনস্টল করা না থাকে, সিস্টেম স্বয়ংক্রিয়ভাবে স্ট্যান্ডার্ড Playwright (`chromium`, `firefox`, `webkit`) + `rebrowser` + `fingerprint-injector` ব্যবহার করবে। আর বাইনারি পাথ (`.env`-এ) দেওয়া থাকলে সরাসরি C++ অ্যান্টি-ডিটেক্ট বাইনারি ব্যবহার করবে!

---

## ৪. কীভাবে ২টি মেথড একসাথে চলবে? (Dual-Pool Execution Logic)

বারবার পুরো ব্রাউজার চালু বা বন্ধ (`launch()` / `close()`) করলে CPU ১০০% হয়ে যায় এবং অনেক সময় নষ্ট হয়। তাই **Persistent Engine Pool + Ephemeral Context** পদ্ধতি ব্যবহার করা হবে:

### ধাপ ১: স্টার্টআপে মাত্র ১ বার ইঞ্জিন সার্ভার চালু (Warm Engine Pool)
প্রোগ্রাম শুরু হওয়ার সময় `EnginePoolManager` ব্যাকগ্রাউন্ডে ইঞ্জিনগুলো রেডি করবে:
* **Engine Pool #1 (Chromium Shared Host — Method 1):** ১টি সিঙ্গেল Chromium / `fingerprint-chromium` প্রসেস চালু থাকবে। এর ভেতর থেকে একসাথে ১০–৩০টি আলাদা `BrowserContext` খোলা যাবে (Chrome, Edge, Opera, Brave, Vivaldi প্রোফাইলের জন্য)।
* **Engine Pool #2 (Gecko Host — Method 2):** ১টি Firefox / `Camoufox` প্রসেস চালু থাকবে (Firefox, LibreWolf, Waterfox স্টাইল প্রোফাইলের জন্য)।
* **Engine Pool #3 (WebKit Host — Method 2):** ১টি WebKit প্রসেস চালু থাকবে (Safari Desktop / iPadOS স্টাইল প্রোফাইলের জন্য)।

### ধাপ ২: প্রতি রিকোয়েস্টে `BrowserContext` তৈরি ও ধ্বংস (১৫–৩০ MB RAM)
* যখন কোনো Worker কাজ শুরু করবে, সে নতুন ব্রাউজার লঞ্চ করবে না; বরং তার বরাদ্দ পাওয়া ইঞ্জিনের ভেতর একটি **`newContext({ userAgent, viewport, locale, timezoneId, deviceScaleFactor, colorScheme, proxy })`** তৈরি করবে।
* প্রতিটি `BrowserContext` সম্পূর্ণ আলাদা ইনকগনিটো ব্রাউজারের মতো কাজ করে—কুকি, ক্যাশ, WebRTC, স্টোরেজ, প্রক্সি কোনোটির সাথে কোনোটির সংঘর্ষ হয় না।
* রিকোয়েস্ট শেষ হওয়া মাত্র `await context.close()` কল হবে, ফলে মেমোরি সাথে সাথে ফ্রি হয়ে যাবে কিন্তু মূল ইঞ্জিন পরের ওয়ার্কারের জন্য গরম (warm) থাকবে।

### মেমোরি ও রিসোর্স হিসাব (১০টি একযোগে চলা Worker-এর তুলনা)
* **সনাতন পদ্ধতি (১০ বার `puppeteer.launch()`):** ১০ × ৪০০ MB = **~৪.০ GB RAM** + প্রচণ্ড CPU স্পাইক।
* **আমাদের Hybrid Dual-Pool পদ্ধতি:** ৩টি শেয়ারড ইঞ্জিন (~৬৫০ MB) + ১০টি আইসোলেটেড কনটেক্সট (১০ × ২৫ MB = ২৫০ MB) = **মাত্র ~৯০০ MB RAM!**

---

## ৫. থ্রেড-সেফ ইউনিকনেস লজিক (`ProfileLeaseManager`)

*"প্রতিটা থ্রেড বা ওয়ার্কার যখন ব্রাউজার রান করবে তখন যেন কোনো থ্রেড একই ব্রাউজার রান না করে"* — এটি নিশ্চিত করার জন্য ৪-স্তরের লকিং অ্যালগরিদম থাকবে:

### ৫.১. Async Mutex Lock (Race Condition প্রতিরোধ)
যদি ১০টি ওয়ার্কার একই মিলিসেকেন্ডে `leaseManager.acquire(workerId)` কল করে, একটি `AsyncMutex` কিউ সেগুলোকে একের পর এক (atomic ভাবে) প্রসেস করবে। ফলে দুটি ওয়ার্কারের হাতে একই প্রোফাইল যাওয়ার সম্ভাবনা **শূন্য (0%)**।

### ৫.২. Priority Anti-Collision Selection (ব্র্যান্ড ও ইঞ্জিন রোটেশন রুল)
ম্যানেজার প্রথমে দেখবে বর্তমানে অন্য ওয়ার্কাররা কোন কোন `browserBrand` ও `engineType` চালাচ্ছে (`activeBrands` সেট):

1. **Rule 1 (Strict Brand Separation):**
   * ধরো আমাদের ক্যাটালগে ৭টি ব্র্যান্ড ফ্যামিলি আছে: `chrome`, `edge`, `firefox`, `opera`, `safari`, `brave`, `vivaldi`।
   * Worker #1 পেল `chrome` (Engine: Chromium) $\rightarrow$ লক হলো `chrome`।
   * Worker #2 বাধ্যতামূলকভাবে বাকি ৬টি থেকে পাবে, যেমন `firefox` (Engine: Gecko) $\rightarrow$ লক হলো `firefox`।
   * Worker #3 পাবে বাকি ৫টি থেকে, যেমন `edge` $\rightarrow$ লক হলো `edge`।
   * Worker #4 পাবে `safari` (Engine: WebKit) $\rightarrow$ লক হলো `safari`।
   * Worker #5 পাবে `opera` $\rightarrow$ লক হলো `opera`।
   * এভাবে ৭টি সমসাময়িক ওয়ার্কার **৭টি সম্পূর্ণ আলাদা ব্রাউজার ব্র্যান্ড** চালাবে!
2. **Rule 2 (Sub-Variant Separation — যদি ওয়ার্কার ৭টির বেশি হয়):**
   * যদি ধরো ১৫টি ওয়ার্কার একসাথে চলে, তবে ৮ম ওয়ার্কার এমন ভ্যারিয়েন্ট পাবে যার `(Brand + Version + OS + Screen + WebGL Renderer)` আগের ৭টির কোনোটির সাথেই মেলে না (যেমন Worker #1 যদি চালায় `Chrome 131 on Windows 11 + NVIDIA RTX 3060 + 1920x1080`, তবে Worker #8 পাবে `Chrome 124 on macOS Sonoma + Apple M2 + 1440x900`)।
3. **Rule 3 (Ephemeral Cryptographic Fingerprint Seed):**
   * প্রতিটি রিকোয়েস্টের জন্য নতুন `crypto.randomBytes(8)` সিড তৈরি হবে। ক্যানভাস নয়েজ, অডিও নয়েজ, ক্লায়েন্ট-রেকটস অফসেট, এবং স্ক্রিন/টাইমজোন জিটার প্রতিবার নতুন হবে।
4. **Rule 4 (Burned Signature History / Cooldown):**
   * একটি ওয়ার্কার কাজ শেষ করে `release(leaseId)` করার পরও ওই নির্দিষ্ট ফিঙ্গারপ্রিন্ট সিগনেচার একটি `LRU Set` (যেমন শেষ ৫০০টি ব্যবহৃত সিগনেচার)-এ ব্লকলিস্ট হয়ে থাকবে, যাতে পরের রিকোয়েস্টেও কখনো হুবহু আগের ব্রাউজার রিপিট না হয়।

---

## ৬. নেটওয়ার্ক ও TLS সিনক্রোনাইজেশন ম্যাট্রিক্স (সবচেয়ে গুরুত্বপূর্ণ অংশ!)

শুধু ব্রাউজার রোটেট করলেই হবে না—তোমার প্রজেক্টে Step 1 ও Step 4 যায় `TlsHttpClient` (`node-tls-client`) দিয়ে। যদি ব্রাউজার হয় **Firefox** কিন্তু `TlsHttpClient` পাঠায় **Chrome-এর `sec-ch-ua` হেডার বা Chrome JA3**, তাহলে অ্যান্টি-বট সাথে সাথে ধরে ফেলবে!

তাই `node-tls-client@2.1.0`-এর আসল সাপোর্টেড প্রোফাইলগুলোর সাথে নিচের **Strict 1:1 Mapping Table** মেনে চলা হবে:

| Browser Brand | Browser Engine | `node-tls-client` Identifier | `sec-ch-ua` Header Rule | `Accept-Encoding` (HTTP/2) | OS Platforms |
|---|---|---|---|---|---|
| **Google Chrome** | Chromium | `chrome_131` / `chrome_124` / `chrome_120` | `"Google Chrome";v="131", "Chromium";v="131"...` | `gzip, deflate, br, zstd` | Windows, macOS, Linux |
| **Microsoft Edge** | Chromium | `chrome_131` | `"Microsoft Edge";v="131", "Chromium";v="131"...` | `gzip, deflate, br, zstd` | Windows, macOS |
| **Opera** | Chromium | `opera_91` / `chrome_131` | `"Opera";v="114", "Chromium";v="131"...` | `gzip, deflate, br, zstd` | Windows, macOS |
| **Brave** | Chromium | `chrome_131` | `"Brave";v="131", "Chromium";v="131"...` (+ ` navigator.brave` mock) | `gzip, deflate, br, zstd` | Windows, macOS, Linux |
| **Vivaldi** | Chromium | `chrome_131` / `chrome_124` | `"Chromium";v="131", "Not_A Brand";v="24"` | `gzip, deflate, br, zstd` | Windows, macOS, Linux |
| **Mozilla Firefox / Camoufox** | **Gecko** | `firefox_133` / `firefox_132` / `firefox_123` | **MUST OMIT!** (Firefox কখনো `sec-ch-ua*` পাঠায় না!) | `gzip, deflate, br, zstd` | Windows, macOS, Linux |
| **Apple Safari** | **WebKit** | `safari_16_0` / `safari_15_6_1` | **MUST OMIT!** (Safari কখনো `sec-ch-ua*` পাঠায় না!) | `gzip, deflate, br` (**no zstd**) | macOS |

### গুরুত্বপূর্ণ নেটওয়ার্ক নিয়মসমূহ (Anti-Leak Guardrails):
1. **HTTP/2 Header Rule:** কোনো HTTP/2 রিকোয়েস্টে কখনোই `Connection: keep-alive` বা ম্যানুয়াল `Content-Length` হেডার যাবে না (RFC 9113 নিয়ম)।
2. **Header Order & Accept Header:**
   * Chromium পাঠায়: `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8`
   * Firefox পাঠায়: `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` (+ `Priority: u=0, i`)
   * Safari পাঠায়: `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` (AVIF ছাড়া পুরনো ভার্সনে)
3. **Cookie & Session Hand-off:** প্রতিটি ওয়ার্কারের `TlsHttpClient` এবং তার বরাদ্দকৃত `BrowserContext` শুধুমাত্র নিজেদের মধ্যে কুকি আদান-প্রদান করবে; এক ওয়ার্কারের কুকি অন্য ওয়ার্কারে কখনো মিশবে না।

---

## ৭. ওয়ার্কার ও থ্রেড আর্কিটেকচার (Worker Execution Model)

Node.js-এ মাল্টি-ওয়ার্কার চালানোর দুটি অপশন থাকবে, যা `.env` থেকে কন্ট্রোল করা যাবে:

### মোড ১: Async Concurrent Workers + Shared Engine Pool (Recommended — সবচেয়ে হালকা ও দ্রুত)
* যেহেতু প্রকৃত ব্রাউজার রেন্ডারিং ও নেটওয়ার্ক কাজ আলাদা OS প্রসেসে (Chromium/Firefox/WebKit বাইনারি এবং `node-tls-client`-এর নিজস্ব Piscina ওয়ার্কার থ্রেড পুলে) চলে, তাই মূল অর্কেস্ট্রেশন একটি `WorkerPool(concurrency = N)` কিউ দিয়ে চালানো সবচেয়ে কার্যকর।
* এখানে মেমোরি কপি হয় না এবং `ProfileLeaseManager` সরাসরি ইন-মেমোরি লক রাখে।

### মোড ২: Node.js `worker_threads` + IPC Lease Coordinator (CPU-heavy কাজের জন্য)
* যদি প্রতিটি টাস্কে ভারী CPU প্রসেসিং থাকে:
  * **Main Thread:** `EnginePoolManager` (WebSocket `wsEndpoint` চালু রাখে) এবং `ProfileLeaseManager` ধরে রাখে।
  * **Worker Threads (`worker_1` ... `worker_N`):** মেইন থ্রেডকে IPC মেসেজ পাঠায় `ACQUIRE_LEASE` $\rightarrow$ মেইন থ্রেড একটি ইউনিক প্রোফাইল ও ইঞ্জিনের `wsEndpoint` দেয় $\rightarrow$ ওয়ার্কার থ্রেড `playwright.chromium.connect(wsEndpoint)` দিয়ে যুক্ত হয়ে নিজের আলাদা `BrowserContext` তৈরি করে কাজ শেষ করে `RELEASE_LEASE` পাঠায়!
  * এতে একাধিক OS থ্রেড চললেও **ব্রাউজার ইঞ্জিন প্রসেস মাত্র ১ সেটই থাকে** এবং কখনো ডুপ্লিকেট ব্রাউজার চলে না!

---

## ৮. প্রজেক্ট ফাইল ও মডিউল স্ট্রাকচার (Modular Blueprint)

বর্তমান `reddit_solver.js`-এর সব ফিচার অক্ষুণ্ণ রেখে প্রজেক্টটিকে নিচের মতো পরিষ্কার মডিউলার কাঠামোতে সাজানো হবে:

```text
reddit_checker_handover/
├── package.json
├── .env                              # ইঞ্জিন পাথ, রোটেশন মোড, কনকারেন্সি কনফিগ
├── reddit_solver.js                  # মেইন CLI ও ব্যাকওয়ার্ড-কম্প্যাটিবল এন্ট্রিপয়েন্ট
├── src/
│   ├── rotation/
│   │   ├── ProfileCatalog.js         # Chrome, Edge, Opera, Brave, Vivaldi, Firefox, Safari ম্যাট্রিক্স
│   │   ├── FingerprintSynthesizer.js # fingerprint-suite + কাস্টম WebGL/Audio/Canvas/Navigator ইনজেক্টর
│   │   ├── ProfileLeaseManager.js    # AsyncMutex লক, Active Brand সেট, LRU Burn History
│   │   ├── EnginePoolManager.js      # Method 1 (Single Chromium) + Method 2 (Chromium+Firefox+WebKit) পুল
│   │   └── TlsHeaderBridge.js        # ব্রাউজার প্রোফাইল অনুযায়ী নিখুঁত node-tls-client কনফিগ ও হেডার জেনারেটর
│   ├── workers/
│   │   └── RotationWorkerPool.js     # N সংখ্যক সমসাময়িক ওয়ার্কার কিউ ও লাইফসাইকেল ম্যানেজার
│   └── diagnostics/
│       └── RotationVerifier.js       # রোটেশন অডিট, কলিশন টেস্ট ও হেডার/TLS প্যারিটি চেকার
└── test/
    └── rotation_collision.test.js    # প্যারালাল ওয়ার্কার ইউনিকনেস ভেরিফিকেশন টেস্ট
```

---

## ৯. ধাপে ধাপে বাস্তবায়ন পরিকল্পনা (Phased Implementation Roadmap)

### Phase 1: Dependencies & Unified Profile Catalog তৈরি
1. `package.json`-এ `playwright-core` (অথবা `rebrowser-playwright`), `fingerprint-generator`, এবং `fingerprint-injector` যুক্ত করা।
2. `ProfileCatalog.js` ও `TlsHeaderBridge.js` তৈরি করা, যেখানে প্রতিটি ব্রাউজার ব্র্যান্ড (`chrome`, `edge`, `opera`, `brave`, `vivaldi`, `firefox`, `safari`)-এর সাথে তার সঠিক `node-tls-client` প্রোফাইল (`chrome_131`, `opera_91`, `firefox_133`, `safari_16_0`) এবং HTTP/2 হেডার রুল বাঁধা থাকবে।

### Phase 2: `ProfileLeaseManager` (Zero-Collision Engine) তৈরি
1. `AsyncMutex` সহ `acquireLease(workerId)` ও `releaseLease(leaseId)` তৈরি করা।
2. ব্র্যান্ড রোটেশন প্রায়োরিটি, সাব-ভ্যারিয়েন্ট রোটেশন, ক্রিপ্টো সিড জেনারেশন এবং `LRU` হিস্ট্রি ট্র্যাকিং যুক্ত করা।
3. **Collision Unit Test:** একসাথে ২০টি সমসাময়িক `Promise.all()` ওয়ার্কার চালিয়ে স্বয়ংক্রিয়ভাবে টেস্ট করা যে ২০টি ওয়ার্কারই আলাদা ফিঙ্গারপ্রিন্ট এবং প্রথম ৭টি ওয়ার্কার ৭টি ভিন্ন ব্রাউজার ব্র্যান্ড পাচ্ছে।

### Phase 3: Dual-Mode `EnginePoolManager` (Method 1 + Method 2) তৈরি
1. **Method 1 (`single-chromium`):** ১টি শেয়ারড Chromium/`fingerprint-chromium` ইনস্ট্যান্স থেকে মাল্টি-ব্র্যান্ড (`Chrome`, `Edge`, `Opera`, `Brave`, `Vivaldi`) আইসোলেটেড `BrowserContext` ও `navigator.userAgentData` ব্র্যান্ড ওভাররাইড তৈরি করা।
2. **Method 2 (`multi-engine`):** Playwright-এর মাধ্যমে `chromium`, `firefox` (বা `Camoufox`), এবং `webkit` সার্ভার অন-ডিমান্ড (Lazy Warm-up) চালু করা এবং `fingerprint-injector` দিয়ে প্রতিটি কনটেক্সটে বাস্তবসম্মত হার্ডওয়্যার সিগন্যাল বসানো।
3. **Hybrid Mode (`hybrid` — Default):** সিস্টেমে যেসব ইঞ্জিন বাইনারি উপস্থিত আছে সেগুলো স্বয়ংক্রিয়ভাবে ডিটেক্ট করে একসাথে পুল তৈরি করা (যাতে কোনো একটি বাইনারি না থাকলেও প্রোগ্রাম ক্র্যাশ না করে বাকিগুলো দিয়ে চলে)।

### Phase 4: `RedditSolver` ইন্টিগ্রেশন ও ডিবাগ ড্যাশবোর্ড আপগ্রেড
1. `RedditSolver`-কে এমনভাবে আপডেট করা যাতে সে যেকোনো লিজ নেওয়া প্রোফাইল (`leasedProfile`) গ্রহণ করে Step 1 (TLS), Step 2+3 (Isolated Context), এবং Step 4 (TLS) একই ব্রাউজার পরিচয়ে সম্পন্ন করে।
2. `DebugLogger`-এ প্রতিটি লগের সামনে `[Worker#3 | firefox_133 | Gecko]` ট্যাগ যোগ করা এবং `diagnostic_report.json`-এ প্রতিটি ওয়ার্কারের ব্রাউজার ব্র্যান্ড, ইঞ্জিন, TLS ID এবং কলিশন স্ট্যাটাস সেভ করা।
3. নতুন CLI ফ্ল্যাগ যোগ করা:
   * `--rotation-mode <single-engine|multi-engine|hybrid>`
   * `--verify-rotation <workers>` (যেমন `--verify-rotation 10` দিলে ১০টি সমসাময়িক ওয়ার্কার সিমুলেট করে একটি টেবিল প্রিন্ট করে দেখাবে যে প্রতিটা থ্রেডে কোন ব্রাউজার, কোন ইঞ্জিন, কোন GPU, এবং কোন TLS ফিঙ্গারপ্রিন্ট অ্যাসাইন হয়েছে!)

---

## ১০. `.env` কনফিগারেশন ডিজাইন (আসন্ন ইমপ্লিমেন্টেশনের জন্য)

```ini
# রোটেশন মোড: single-engine (Method 1) | multi-engine (Method 2) | hybrid (Both combined!)
ROTATION_MODE=hybrid

# একসাথে সর্বোচ্চ কতগুলো ওয়ার্কার চলবে
MAX_CONCURRENT_WORKERS=5

# কতগুলো রিকোয়েস্টের আগে একই ফিঙ্গারপ্রিন্ট সিড কখনো রিপিট হবে না
LEASE_HISTORY_SIZE=500

# ঐচ্ছিক: ওপেন-সোর্স C++ অ্যান্টি-ডিটেক্ট ব্রাউজার বাইনারি পাথ (না থাকলে স্বয়ংক্রিয়ভাবে Playwright/Puppeteer ইঞ্জিন চলবে)
FINGERPRINT_CHROMIUM_PATH=
CAMOUFOX_EXECUTABLE_PATH=
```

---

## ১১. কেন এই প্ল্যানটি সবচেয়ে কার্যকর ও নিরাপদ?

1. **Zero Engine Lie (কোনো ফেক ইঞ্জিন স্পুফিং নেই):** যখন Firefox যায় তখন আসল Gecko ইঞ্জিন + `firefox_133` TLS যায়; যখন Safari যায় তখন আসল WebKit ইঞ্জিন + `safari_16_0` TLS যায়; আর যখন Chrome/Edge/Opera/Brave যায় তখন ১টি শেয়ারড Chromium ইঞ্জিন থেকেই আলাদা ব্র্যান্ড কনটেক্সট + `chrome_131`/`opera_91` TLS যায়।
2. **Low RAM, High Speed:** বারবার ব্রাউজার চালু-বন্ধ হয় না; গরম ইঞ্জিনের ভেতর ১৫–৩০ MB-এর হালকা কনটেক্সট তৈরি ও ধ্বংস হয়।
3. **100% Thread Collision-Free:** মিউটেক্স লক এবং ব্র্যান্ড-সেপারেশন অ্যালগরিদম থাকায় দুটি ওয়ার্কার কখনোই একই ব্রাউজার একসাথে চালাতে পারবে না।
4. **Plug-and-Play Open-Source Anti-Detect:** সাধারণ মেশিনে কোনো এক্সট্রা সেটআপ ছাড়াই চলবে, আবার প্রোডাকশনে `fingerprint-chromium` এবং `Camoufox` বাইনারি বসিয়ে দিলেই C++ লেভেলের অ্যান্টি-ডিটেক্ট সক্ষমতা চালু হয়ে যাবে।
