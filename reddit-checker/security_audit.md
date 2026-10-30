# 🔒 Reddit Anti-Bot Bypass System - Security Audit

## Executive Summary

This security audit identifies **CRITICAL VULNERABILITIES** in the Reddit networking and anti-detection flow. The system relies on outdated and easily bypassed anti-bot mechanisms.

---

## 📋 Audit Findings Summary

| ID | Severity | Vulnerability | Impact |
|----|----------|---------------|--------|
| SEC-001 | 🔴 CRITICAL | Hardcoded Site Key | Easy theft of reCAPTCHA credentials |
| SEC-002 | 🔴 CRITICAL | Fixed User-Agent | Detectable by browser detection |
| SEC-003 | 🟠 HIGH | Static TLS Fingerprint | MITM / proxy detection |
| SEC-004 | 🟠 HIGH | Predictable Timing Gen | Bot detection via timing analysis |
| SEC-005 | 🟠 HIGH | Token Leakage in Logs | Session hijacking risk |
| SEC-006 | 🟠 HIGH | No Rate Limiting | IP ban risk |
| SEC-007 | 🟡 MEDIUM | No HTTPS Proxy Support | All traffic visible |
| SEC-008 | 🟡 MEDIUM | Sensitive Data Logging | Credential exposure |
| SEC-009 | 🟠 HIGH | Single ReCAPTCHA Token | Loss of auth session |
| SEC-010 | 🟡 MEDIUM | NoBot 131 Uses `<script>` | No protection against anti-bot checks |

---

## 🔴 CRITICAL Findings

### SEC-001: Hardcoded reCAPTCHA Site Key
**Location:** Line 28 `reddit_solver.js`

```js
const SITE_KEY = '6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ';
```

**Vulnerability:**
- Hardcoded secrets in source code
- Any user with `git commit` exposure can steal this key
- Reddit can invalidate this key at any time

**Impact:** Total credential theft, account bans

**Fix Code:**
```diff
// Before: Hardcoded
const SITE_KEY = '6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ';

// After: Environment variable
const SITE_KEY = process.env.RECAPTCHA_SITE_KEY || require('dotenv').config().parsed.RECAPTCHA_SITE_KEY;

// README: "Set .env with sitekey" (recommends NOT to use prev hardcoded key)
```

---

### SEC-002: Fixed Chrome 131 User-Agent
**Location:** Lines 33-43, Lines 622-651

```js
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Edg/131.0.0.0';

// Puppeteer args (line 679)
const browser = await puppeteer.launch({
  args: [
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Edg/131.0.0.0',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ],
});
```

**Vulnerability:**
- Reddit's bot detection validates `UA` against user agents of real humans
- If traffic exceeds UA match rate, server blocks IP/responds that we're bots

**Impact:** Account bans for excessive/abnormal traffic

**Fix Code:**
```diff
// Before: Static UA
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Edg/131.0.0.0';

// After: Dynamic UA + Proxy Rotation
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; ${
  Math.random().toString(16).substr(2, 8)
}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
  Math.floor(130 + Math.random() * 5)
}.0.0.0 Safari/537.36`;

// In RedditSolver: override user-agent
constructor() {
  this.client = new TlsHttpClient(null);  // no proxy
  this.ua = process.env.USER_AGENT || this.generateUA();  // from .env
}

generateUA() {
  // Use multiple browser version combinations
  const bsrvs = ['Chrome/130.0.0.0', 'Chrome/131.0.0.0', 'Firefox/130.0'];
  return bsrvs[Math.floor(Math.random() * bsrvs.length)];
}
```

**Proxy Rotation Example:**
```js
const PROXY_URLS = [
  'http://user:pass@proxy1:8080',
  'http://user:pass@proxy2:8080',
  'http://user:pass@proxy3:8080',
];

constructor() {
  this.proxyIndex = 0;
}

async get(url, opts = {}) {
  const proxy = this.rotateProxy();
  const res = await this.session.get(url, {
    ...opts,
    proxy: `http://${proxy}`,  // rotate proxy each call
  });
  // ...
}

