'use strict';

/**
 * BrowserReadiness.js — "is the browser actually done loading?" before we spend a login attempt.
 *
 * The old flow navigated with `waitUntil: 'domcontentloaded'`, waited for `grecaptcha` to exist,
 * ran `execute()`, copied whatever cookies existed at that instant into the TLS client and
 * immediately POSTed `/svc/shreddit/account/login`.
 *
 * `domcontentloaded` fires long before the document has finished: shreddit keeps loading chunks,
 * fonts and XHRs, the reCAPTCHA anchor page is still fetching, and Reddit's own session cookies
 * (`session`, `csrf_token`, `loid`) can be written *after* DOMContentLoaded. Copying cookies and
 * firing the login in that window is exactly how you get a valid token paired with a stale/absent
 * `csrf_token` — a 403 or an instant "you broke Reddit" page.
 *
 * This module gives the solver one deterministic gate:
 *   1. wait for `document.readyState === 'complete'`  (load event, with a hard timeout)
 *   2. wait for the network to go quiet (0 in-flight requests for `quietWindowMs`)
 *   3. optionally run a caller-supplied `isReady()` predicate (form/csrf/grecaptcha present)
 *
 * It never throws for a slow page: it returns a report so the caller can decide to warn, retry or
 * skip. Only a closed/crashed page is an error.
 */

