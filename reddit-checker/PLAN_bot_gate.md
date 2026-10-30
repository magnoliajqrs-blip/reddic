# PLAN — "Prove your humanity" bot gate (v2.4.0)

Screenshot evidence: `https://www.reddit.com/login/` returns the Fastly/Reddit page
`Reddit - Prove your humanity` with a **reCAPTCHA v2 checkbox** ("I'm not a robot").
It is **not** a bug in the login POST — the request never reaches the login form.

## 1. Why it fires (live research, 2026-10)

| Signal | What Reddit sees | Effect |
|---|---|---|
| IP reputation | Datacenter / VPS / proxy ASN | Hard gate **before** login, regardless of fingerprint |
| HTTP/2 + TLS fingerprint | Playwright/Chromium JA3/JA4 + header order | `--disable-http2` is the documented counter for Reddit |
| Headless | headless Chromium / new headless | Checkbox stays unsolved, score too low |
| Shared identity | Many accounts, one profile/cookie jar/canvas | Gate + silent bans |
| Burst pattern | Same IP, N logins in seconds | `whoa there, pardner` / 429 |

**Hard truth:** no fingerprint trick beats a flagged datacenter IP. On such an IP the
checkbox cannot be solved programmatically without a paid solver — the honest outcome is
`WAF_BLOCKED`, not a fake success. With a residential/home IP + a real headed window the
checkbox usually auto-clears, and that path *is* automatable.

## 2. Scope (in)

1. **Real gate detection** — recognise the whole family (`humanity`, `whoa there`, 429 block),
   not just one `<title>` regex; detect the widget type (checkbox vs invisible).
2. **Checkbox recovery** — click the anchor iframe `#recaptcha-anchor`, wait for the
   redirect back to `/login/`, then continue the normal token flow. Multiple click
   strategies (frame click → bounding-box mouse click → DOM `.click()`).
3. **Unique browser per request, zero sharing** — every account attempt gets its own
   lease → own `signatureId`, own engine process, own context, own cookie jar.
   Identity is burned the moment it is used; nothing is ever handed out twice.
4. **`--disable-http2`** for Chromium launches (default on, `DISABLE_HTTP2=0` to revert).
5. **Human dwell** — minimum on-page time (default 8s it's configurable) before calling
   `grecaptcha.enterprise.execute()`, plus mouse jitter.
6. **Retry ladder in the worker pool** — `WAF_BLOCKED` no longer silently ends a check:
   attempt 2 runs on a *fresh identity* (and therefore fresh cookies/TLS/HTTP2 class).
7. **Honest verdicts** — `WAF_BLOCKED` reaches the result table with a hint
   (`NEEDS_RESIDENTIAL_PROXY`), the account is not marked bad, no fake hit.
8. **Cookie continuity** — `DEVICE_CACHE` becomes default-on so a returning account keeps
   `loid/rdt/edgebucket/csv` instead of looking like a brand-new device every run.
9. **Hermetic tests** (`test/phase8_bot_gate.test.js`) — detector classification,
   checkbox click ordering against a fake page/frame, retry-ladder, uniqueness assertions.
   No network, no browser binary required.

## 3. Scope (out)

- No third-party CAPTCHA solving service integration (2Captcha etc.) — legal/ToS and cost
  decisions belong to the operator. The code leaves a single, documented hook.
- No proxy supplier integration; the checker keeps using `proxies.txt` / `PROXY` as-is.
- No changes to ban/hit classification, output files, or credentials.

## 4. Flow after the fix

```
fullLogin(account)
 └─ Step1 HTTP /login/
     ├─ humanity page?  → retry once (5.5s) → still blocked?
     │      mode has browser → mark gate, continue   (browser may clear it)
     │      mode http only   → throw WAF_BLOCKED     (no wasted login POST)
     └─ ok
 └─ Step2 browser token
     ├─ goto /login/
     ├─ detectBotGate(page)            ← NEW, before the readiness gate
     │    └─ checkbox? click anchor → wait clearance (≤45s) → reload if needed
     ├─ readiness gate (unchanged)
     ├─ dwell ≥ PAGE_DWELL_MS + mouse jitter   ← NEW
     └─ grecaptcha.execute()
     └─ gate still present → throw WAF_BLOCKED (+ screenshot/HTML artifact)
 └─ pool: verdict WAF_BLOCKED → burn lease → new lease → one retry
```

## 5. Env knobs (all optional)

| Var | Default | Meaning |
|---|---|---|
| `DISABLE_HTTP2` | `1` | add `--disable-http2` to Chromium args |
| `PAGE_DWELL_MS` | `8000` | min time on page before `execute()` |
| `BOT_GATE_TIMEOUT_MS` | `45000` | how long the checkbox / clearance is awaited |
| `BOT_GATE_CHECKBOX` | `1` | allow clicking "I'm not a robot" |
| `WAF_RETRY_ATTEMPTS` | `1` | extra attempts after `WAF_BLOCKED` (fresh identity each) |
| `DEDICATED_BROWSER_PROCESS` | `1` | one OS browser process per account attempt |
| `DEVICE_CACHE` | `1` | reuse the account's own cookie jar across runs |

## 6. Acceptance

- `npm test` green, `npm run test:phases` green (phase8 included).
- With a datacenter IP: result row shows `WAF_BLOCKED` + `NEEDS_RESIDENTIAL_PROXY`,
  account is not burned/marked invalid, and the log shows the gate kind + widget.
- With a home/residential IP, headed: the checkbox is clicked, page returns to `/login/`,
  token is obtained, login proceeds.
- Two accounts never report the same `signatureId` / `leaseId`, even across retries.
