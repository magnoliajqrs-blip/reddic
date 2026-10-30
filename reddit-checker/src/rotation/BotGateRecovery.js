'use strict';

/**
 * BotGateRecovery — Reddit's "Prove your humanity" / "whoa there" edge gate.
 *
 * Why this module exists
 * ----------------------
 * Reddit's edge (Fastly) answers a flagged request with a *page*, not a login form: a
 * reCAPTCHA v2 checkbox or a "whoa there, pardner" interstitial. The old solver only
 * matched one exact `<title>` string and then kept going as if it had a login page, so
 * the readiness gate timed out, `grecaptcha` never appeared and every account failed
 * with a misleading "reCAPTCHA failed" error.
 *
 * Responsibilities here:
 *   1. classify the gate (kind + widget type) from HTML, before anything else runs,
 *   2. try to clear it the only way a browser honestly can — click the checkbox,
 *   3. report failure as a first-class, non-retryable-on-this-IP error (`WAF_BLOCKED`).
 *
 * Everything is dependency-free so it can be unit-tested without a browser.
 */

const GATE_SIGNATURES = [
  {
    kind: 'humanity',
    // <title>Reddit - Prove your humanity</title> and the on-page copy
    test: (html) =>
      /<title>\s*Reddit\s*-\s*Prove your humanity\s*<\/title>/i.test(html) ||
      /prove your humanity/i.test(html),
    hint: 'Fastly/Reddit bot gate: IP reputation and TLS/HTTP2 fingerprint both scored low.',
  },
  {
    kind: 'whoa_there',
    test: (html) => /whoa there,?\s*pardner/i.test(html) || /you'?ve been blocked/i.test(html),
    hint: 'Reddit rate/abuse interstitial — this IP has been tripping the burst bucket.',
  },
  {
    kind: 'rate_limited',
    test: (html, status) => Number(status) === 429,
    hint: 'HTTP 429 from Reddit — slow down or rotate the egress IP.',
  },
  {
    kind: 'blocked_generic',
    test: (html) =>
      /<title>\s*Reddit\s*-\s*Blocked\s*<\/title>/i.test(html) ||
      /class="[^"]*\berror-page\b[^"]*"/i.test(html) && /blocked/i.test(html),
    hint: 'Reddit served a block page for this network.',
  },
];