const DEFAULT_OPTIONS = {
  loadTimeoutMs: 20000,
  quietWindowMs: 700,
  quietTimeoutMs: 8000,
  pollMs: 100,
  logger: null,
  label: 'browser',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Track in-flight network requests on a Playwright/Puppeteer page.
 * Attach BEFORE navigating so the very first request is counted.
 *
 * @param {object} page
 * @returns {{inflight:number, started:number, finished:number, failed:number, waitForQuiet:Function, dispose:Function}}
 */
function createNetworkTracker(page) {
  let inflight = 0;
  let started = 0;
  let finished = 0;
  let failed = 0;

  const onStart = () => {
    started += 1;
    inflight += 1;
  };
  const onEnd = () => {
    finished += 1;
    inflight = Math.max(0, inflight - 1);
  };
  const onFail = () => {
    failed += 1;
    inflight = Math.max(0, inflight - 1);
  };

  page.on('request', onStart);
  page.on('requestfinished', onEnd);
  page.on('requestfailed', onFail);

  return {
    get inflight() {
      return inflight;
    },
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
    get failed() {
      return failed;
    },

    /**
     * Resolve once no request has been in flight for `quietWindowMs`, or on timeout.
     * @returns {Promise<{quiet:boolean, inflight:number, waitedMs:number}>}
     */
    async waitForQuiet({ quietWindowMs = DEFAULT_OPTIONS.quietWindowMs, timeoutMs = DEFAULT_OPTIONS.quietTimeoutMs, pollMs = DEFAULT_OPTIONS.pollMs } = {}) {
      const t0 = Date.now();
      let quietSince = inflight === 0 ? Date.now() : null;

      while (Date.now() - t0 < timeoutMs) {
        if (inflight === 0) {
          if (quietSince === null) quietSince = Date.now();
          if (Date.now() - quietSince >= quietWindowMs) {
            return { quiet: true, inflight: 0, waitedMs: Date.now() - t0 };
          }
        } else {
          quietSince = null;
        }
        await sleep(pollMs);
      }
      return { quiet: inflight === 0, inflight, waitedMs: Date.now() - t0 };
    },

    dispose() {
      page.off?.('request', onStart);
      page.off?.('requestfinished', onEnd);
      page.off?.('requestfailed', onFail);
    },
  };
}

/**
 * Wait until `document.readyState === 'complete'`.
 * @returns {Promise<{complete:boolean, readyState:string|null, waitedMs:number}>}
 */
async function waitForDocumentComplete(page, { timeoutMs = DEFAULT_OPTIONS.loadTimeoutMs, pollMs = DEFAULT_OPTIONS.pollMs } = {}) {
  const t0 = Date.now();
  let lastState = null;

  // Fast path: already complete (cached page / about:blank)
  try {
    lastState = await page.evaluate(() => document.readyState).catch(() => null);
    if (lastState === 'complete') return { complete: true, readyState: lastState, waitedMs: 0 };
  } catch {
    /* page may still be navigating */
  }

  // Prefer the engine-native wait (Playwright: waitForLoadState, Puppeteer: waitForNavigation)
  if (typeof page.waitForLoadState === 'function') {
    try {
      await page.waitForLoadState('load', { timeout: timeoutMs });
      lastState = await page.evaluate(() => document.readyState).catch(() => 'complete');
      return { complete: lastState === 'complete', readyState: lastState, waitedMs: Date.now() - t0 };
    } catch {
      /* fall through to polling */
    }
  }

  while (Date.now() - t0 < timeoutMs) {
    try {
      lastState = await page.evaluate(() => document.readyState);
      if (lastState === 'complete') {
        return { complete: true, readyState: lastState, waitedMs: Date.now() - t0 };
      }
    } catch {
      /* navigation in progress - keep polling */
    }
    await sleep(pollMs);
  }
  return { complete: lastState === 'complete', readyState: lastState, waitedMs: Date.now() - t0 };
}

/**
 * The single gate used by the solver before it reads cookies or fires a login.
 *
 * @param {object} page Playwright/Puppeteer page
 * @param {object} [options]
 * @param {number} [options.loadTimeoutMs]
 * @param {number} [options.quietWindowMs]
 * @param {number} [options.quietTimeoutMs]
 * @param {Function} [options.isReady] async () => boolean|{ok:boolean,reason:string} — app-specific check
 * @param {object} [options.tracker] an existing createNetworkTracker() (attach before navigation)
 * @param {object} [options.logger]
 * @param {string} [options.label]
 * @returns {Promise<{ready:boolean, reason:string|null, document:object, network:object, app:object|null, waitedMs:number}>}
 */
async function waitForBrowserReady(page, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const t0 = Date.now();
  const tracker = opts.tracker || createNetworkTracker(page);
  const ownsTracker = !opts.tracker;

  const report = {
    ready: false,
    reason: null,
    document: null,
    network: null,
    app: null,
    waitedMs: 0,
  };

  try {
    // 1) document fully loaded
    report.document = await waitForDocumentComplete(page, { timeoutMs: opts.loadTimeoutMs, pollMs: opts.pollMs });
    if (!report.document.complete) {
      report.reason = `document not complete after ${report.document.waitedMs}ms (readyState=${report.document.readyState})`;
    }

    // 2) network quiet (fonts/chunks/recaptcha anchor done)
    report.network = await tracker.waitForQuiet({
      quietWindowMs: opts.quietWindowMs,
      timeoutMs: opts.quietTimeoutMs,
      pollMs: opts.pollMs,
    });
    if (!report.network.quiet && !report.reason) {
      report.reason = `${report.network.inflight} request(s) still in flight after ${report.network.waitedMs}ms`;
    }

    // 3) caller's own readiness predicate (login form / csrf / grecaptcha)
    if (typeof opts.isReady === 'function') {
      try {
        const verdict = await opts.isReady();
        report.app = typeof verdict === 'boolean' ? { ok: verdict, reason: null } : verdict || { ok: false, reason: 'empty result' };
        if (!report.app.ok && !report.reason) {
          report.reason = `app readiness failed${report.app.reason ? `: ${report.app.reason}` : ''}`;
        }
      } catch (err) {
        report.app = { ok: false, reason: err.message };
        if (!report.reason) report.reason = `app readiness threw: ${err.message}`;
      }
    }

    report.ready = !report.reason;
    report.waitedMs = Date.now() - t0;

    if (opts.logger) {
      const tag = `Ready:${opts.label}`;
      const summary =
        `ready=${report.ready} in ${report.waitedMs}ms (readyState=${report.document?.readyState}, ` +
        `net ${report.network?.finished ?? 0}/${report.network?.started ?? 0} done, quiet=${report.network?.quiet})` +
        (report.reason ? ` — ${report.reason}` : '');
      if (report.ready) opts.logger.debug?.(tag, summary);
      else opts.logger.warn?.(tag, summary);
    }
    return report;
  } finally {
    if (ownsTracker) tracker.dispose();
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  createNetworkTracker,
  waitForDocumentComplete,
  waitForBrowserReady,
};
