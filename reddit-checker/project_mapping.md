# ⚠️ DEPRECATED — এই ফাইলটা পুরনো ও ভুল

> এই ম্যাপ 2026-এর শুরুর দিকে লেখা। `reddit_solver.js`-এর লাইন সংখ্যা, আরও কয়েকটা ফাইলের অস্তিত্ব,
> আর entrypoint-এর তথ্য এখন মেলে না (এখানে ৪টা Python ফাইলের কথা আছে যেগুলো প্রজেক্টে নেই)।
> **সঠিক ম্যাপ: [PROJECT_MAP.md](./PROJECT_MAP.md)।** ফাইলটা শুধু ইতিহাসের জন্য রাখা হলো।

---

# Reddit Reverse Engineering Project - Workflow Mapping

## 📋 Overview
This project is a **Reddit Anti-Bot Bypass System** that reverse-engineers Reddit's reCAPTCHA Enterprise v3 protection mechanism to enable automated login. The system combines network-level automation (using `node-tls-client`) with browser-level automation (using `puppeteer`).

---

## 🎯 Core Files in Root Directory

| File | Purpose | Dependencies |
|------|---------|--------------|
| `package.json` | Project manifest with dependencies | N/A |
| `reddit_solver.js` | Main solver logic (1006 lines) | Puppeteer, node-tls-client |
| `reddit_checker.js` | (Not found in root) | TBD |
| `recaptcha_payload_builder.py` | Python protobuf builder | PyProtoBuf |
| `recaptcha_telemetry.py` | Telemetry generation | N/A |
| `recaptcha__en.js` | (Not in root) - main reCAPTCHA engine | N/A |
| `debug_bg.js` / `debug_recaptcha_sdk.js` | Debug/debugging utilities | Various |

---

## 🔄 Complete Automation Workflow

### Authentication Flow

```
1. Reddit JS Challenge (GET /login) → Solve via inline script
2. reCAPTCHA Anchor (GET anchor page) → Extract token + init params
3. reCAPTCHA Reload (POST protobuf) → Get final token
4. Reddit Login API (POST /svc/shreddit) → Credential check
```

### Technical Stack
**Format:** Single-dependency (Node.js)
**Languages:** JavaScript (reddit_solver.js), Python (recaptcha_payload_builder.py, recaptcha_telemetry.py)
**Key Packages:** puppeteer, node-tls-client, bgutils-js, jsdom

---

## 🔐 Authentication Handshake

### 1. Auth Flow
- **Step 1:** `GET https://www.reddit.com/login/`
  - Sees Reddit's JS challenge (solves it → extracts inline value + form token)
  - Redirects to `/login?solution=inlineValue+doubled`
- **Step 2:** Retrieve anchor token from response HTML
  ```js
  const anchorMatch = html.match(/id="recaptcha-token"\s+value="([^"]+)"/);
  ```
- **Step 3:** Execute anchor (`GET /recaptcha/enterprise/anchor?k=SITE_KEY`)
  - Extract JSON config → parse `recaptcha.anchor.Main.init("PARAMS")`
- **Step 4:** POST reload payload to `https://www.google.com/recaptcha/enterprise/reload`
  - Payload headers for varint encoding
  - Response JSON: `["rresp","TOKEN",null,ttl,...]`

### 2. Required Headers
```js
{
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Edg/131.0.0.0",
  "Accept": "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "sec-ch-ua": '"Microsoft Edge";v="131"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Referer": "https://www.reddit.com/login/"
}
```

### 3. Token Extraction
**From Anchor Page:**
```js
const recaptchaToken = extractAnchorToken(html); // Regex: id="recaptcha-token"
```

**From Reload Response:**
```js
const response = parseReloadResponse(text);
const recaptchaToken = response.recaptchaToken; // Index[1]
```

---

## 🌐 Protocol & Payload Architecture

### 1. Transport
| Use | Protocol | Use Case |
|------|----------|----------|
| HTTP Client (`TlsHttpClient`) | HTTPS (TLS Client) | Reddit login, reCAPTCHA anchor/reload |
| Puppeteer | WebSockets | BotGuard execution |

### 2. Inbound Schema (Reddit)
```json
{
  "status": 200,
  "body": "HTML from login page",
  "headers": {
    "Set-Cookie": "csrf_token=...; secure"
  }
}
```

**Form Token Extraction:**
```js
const formToken = html.match(/name="token"\s+value="([^"]+)"/)[1];
```

### 3. Outbound Schema (reCAPTCHA)
```protobuf
message ReloadPayload {
  string version = 1;
  string initial_token = 2;
  int32 session_hash = 5;
  string operation = 6;
  string action = 8; // "login"
  string site_key = 14;
  string field20 = 20; // Telemetry base64
  string field22 = 22; // Chrome fingerprint base64
  int32 anchor_ms = 28;
  int32 execute_ms = 29;
}
```

### 4. Keep-Alive Interval
- **TLS Session:** 120s timeout (`node-tls-client`)
- **WebSocket:** None (no persistent connection, session-based)

---

## 🛡️ Stealth & Evasion

### 1. WAF Bypass Strategy (Cloudflare/Akamai)
**TLS Fingerprint Spoofing:**
```js
session = new Session({
  clientIdentifier: 'chrome_131',  // Chrome 131 TLS fingerprint
  timeout: 30000,
  randomTlsExtensionOrder: true,   // Random extension order
  forceHttp1: false
});
```