/** Detect the reCAPTCHA flavour present on a gate page. */
function detectWidget(html = '') {
  const has = (re) => re.test(html);
  if (
    has(/data-sitekey="[^"]*"/i) &&
    (has(/class="[^"]*g-recaptcha[^"]*"/i) || has(/g-recaptcha"\s*data-size="normal"/i)) &&
    !has(/data-size="invisible"/i)
  ) {
    return 'checkbox';
  }
  if (has(/api2\/anchor|enterprise\/anchor/i)) return 'checkbox';
  if (has(/data-size="invisible"/i) || has(/grecaptcha\.enterprise\.execute/i)) return 'invisible';
  if (has(/checkbox-site-key/i)) return 'checkbox';
  return null;
}

/** Detect an hCaptcha/Turnstile wall — we do not attempt those. */
function detectForeignCaptcha(html = '') {
  if (/hcaptcha\.com\/1\/api\.js|class="[^"]*h-captcha/i.test(html)) return 'hcaptcha';
  if (/challenges\.cloudflare\.com\/turnstile/i.test(html)) return 'turnstile';
  return null;
}

/**
 * Classify a response as a bot gate.
 *
 * @param {string} html
 * @param {number} [status]
 * @returns {{blocked: boolean, kind: string|null, widget: string|null, hint: string|null, captcha: string|null}}
 */
function detectBotGate(html, status) {
  const body = typeof html === 'string' ? html : '';
  const foreign = detectForeignCaptcha(body);
  for (const sig of GATE_SIGNATURES) {
    let hit = false;
    try {
      hit = Boolean(sig.test(body, status));
    } catch {
      hit = false;
    }
    if (hit) {
      return {
        blocked: true,
        kind: sig.kind,
        widget: detectWidget(body),
        hint: sig.hint,
        captcha: foreign,
      };
    }
  }
  return { blocked: false, kind: null, widget: null, hint: null, captcha: foreign };
}

/**
 * Build the error thrown when the gate cannot be cleared.
 * `code` is what the pool/checker keys on; `retryable` means "a different identity might
 * help", `needsResidentialProxy` means "same IP will fail again".
 */
function wafError({ kind = 'unknown', widget = null, detail = '', needsResidentialProxy = true } = {}) {
  const err = new Error(
    `Reddit bot gate (${kind}${widget ? `/${widget}` : ''})${detail ? `: ${detail}` : ''}` +
      (needsResidentialProxy
        ? ' — this egress IP is flagged; use a residential/home IP (datacenter proxies will always be gated).'
        : '')
  );
  err.code = 'WAF_BLOCKED';
  err.wafKind = kind;
  err.widget = widget;
  err.retryable = true;
  err.needsResidentialProxy = needsResidentialProxy;
  return err;
}

/** True when an error (or verdict string) represents the gate. */
function isWafError(errOrVerdict) {
  if (!errOrVerdict) return false;
  if (typeof errOrVerdict === 'string') {
    return errOrVerdict === 'WAF_BLOCKED' || /prove your humanity|whoa there/i.test(errOrVerdict);
  }
  return (
    errOrVerdict.code === 'WAF_BLOCKED' ||
    errOrVerdict.wafKind != null ||
    /prove your humanity|whoa there,? pardner/i.test(errOrVerdict.message || '')
  );
}

const ANCHOR_URL_RE = /recaptcha\/(?:enterprise\/)?(?:api2\/)?anchor|recaptcha\/enterprise\/anchor/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Read the page title + body without throwing (both Playwright and Puppeteer). */
async function readPageText(page) {
  let title = '';
  let html = '';
  try {
    title = typeof page.title === 'function' ? await page.title() : '';
  } catch {
    title = '';
  }
  try {
    html = typeof page.content === 'function' ? await page.content() : '';
  } catch {
    html = '';
  }
  return { title, html };
}

/** Detect the gate on a live page (image/iframe pages included). */
async function detectBotGateInPage(page) {
  const { title, html } = await readPageText(page);
  const gate = detectBotGate(`<title>${title}</title>${html}`);
  let url = '';
  try {
    url = typeof page.url === 'function' ? page.url() : '';
  } catch {
    url = '';
  }
  if (!gate.blocked && /\/error\/|\/blocked/i.test(url)) {
    return { ...gate, blocked: true, kind: gate.kind || 'blocked_generic' };
  }
  return { ...gate, title, url };
}

/**
 * Find the reCAPTCHA anchor frame (the checkbox lives inside it) and its bframe sibling.
 * Works with Playwright and Puppeteer: both expose `page.frames()` and `frame.$()`.
 */
function findAnchorFrames(page) {
  let frames = [];
  try {
    frames = typeof page.frames === 'function' ? page.frames() : [];
  } catch {
    frames = [];
  }
  const matches = [];
  for (const frame of frames) {
    if (!frame) continue;
    let url = '';
    try {
      url = frame.url() || '';
    } catch {
      url = '';
    }
    if (ANCHOR_URL_RE.test(url)) matches.push({ frame, url });
  }
  return matches;
}

/** Is the checkbox already ticked / token already minted? */
async function isCheckboxSolved(page) {
  for (const { frame } of findAnchorFrames(page)) {
    try {
      const state = await frame.evaluate(() => {
        const el = document.querySelector('#recaptcha-anchor');
        if (!el) return { present: false };
        return {
          present: true,
          checked:
            el.getAttribute('aria-checked') === 'true' ||
            el.classList.contains('recaptcha-checkbox-checked'),
        };
      });
      if (state && state.present && state.checked) return true;
    } catch {
      /* frame navigated mid-evaluate — ignore */
    }
  }
  // A filled response textarea anywhere also means "solved".
  for (const { frame } of findAnchorFrames(page)) {
    try {
      const token = await frame.evaluate(() => {
        const ta = document.querySelector('#g-recaptcha-response');
        return ta ? String(ta.value || '').length : 0;
      });
      if (token > 20) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Click "I'm not a robot".
 *
 * Three strategies, cheapest first, because reCAPTCHA intercepts plain DOM clicks:
 *   1. `frame.click('#recaptcha-anchor')` — a real trusted input event via CDP,
 *   2. mouse click at the element's on-page bounding box (needs frame offset, best effort),
 *   3. `element.click()` inside the frame — last resort, still accepted by many builds.
 *
 * @returns {Promise<{clicked: boolean, solved: boolean, strategy: string|null, reason: string|null}>}
 */
async function clickRecaptchaCheckbox(page, { logger = null, timeoutMs = 45000 } = {}) {
  const startedAt = Date.now();
  const anchors = findAnchorFrames(page);
  if (anchors.length === 0) {
    return {
      clicked: false,
      solved: false,
      strategy: null,
      reason: 'no reCAPTCHA anchor frame on the page',
    };
  }

  // Strategy 1 — real CDP click inside the anchor frame.
  for (const { frame } of anchors) {
    try {
      const box = await frame
        .waitForSelector('#recaptcha-anchor', { timeout: Math.min(15000, timeoutMs) })
        .then(() => frame.$('#recaptcha-anchor'))
        .catch(() => null);
      if (!box) continue;
      await box.click({ timeout: 8000, delay: 40 + Math.floor(Math.random() * 90) });
      logger?.info?.('Step2:BotGate', 'Checkbox clicked via frame.click()');
      break;
    } catch (err) {
      logger?.debug?.('Step2:BotGate', `frame.click failed: ${err.message}`);
    }
  }

  // Strategy 2 — mouse click at the checkbox coordinates (jittered like a human).
  if (!(await isCheckboxSolved(page))) {
    for (const { frame } of anchors) {
      try {
        const el = await frame.$('#recaptcha-anchor');
        if (!el) continue;
        const box = await el.boundingBox();
        if (!box) continue;
        // The anchor iframe is positioned by Reddit; add its viewport offset when we can
        // read it, otherwise fall back to the raw in-frame coordinates.
        let offsetX = 0;
        let offsetY = 0;
        try {
          if (typeof frame.frameElement === 'function') {
            const frameEl = await frame.frameElement();
            const frameBox = frameEl ? await frameEl.boundingBox() : null;
            if (frameBox) {
              offsetX = frameBox.x;
              offsetY = frameBox.y;
            }
            await frameEl?.dispose?.().catch?.(() => {});
          }
        } catch {
          /* offsets are best effort */
        }
        const x = offsetX + box.x + box.width / 2 + (Math.random() * 4 - 2);
        const y = offsetY + box.y + box.height / 2 + (Math.random() * 4 - 2);
        await page.mouse.move(x - 24, y - 18, { steps: 4 });
        await page.mouse.move(x, y, { steps: 3 });
        await page.mouse.click(x, y, { delay: 60 });
        logger?.info?.('Step2:BotGate', 'Checkbox clicked via mouse coordinates');
        break;
      } catch (err) {
        logger?.debug?.('Step2:BotGate', `mouse click failed: ${err.message}`);
      }
    }
  }

  // Strategy 3 — DOM .click().
  if (!(await isCheckboxSolved(page))) {
    for (const { frame } of anchors) {
      try {
        const ok = await frame.evaluate(() => {
          const el = document.querySelector('#recaptcha-anchor');
          if (!el) return false;
          el.click();
          return true;
        });
        if (ok) {
          logger?.info?.('Step2:BotGate', 'Checkbox clicked via DOM .click()');
          break;
        }
      } catch (err) {
        logger?.debug?.('Step2:BotGate', `DOM click failed: ${err.message}`);
      }
    }
  }

  const clicked = true;
  const deadline = Date.now() + timeoutMs;
  let solved = false;
  while (Date.now() < deadline) {
    solved = await isCheckboxSolved(page);
    if (solved) break;
    await sleep(700 + Math.floor(Math.random() * 400));
  }

  return {
    clicked,
    solved,
    strategy: solved ? 'checkbox' : null,
    reason: solved ? null : 'checkbox did not turn green before timeout',
    elapsedMs: Date.now() - startedAt,
  };
}

/** Wait until the gate page navigates back to a usable /login/ page. */
async function waitForGateClearance(page, { timeoutMs = 45000, logger = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gate = await detectBotGateInPage(page);
    if (!gate.blocked) {
      let url = '';
      try {
        url = page.url() || '';
      } catch {
        url = '';
      }
      logger?.info?.('Step2:BotGate', `Gate cleared → ${url}`);
      return true;
    }
    await sleep(900 + Math.floor(Math.random() * 500));
  }
  return false;
}

/**
 * Full recovery attempt: detect → click checkbox (optional) → wait for clearance.
 *
 * @returns {Promise<{blocked: boolean, cleared: boolean, kind: string|null, widget: string|null,
 *                    clicked: boolean, hint: string|null, reason: string|null}>}
 */
async function resolveBotGate(
  page,
  { logger = null, timeoutMs = 45000, allowCheckbox = true } = {}
) {
  const gate = await detectBotGateInPage(page);
  if (!gate.blocked) {
    return { blocked: false, cleared: true, kind: null, widget: null, clicked: false, hint: null, reason: null };
  }

  logger?.warn?.(
    'Step2:BotGate',
    `Detected ${gate.kind} gate${gate.widget ? ` (${gate.widget})` : ''} — ${gate.hint}`
  );

  if (gate.captcha) {
    return {
      ...gate,
      blocked: true,
      cleared: false,
      clicked: false,
      reason: `unsupported captcha provider: ${gate.captcha}`,
    };
  }

  if (gate.widget === 'checkbox' && allowCheckbox) {
    const click = await clickRecaptchaCheckbox(page, { logger, timeoutMs });
    if (click.solved) {
      const cleared = await waitForGateClearance(page, { timeoutMs, logger });
      if (cleared) {
        return { ...gate, cleared: true, clicked: true, reason: null };
      }
      return { ...gate, cleared: false, clicked: true, reason: 'checkbox solved but page did not clear' };
    }
    return { ...gate, cleared: false, clicked: click.clicked, reason: click.reason };
  }

  // Invisible reCAPTCHA gates sometimes clear after a plain reload with a warmed cookie jar.
  const cleared = await waitForGateClearance(page, { timeoutMs: Math.min(timeoutMs, 12000), logger });
  return {
    ...gate,
    cleared,
    clicked: false,
    reason: cleared ? null : 'gate page has no solvable checkbox widget',
  };
}

module.exports = {
  detectBotGate,
  detectBotGateInPage,
  detectWidget,
  detectForeignCaptcha,
  wafError,
  isWafError,
  clickRecaptchaCheckbox,
  waitForGateClearance,
  resolveBotGate,
  findAnchorFrames,
  isCheckboxSolved,
  GATE_SIGNATURES,
};
