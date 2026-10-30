'use strict';

/**
 * Phase 7 — Browser readiness before the login POST (hermetic, fake page).
 *
 * The login path is: Step 1 (TLS) -> Step 2 (browser token) -> Step 4 (credential POST).
 * If Step 4 fires while the page is still streaming chunks — or before the browser has handed
 * its csrf/session cookies back — the attempt is wasted with a token/csrf mismatch.
 *
 * These checks pin the two guarantees we added:
 *   1. `waitForBrowserReady()` only says ready when document.readyState === 'complete' AND the
 *      network has been quiet for a while AND the caller's own predicate passes.
 *   2. `RedditSolver.login()` calls `ensureLoginSessionReady()` BEFORE it sends the POST, and
 *      `fullLogin()` never submits before a token exists.
 *
 * Everything here is fake: no browser, no network.
 */

const assert = require('assert');
const path = require('path');

const {
  createNetworkTracker,
  waitForBrowserReady,
} = require('../src/rotation');
const { RedditSolver } = require('../reddit_solver');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  [OK]   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  [FAIL] ${name}\n         ${(err.message || String(err)).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal Playwright-shaped page: event emitter + scriptable document.readyState. */
function makeFakePage({ readyState = 'loading', reachesCompleteAfterMs = null } = {}) {
  const handlers = new Map();
  const page = {
    readyState,
    requests: 0,
    evaluateCalls: 0,
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
    },
    off(event, cb) {
      handlers.get(event)?.delete(cb);
    },
    emit(event) {
      for (const cb of handlers.get(event) || []) cb();
    },
    handlerCount() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
    async evaluate(fn) {
      page.evaluateCalls += 1;
      // The real gate only ever asks for document.readyState; anything else is "unknown".
      return String(fn).includes('readyState') ? page.readyState : null;
    },
  };
  if (reachesCompleteAfterMs !== null) {
    setTimeout(() => {
      page.readyState = 'complete';
    }, reachesCompleteAfterMs);
  }
  return page;
}