**BotSignals:**
- Generated field20: timing events (FCP, DOM-ready, interaction time)
- Generated field22: Chrome user agent bits + random density pattern
- Session meta: `{ signalCount: int, elapsedMs: int }`

### 2. Rate Limit Strategy
**For Puppeteer (BotGuard):**
- No explicit rate limiting (per-request execution)
- Browser headless with `--no-sandbox` + stealth plugin

**For HTTP Client (node-tls-client):**
- 30s timeout on each request
- Cookie persistence across requests
- Referer and random timing between requests

---

## 🔌 API Bridge & Middleware Logic

### 1. Inbound Hook (Message Interception)
```js
// In redis_solver.js: line 567
if (inlineMatch && formToken) {
  const solution = inlineValue + inlineValue; // Double the value
  this.challengeUrl = `https://www.reddit.com/login/?solution=${encodeURIComponent(solution)}...`;
}
```

### 2. reCAPTCHA Hook (Message Extraction)
```js
// Extract from anchor page HTML (line 624):
const anchorToken = extractAnchorToken(html);

// Extract anon init params:
const initParams = parseAnchorInit(html); // Returns { anchorToken, siteKey, sessionHash, ... }

// Extract from reload response (line 697):
const response = parseReloadResponse(responseText);
const finalToken = response.recaptchaToken;
```

### 3. Outbound Injection
```js
// Reddit API POST: line 841
const formBody = [
  `username=${username}`,
  `password=${password}`,
  `recaptcha_token=${finalToken}`, // Inject token
  `recaptcha_use_checkbox=false`,
  `csrf_token=${csrfToken}`,
].join('&');

const res = await client.post('https://www.reddit.com/svc/shreddit/account/login', formBody, headers);
```

### 4. Concurrency Model
**Asynchronous Parallel Execution:**
```
┌─────────────────────────────────────┐
│ Step 1: Solve JS Challenge      ───→│ (Async: line 672)
│  - Fetch /login                    │
│  - Duplicate inline value          │
│  - Get redirect                    │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Step 2+3: reCAPTCHA               ───→│ (Async: line 734)
│  - Puppeteer.launch()              │
│  - Navigate to page                │
│  - Execute griaptcha.enterprise()  │
└─────────────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Step 4: Reddit Login               ───→│ (Async: line 841)
│  - POST /svc/shreddit              │
│  - Receive response                │
└─────────────────────────────────────┘
```

**Session State Management:**
- `this.client` persists across steps
- `this.client.cookies` updated after each request
- `this.challengeUrl, this.loginPageHtml` saved for reuse

---

## 💻 Production-Level Implementation

### Key Classes in `reddit_solver.js`:

**1. `ProtobufWriter`:** (lines 50–112)
- Custom wire-format encoder
- Supports varints, strings, int32

**2. `TlsHttpClient`:** (lines 346–397)
- Uses `node-tls-client` (Chrome 131 JA3)
- TLS fingerprint spoofing
- Cookie persistence
- 30s timeout

**3. `RedditSolver`:** (lines 590–992)
- Main orchestration class
- 4-step login flow
- Client management (`close()` at end)

---

## 🧪 Testing Modes

### Unit Tests (`--test` flag): 4 Tests

1. **`testProtobufBuilder()`** (lines 975–983): Validates protobuf encoding
   - Payload: `{ initialToken, sessionHash, anchorMs, executeMs }`
   - Verifies: field[1] = version string

2. **`testTelemetry()`** (lines 985–1001): Telemetry field generation
   - Field20: timing/perf/domain/session meta
   - Field22: Chrome fingerprint + randomness

3. **`testResponseParser()`** (lines 1003–1009): JSON response parsing
   - Expected format: `["rresp","TOKEN",null,ttl,...]`
   - Extracts: recaptchaToken, ttl, tokenA, tokenB

4. **`testUrlBuilder()`** (lines 1011–1026): Anchor/reload URL construction
   - Verifies base64url + `.` base transition

---

## 📁 File Structure (Root Only)

```
test_no_bg/
├── package.json                    # Dependencies (puppeteer, node-tls-client)
├── reddit_solver.js                # Main solver (1006 lines, core workflow)
├── reddit_checker.js               # (Not in root)
├── recaptcha_payload_builder.py    # Python protobuf integration
├── recaptcha__en.js                # Core reCAPTCHA engine (not in root)
├── recaptcha_telemetry.py          # Telemetry generation utility
├── debug_bg.js                     # Debug utilities
├── debug_recaptcha_sdk.js          # SDK debugging
├── enterprise.js                   # Main entry point?
├── banned.txt / proxy.txt         # Config/secrets
└── project_mapping.md              # This document
```

---

## 🚀 Usage

### Example: Get reCAPTCHA token only
```bash
node reddit_solver.js
```

### Example: Full login
```bash
node reddit_solver.js --login user123 yourpassword123
```

### Example: Run unit tests
```bash
node reddit_solver.js --test
```

---

## ⚠️ Risk Assessment
- **Threat Level:** **HIGH** (Bypasses cloud-based bot validation)
- **Technical Complexity:** HIGH (TLS spoofing + protobuf encoding + Puppeteer)
- **Maintainability:** MEDIUM (Custom protobuf writer, inline regex parsing)
- **Dependencies:** 5 major packages (all from npm)

---

## 🔮 Future Work (Based on Files Not in Root)

1. **`reddit_checker.js`**: Likely for validating login state
2. **`recaptcha_extraction.js`**: Python bot (to decrypt secrets directly)
3. **`test_background.js` files**: Framework/automation tests