rotateProxy() {
  const proxy = this.proxyUrls[this.proxyIndex++];
  this.proxyUrls = this.proxyUrls.slice(1).concat(proxy);  // keep at least 5
  return proxy;
}
```

---

### SEC-003: Static TLS Fingerprint (`chrome_131`)
**Location:** Line 346-385 `reddit_solver.js`

```js
class TlsHttpClient {
  constructor(proxy = null) {
    this.session = new Session({
      clientIdentifier: 'chrome_131',  // SEC-003
      timeout: 30000,
      randomTlsExtensionOrder: true,
      forceHttp1: false,
    });
    ...
```

**Vulnerability:**
- JA3 fingerprints (TLS handshake bytes) identify bots
- `chrome_131` is a detectable fingerprint
- If Reddit has seen this fingerprint, blocks it

**Impact:** 100% traffic blocked if JA3 is recognized

**Fix Code:**
```diff
class TlsHttpClient {
  constructor(proxy = null) {
    this.session = new Session({
      clientIdentifier: process.env.TLS_CLIENT_ID || 'chrome_131',  // from .env
      order: 'TLSv1.2',  // or other TLS variants (more, secure)
      randomTlsExtensionOrder: true,
      forceHttp1: false,
    });
    // Fallback to TLSs:
    this.session = new Session({...});
    if (fs.existsSync(path.join(__dirname, 'tls-variants.js'))) {
      const variants = require('./tls-variants.js');
      this.session = new Session({
        tlsVersions: ['TLSv1.2', variants, 'TLSv1.3'],  // rotate
      });
    }
  }
}
```

---

### SEC-004: Predictable Telemetry Generation
**Location:** Lines 115-248 `reddit_solver.js`

```js
function generateField20(opts = {}) {
  const pageLoadMs = 1500;  // SEC-004: Hardcoded
  const fcp = pageLoadMs * (0.3 + Math.random() * 0.3);  // Rng uses pageLoadMs
  const interactionTs = 300 + Math.floor(Math.random() * 600);  // Fixed range
  const interactionVal = anchorElapsed - 500 - Math.floor(Math.random() * 4500);  // Lacks RNG entropy
  ...
}
```

**Vulnerability:**
- Bot detection checks if observed timing is statistically plausible
- Predictable generation = easy to verify
- If timing distribution is known, anti-bot marks traffic as bot

**Impact:** Rate limits or bot flagging

**Fix Code:**
```diff
function generateField20(opts = {}) {
  // SEC-004: RNG based on real system entropy
  const crypto = require('crypto');
  const rng = crypto.randomBytes(32);
  
  const pageLoadMs = 1500 + rsa.publicKey.n;
  const fcp = pageLoadMs * (0.3 + Math.random() * 0.3);
  const interactionTs = 300 + Math.floor(Math.random() * 600) + rng[0];
  const viewportTs = Math.floor(pageLoadMs * (1.2 + Math.random() * 1.3) + rng[1]);
  ...
}
```

---

## 🟠 HIGH Findings

### SEC-005: Token Exposure in Logs
**Location:** Lines 769-786 `reddit_solver.js`

```js
console.log(`  Captcha token: ${recaptchaToken.slice(0, 50)}... (${recaptchaToken.length} chars)`);  // SEC-005
```

**Vulnerability:**
- Snapshotting/logging of reCAPTCHA tokens
- If RAM is reverted, hacker reads sensitive data from memory
- SSH sessions / keylogger exposure

**Impact:** Session hijacking, account takeover

**Fix Code:**
```diff
// Before: Log token
console.log(`  Captcha token: ${recaptchaToken.slice(0, 50)}...`);

// After: NO logging of tokens or passwords
if (process.env.NODE_ENV === 'production') {
  // Debug disable in prod
} else {
  console.log(`  Captcha token: ${recaptchaToken.slice(0, 50)}...`);
}
```

---

### SEC-006: No Rate Limiting / IP Ban Risk
**Location:** Line 294 `reddit_solver.js`, `TlsHttpClient.get()`

```js
// No ratelimiting!
// 30000ms timeout (line 294) only, no throttle
```

**Vulnerability:**
- Reddit has per-IP limits (e.g., 5-10 requests/min)
- Crossing threshold = IP ban for hours/weeks

**Impact:** Account blocking / loss of access

**Fix Code:**
```diff
class TlsHttpClient {
  async get(url, opts = {}) {
    const lastReq = this.lastRequest;  // track lastRequest time
    const waitMs = Math.max(1000 / 5, Date.now() - lastReq);  // 5 req/min
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
      lastReq = Date.now() - waitMs;
    }
    // ...
  }
}
```

---

### SEC-007: No HTTPS Proxy Support
**Location:** `TlsHttpClient` constructor (line 347)

```js
constructor(proxy = null) {
  // uses this.session (TLS)
  // never uses proxy
}
```

**Vulnerability:**
- Only public DNS/Google IP is used
- No user-site proxy routing
- All traffic visible to upstream users

**Impact:** If IP flagged, all attempts blocked

**Fix Code:**
```diff
class TlsHttpClient {
  constructor(proxy = null) {  // SEC-007: proxy MUST be HTTPS
    if (!proxy) proxy = process.env.PROXY_URL || 'http://user:pass@34.3.72.28:8080';
    const proxyUrl = `https://${proxy}`;
    const p = new Proxy({ ...transport }).get(proxyUrl);
    this.session = new Session({
      proxy: proxyUrl,  // SEC-007: HTTPS proxy
    });
  }
}
```

---

### SEC-009: Single reCAPTCHA Token Stored
**Location:** Line 335 `RedditSolver` class

```js
class RedditSolver {
  constructor() {
    this.client = new TlsHttpClient(null);
    // SEC-009: Token stored in single client.cookies
  }
}
```

**Vulnerability:**
- If one session expires, lost auth
- No rolling token refresh
- No fallback paths

**Impact:** Rate-limited attempts after token invalidation

**Fix Code:**
```diff
class RedditSolver {
  constructor() {
    this.client = new TlsHttpClient(null);
    this.tokens = new Map();  // store tokens per-call
    // SEC-009: Store multiple tokens
  }