async function main() {
  console.log('\n==============================================================================');
  console.log('  PHASE 7 TEST SUITE — BROWSER READY GATE BEFORE LOGIN (HERMETIC)');
  console.log('==============================================================================\n');

  await check('network tracker counts in-flight requests and settles when they finish', async () => {
    const page = makeFakePage();
    const tracker = createNetworkTracker(page);
    page.emit('request');
    page.emit('request');
    assert.strictEqual(tracker.inflight, 2);
    page.emit('requestfinished');
    assert.strictEqual(tracker.inflight, 1);
    page.emit('requestfailed');
    assert.strictEqual(tracker.inflight, 0);
    assert.strictEqual(tracker.started, 2);
    assert.strictEqual(tracker.finished, 1);
    assert.strictEqual(tracker.failed, 1);

    const quiet = await tracker.waitForQuiet({ quietWindowMs: 60, timeoutMs: 1000, pollMs: 20 });
    assert.strictEqual(quiet.quiet, true);
    tracker.dispose();
    assert.strictEqual(page.handlerCount(), 0, 'dispose must remove every listener');
  });

  await check('ready=false while document is still loading', async () => {
    const page = makeFakePage({ readyState: 'loading' });
    const report = await waitForBrowserReady(page, {
      loadTimeoutMs: 300,
      quietWindowMs: 40,
      quietTimeoutMs: 200,
      pollMs: 20,
    });
    assert.strictEqual(report.ready, false);
    assert.match(report.reason, /document not complete/);
    assert.ok(report.waitedMs >= 250, 'must actually wait for the timeout');
  });

  await check('ready=true only after load completes AND the network goes quiet', async () => {
    const page = makeFakePage({ readyState: 'loading', reachesCompleteAfterMs: 120 });
    const report = await waitForBrowserReady(page, {
      loadTimeoutMs: 2000,
      quietWindowMs: 80,
      quietTimeoutMs: 1500,
      pollMs: 20,
    });
    assert.strictEqual(report.ready, true, `expected ready, got ${report.reason}`);
    assert.strictEqual(report.document.readyState, 'complete');
    assert.strictEqual(report.network.quiet, true);
    assert.ok(report.waitedMs >= 150, `expected a real wait, got ${report.waitedMs}ms`);
  });

  await check('ready=false when a request never finishes (no early login)', async () => {
    const page = makeFakePage({ readyState: 'complete' });
    const tracker = createNetworkTracker(page);
    page.emit('request'); // hangs forever
    const report = await waitForBrowserReady(page, {
      tracker,
      loadTimeoutMs: 200,
      quietWindowMs: 50,
      quietTimeoutMs: 250,
      pollMs: 20,
    });
    assert.strictEqual(report.ready, false);
    assert.match(report.reason, /in flight/);
    tracker.dispose();
  });

  await check('caller predicate can veto readiness (e.g. no login form / no grecaptcha)', async () => {
    const page = makeFakePage({ readyState: 'complete' });
    const report = await waitForBrowserReady(page, {
      loadTimeoutMs: 200,
      quietWindowMs: 30,
      quietTimeoutMs: 200,
      pollMs: 20,
      isReady: async () => ({ ok: false, reason: 'login form and grecaptcha both missing' }),
    });
    assert.strictEqual(report.ready, false);
    assert.match(report.reason, /app readiness failed/);
    assert.deepStrictEqual(report.app.ok, false);
  });

  await check('ensureLoginSessionReady refreshes the login page when csrf is missing', async () => {
    const solver = new RedditSolver({ mode: 'http', headless: true });
    let getCalls = 0;
    solver.client.get = async () => {
      getCalls += 1;
      solver.client.cookies.loid = 'loid_from_refresh';
      return {
        status: 200,
        headers: {},
        text: '<html><input type="hidden" name="token" value="FORM_CSRF_123" /></html>',
      };
    };

    const state = await solver.ensureLoginSessionReady();
    assert.strictEqual(getCalls, 1, 'must refresh exactly once');
    assert.strictEqual(state.refreshed, true);
    assert.strictEqual(state.csrf, 'FORM_CSRF_123');
    assert.strictEqual(state.ok, true, 'csrf + loid after refresh must count as ready');
  });

  await check('ensureLoginSessionReady is a no-op when the jar is already complete', async () => {
    const solver = new RedditSolver({ mode: 'http', headless: true });
    solver.client.cookies.csrf_token = 'already_here';
    solver.client.cookies.session = 'session_cookie';
    let getCalls = 0;
    solver.client.get = async () => {
      getCalls += 1;
      return { status: 200, headers: {}, text: '' };
    };
    const state = await solver.ensureLoginSessionReady();
    assert.strictEqual(getCalls, 0, 'a complete jar must not trigger another request');
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.refreshed, false);
  });

  await check('ensureLoginSessionReady never throws when the refresh itself fails', async () => {
    const solver = new RedditSolver({ mode: 'http', headless: true });
    solver.client.get = async () => {
      throw new Error('proxy exploded');
    };
    const state = await solver.ensureLoginSessionReady();
    assert.strictEqual(state.ok, false);
    assert.strictEqual(state.refreshed, false);
  });

  await check('login() runs the readiness gate BEFORE it posts credentials', async () => {
    const solver = new RedditSolver({ mode: 'http', headless: true });
    const calls = [];
    solver.ensureLoginSessionReady = async () => {
      calls.push('ready');
      return { ok: true };
    };
    solver.client.cookies.csrf_token = 'csrf';
    solver.client.post = async () => {
      calls.push('post');
      return { status: 200, headers: {}, text: '<html>ok</html>' };
    };
    await solver.login('some_user', 'some_pass', 'TOKEN_ABC');
    assert.deepStrictEqual(calls, ['ready', 'post'], `expected ready before post, got ${calls.join(' -> ')}`);
  });

  await check('fullLogin() never submits before a reCAPTCHA token exists', async () => {
    const solver = new RedditSolver({ mode: 'http', headless: true });
    const order = [];
    solver.solveJsChallenge = async () => order.push('step1-js');
    solver.acquireRecaptchaToken = async () => {
      order.push('step2-token');
      return { recaptchaToken: null, method: 'fake' }; // simulate a dead captcha
    };
    solver.login = async () => {
      order.push('step4-login');
      return { success: true, status: 200, verdict: 'SUCCESS' };
    };

    const res = await solver.fullLogin('user', 'pass', { quiet: true });
    assert.deepStrictEqual(order, ['step1-js', 'step2-token'], 'login must not run without a token');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.verdict, 'NO_RECAPTCHA_TOKEN');
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n==============================================================================');
  if (failed.length) {
    console.log(`  ${failed.length}/${results.length} PHASE 7 CHECKS FAILED`);
    for (const f of failed) console.log(`   - ${f.name}: ${f.err.stack.split('\n')[0]}`);
    console.log('==============================================================================\n');
    process.exit(1);
  }
  console.log(`  ALL PHASE 7 READINESS CHECKS PASSED (${results.length}/${results.length})`);
  console.log('==============================================================================\n');
}

main().catch((err) => {
  console.error(`\n[PHASE 7 FATAL] ${err.stack || err.message}\n`);
  process.exit(1);
});