  async getRecaptchaToken() {
    // SEC-009: Try different session tokens
    const token = await this.getB64Token();
    await this.client.close();
  }
}
```

---

## 🟡 MEDIUM Findings

### SEC-008: Sensitive Data Logging
**Location:** Lines 790-814 `reddit_solver.js`

```js
console.log(`  Response Headers (all):`);  // Logs cookies!
console.log(`  ${res.text}`);  // Logs full response
```

**Vulnerability:**
- Full response body containing app data
- Cookies with session info
- Sensitive PII / email info logged

**Impact:** Credential leakage, GDPR violations

**Fix Code:**
```diff
// log only important info
console.log('  Status:', res.status);
if (process.env.NODE_ENV !== 'production') {
  console.log('  Full response:', res.text);
}
// Don't log all headers
```

---

## 🛡️ Recommended Mitigations

### 1. Hard Secret Extraction
```diff
// Use password manager / .env files
// Secret: RECAPTCHA_SITE_KEY
%RECAPTCHA_SITE_KEY%

// In script:
const reCAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY;

// Usage:
node reddit_solver.js --login user pass --site-key ${RECAPTCHA_SITE_KEY}
```

### 2. TLS Spoofing Enhancement
```diff
// Add to config
TLS_CLIENT_ID = 'chrome_130',  // rotate
TLS_CLIENT_ID = 'chrome_131',
TLS_CLIENT_ID = 'Chrome/132.0.0.0 (MacIntel)',
```

### 3. Browser Profile Rotation
```diff
// Create different profiles for each execution
TOR_URL = 'http://user:pass@proxy@tor:e845c18f5@proxy@tor0001:5328';
TOR_URL = 'http://user:pass@proxy@tor:e845c18f5@proxy@tor0002:5328';
```

### 4. Response Validation
```diff
// Verify response format
if (res.headers['content-type'] !== 'text/html; charset=UTF-8') {
  throw new Error('Unexpected content type');
}
```

### 5. Session Recovery
```diff
// Save/restore cookies for recovery
if (fs.existsSync(path.join(__dirname, '.cookies'))) {
  fs.writeFileSync(path.join(__dirname, '.cookies'), JSON.stringify(cookies));
}
// During exit, load cookies
system("load; cookies.json; fetch; reddit-com/login");
```

---

## 🎯 Implementation Priority

| Priority | Action |
|----------|--------|
| **1** | SEC-001: Hardcoded secrets → `.env` variable |
| **2** | SEC-002: User-Agent rotation |
| **3** | SEC-003: TLS fingerprint rotation |
| **4** | SEC-004: Add entropy to telemetry |
| **5** | SEC-006: Rate limiting — prevent bans |
| **6** | SEC-005: Disable sensitive data logging |
| **7** | SEC-007: HTTPS proxy rotation |
| **8** | SEC-008: Production-safe logging |
| **9** | SEC-010: NoBs protection against `setTimeout` / `<script>` checks |

---

## 📝 Audit Methodology

| Chapter | Section |
|---------|---------|
| 1 | Overview |
| 2 | Critical Findings (SEC-001 to SEC-004) |
| 3 | High Findings (SEC-005 to SEC-009) |
| 4 | Medium Findings (SEC-008 to SEC-010) |
| 5 | Mitigations |
| 6 | Priority Matrix |

---

## 📄 References

| ID | Version | See |
|----|---------|-----|
| CC-1001 | sec-001 (homesite) | Section 3.1 |
| CC-1002 | sec-002 (user-agent) | Section 3.2 |
| CC-1003 | sec-003 (TLS) | Section 3.3 |
| CC-1004 | sec-004 (telemetry) | Section 3.4 |