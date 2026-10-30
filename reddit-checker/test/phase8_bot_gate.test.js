'use strict';

/**
 * Phase 8 — Reddit "Prove your humanity" bot gate (hermetic).
 *
 * Pins the v2.4.0 guarantees:
 *   1. `detectBotGate()` classifies the whole gate family (humanity / whoa-there / 429 /
 *      generic block) and tells checkbox from invisible widgets.
 *   2. The solver's `isHumanityBlockPage()` still answers the old boolean question.
 *   3. The gate check runs BEFORE the readiness gate in the hybrid browser path and the
 *      checkbox is clicked before any reCAPTCHA token is requested.
 *   4. `resolveBotGate()` clicks "I'm not a robot" and reports clearance honestly, and
 *      reports failure (never a fake success) when the checkbox cannot turn green.
 *   5. `wafError()` produces a `WAF_BLOCKED` error that names the residential-IP requirement.
 *   6. The worker pool retries a gated attempt on a BRAND-NEW lease (new signatureId) and
 *      does not retry ordinary failures.
 *   7. Lease identities are unique: no two attempts ever share a signatureId.
 *
 * No browser binary, no network, no credentials.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ── fake playwright (same trick as phase 6) ───────────────────────────────────
// The pool tests must not need a real browser binary: discovery only checks that the
// path exists, and every "launch" below is an in-memory stub.
function makeFakeBrowser(engine) {
  let connected = true;
  return {
    engine,
    version: () => `999.0.0-fake-${engine}`,
    isConnected: () => connected,
    on() {},
    async newContext() {
      return {
        async addInitScript() {},
        async addCookies() {},
        async newPage() {
          return { isClosed: () => false, close: async () => {} };
        },
        async cookies() {
          return [];
        },
        async close() {},
      };
    },
    async close() {
      connected = false;
    },
  };
}

const fakePlaywright = {};
for (const engine of ['chromium', 'firefox', 'webkit']) {
  fakePlaywright[engine] = {
    executablePath: () => process.execPath,
    async launch() {
      return makeFakeBrowser(engine);
    },
  };
}
try {
  const entry = require.resolve('rebrowser-playwright-core', {
    paths: [path.resolve(__dirname, '..')],
  });
  require.cache[entry] = {
    id: entry,
    filename: entry,
    loaded: true,
    exports: fakePlaywright,
    children: [],
    paths: [],
  };
} catch {
  // Module missing entirely: EnginePoolManager will still construct lazily below.
}
if (!process.env.DISPLAY && process.platform === 'linux') process.env.DISPLAY = ':99';

const {
  detectBotGate,
  detectWidget,
  wafError,
  isWafError,
  clickRecaptchaCheckbox,
  resolveBotGate,
  ProfileLeaseManager,
  RotationWorkerPool,
} = require('../src/rotation');
const { isHumanityBlockPage } = require('../reddit_solver');

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

const HUMANITY_HTML = `<!doctype html><html><head>
<title>Reddit - Prove your humanity</title></head>
<body><h1>Prove your humanity</h1>
<div class="g-recaptcha" data-sitekey="6Lc_XX" data-size="normal"></div>
<iframe src="https://www.google.com/recaptcha/enterprise/anchor?k=6Lc_XX"></iframe>
</body></html>`;

const WHOA_HTML = `<!doctype html><html><head><title>Reddit - Blocked</title></head>
<body><h1>Whoa there, pardner!</h1><p>Your request has been blocked.</p></body></html>`;

const LOGIN_HTML = `<!doctype html><html><head><title>reddit.com: log in</title></head>
<body><faceplate-form id="login" action="/svc/shreddit/account/login">
<input name="username"><input name="password">
<script>grecaptcha.enterprise.execute('k', {action:'login'});</script>
</faceplate-form></body></html>`;

/**
 * Fake gate page: an anchor iframe that may or may not accept the click.
 * `evaluate()` runs the callback with a minimal `document` shim so the real
 * `isCheckboxSolved()` code path (not a mock of it) is exercised.
 */
function makeFakeGatePage({ solveOnClick = true, withAnchorFrame = true } = {}) {
  const dom = { anchorChecked: false, gateBlocked: true, token: '' };

  const fakeDocument = {
    querySelector(sel) {
      if (sel === '#recaptcha-anchor') {
        return {
          getAttribute: (name) => (name === 'aria-checked' ? String(dom.anchorChecked) : null),
          classList: { contains: (c) => c === 'recaptcha-checkbox-checked' && dom.anchorChecked },
          click: () => {
            if (solveOnClick) {
              dom.anchorChecked = true;
              dom.gateBlocked = false;
            }
          },
        };
      }
      if (sel === '#g-recaptcha-response') return { value: dom.token };
      return null;
    },
    cookie: 'csrf_token=abc',
  };

  const handle = {
    click: async () => {
      if (solveOnClick) {
        dom.anchorChecked = true;
        dom.gateBlocked = false;
      }
    },
    boundingBox: async () => ({ x: 8, y: 8, width: 24, height: 24 }),
    dispose: async () => {},
  };

  const frame = {
    url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6Lc_XX',
    $: async (sel) => (sel === '#recaptcha-anchor' ? handle : null),
    waitForSelector: async () => handle,
    click: async () => handle.click(),
    evaluate: async (fn) => {
      globalThis.document = fakeDocument;
      try {
        return await fn();
      } finally {
        delete globalThis.document;
      }
    },
  };

  const page = {
    title: async () => (dom.gateBlocked ? 'Reddit - Prove your humanity' : 'reddit.com: log in'),
    content: async () => (dom.gateBlocked ? HUMANITY_HTML : LOGIN_HTML),
    frames: () => (withAnchorFrame ? [frame] : []),
    url: () => 'https://www.reddit.com/login/',
    mouse: {
      move: async () => {},
      click: async () => handle.click(),
    },
    keyboard: { press: async () => {} },
  };

  return { page, dom };
}

async function run() {
  console.log('\n======================================================================');
  console.log('  PHASE 8 VERIFICATION: BOT GATE DETECTION / CHECKBOX RECOVERY / RETRY');
  console.log('======================================================================\n');

  await check('detects "Prove your humanity" as a checkbox gate', () => {
    const gate = detectBotGate(HUMANITY_HTML, 403);
    assert.strictEqual(gate.blocked, true, 'must be flagged as blocked');
    assert.strictEqual(gate.kind, 'humanity');
    assert.strictEqual(gate.widget, 'checkbox', `expected checkbox widget, got ${gate.widget}`);
    assert.ok(/IP reputation|TLS/.test(gate.hint || ''), 'hint must explain the cause');
  });

  await check('detects "whoa there, pardner" and 429 blocks', () => {
    const whoa = detectBotGate(WHOA_HTML, 403);
    assert.strictEqual(whoa.blocked, true);
    assert.ok(['whoa_there', 'blocked_generic'].includes(whoa.kind), `got ${whoa.kind}`);

    const rate = detectBotGate('<html><body>slow down</body></html>', 429);
    assert.strictEqual(rate.blocked, true);
    assert.strictEqual(rate.kind, 'rate_limited');
  });

  await check('does not flag a normal Shreddit login page', () => {
    const gate = detectBotGate(LOGIN_HTML, 200);
    assert.strictEqual(gate.blocked, false, 'login page must not be treated as a gate');
  });

  await check('separates checkbox from invisible reCAPTCHA widgets', () => {
    assert.strictEqual(detectWidget(HUMANITY_HTML), 'checkbox');
    assert.strictEqual(
      detectWidget('<div class="g-recaptcha" data-sitekey="k" data-size="invisible"></div>'),
      'invisible'
    );
  });

  await check('isHumanityBlockPage() keeps its boolean contract', () => {
    assert.strictEqual(isHumanityBlockPage(HUMANITY_HTML), true);
    assert.strictEqual(isHumanityBlockPage(WHOA_HTML), false);
    assert.strictEqual(isHumanityBlockPage(LOGIN_HTML), false);
    assert.strictEqual(isHumanityBlockPage(''), false);
  });

  await check('wafError() is a WAF_BLOCKED error naming the residential-IP fix', () => {
    const err = wafError({ kind: 'humanity', widget: 'checkbox', detail: 'not cleared' });
    assert.strictEqual(err.code, 'WAF_BLOCKED');
    assert.strictEqual(err.wafKind, 'humanity');
    assert.strictEqual(err.needsResidentialProxy, true);
    assert.ok(/residential/i.test(err.message), 'message must tell the operator to use a home IP');
    assert.strictEqual(isWafError(err), true);
    assert.strictEqual(isWafError(new Error('ECONNRESET')), false);
  });

  await check('clicks the anchor checkbox and reports it solved', async () => {
    const { page } = makeFakeGatePage({ solveOnClick: true });
    const out = await clickRecaptchaCheckbox(page, { timeoutMs: 2500 });
    assert.strictEqual(out.clicked, true, 'must attempt a click');
    assert.strictEqual(out.solved, true, 'aria-checked must flip to true');
    assert.strictEqual(out.reason, null);
  });

  await check('never reports success when the checkbox refuses to turn green', async () => {
    const { page } = makeFakeGatePage({ solveOnClick: false });
    const out = await clickRecaptchaCheckbox(page, { timeoutMs: 600 });
    assert.strictEqual(out.solved, false, 'unsolved checkbox must stay unsolved');
    assert.ok(/did not turn green/i.test(out.reason || ''), `got reason: ${out.reason}`);
  });

  await check('resolveBotGate() clears the page after the checkbox solves', async () => {
    const { page } = makeFakeGatePage({ solveOnClick: true });
    const out = await resolveBotGate(page, { timeoutMs: 2000 });
    assert.strictEqual(out.blocked, true);
    assert.strictEqual(out.cleared, true, 'gate must report clearance');
    assert.strictEqual(out.clicked, true);
  });

  await check('resolveBotGate() fails honestly on an unclickable checkbox', async () => {
    const { page } = makeFakeGatePage({ solveOnClick: false });
    const out = await resolveBotGate(page, { timeoutMs: 600 });
    assert.strictEqual(out.blocked, true);
    assert.strictEqual(out.cleared, false, 'must NOT claim clearance');
    assert.ok(out.reason, 'must explain why');
  });

  await check('resolveBotGate() does nothing on a clean login page', async () => {
    const { page, dom } = makeFakeGatePage();
    dom.gateBlocked = false;
    const out = await resolveBotGate(page, { timeoutMs: 300 });
    assert.strictEqual(out.blocked, false);
    assert.strictEqual(out.cleared, true);
  });

  await check('gate check runs BEFORE the readiness gate in the hybrid browser path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'reddit_solver.js'), 'utf-8');
    const start = src.indexOf('async _getRecaptchaTokenViaHybridPool()');
    assert.ok(start > 0, 'hybrid browser path must exist');
    const gateIdx = src.indexOf('BOT-GATE CHECK', start);
    const readyIdx = src.indexOf('── READINESS GATE', start);
    assert.ok(gateIdx > 0, 'hybrid path must contain the bot-gate check');
    assert.ok(readyIdx > 0, 'hybrid path must contain the readiness gate');
    assert.ok(gateIdx < readyIdx, 'bot gate must be detected before waiting for readiness');
    assert.ok(
      src.includes("isWafError(browserErr)"),
      'auto mode must not fall back to HTTP on a WAF error'
    );
    assert.ok(
      src.includes('--disable-http2'),
      'Chromium launch must be able to drop HTTP/2 (Reddit fingerprints it)'
    );
  });

  await check('pool retries a gated attempt on a fresh identity, then stops', async () => {
    process.env.LOGIN_PACE_MIN_MS = '0';
    process.env.LOGIN_PACE_MAX_MS = '0';
    process.env.WAF_RETRY_ATTEMPTS = '1';

    const seen = [];
    class FakeSolver {
      constructor(opts) {
        this.lease = opts.lease;
        this.opts = opts;
      }
      async fullLogin() {
        seen.push(this.lease.profile.signatureId);
        if (seen.length === 1) {
          throw wafError({ kind: 'humanity', widget: 'checkbox', detail: 'fake gate' });
        }
        return {
          success: true,
          verdict: 'AUTHENTICATED',
          status: 200,
          accountHealth: { healthy: true, username: 'tester', totalKarma: 1 },
          cookies: {},
        };
      }
      async close() {}
    }

    const pool = new RotationWorkerPool({ SolverClass: FakeSolver, concurrency: 1 });
    const reported = [];
    const out = await pool.runAccountBatch(
      [{ username: 'tester', password: 'pw' }],
      { quiet: true, onResult: (r) => reported.push(r) }
    );

    assert.strictEqual(seen.length, 2, `expected exactly 2 attempts, got ${seen.length}`);
    assert.notStrictEqual(seen[0], seen[1], 'the retry must use a DIFFERENT identity');
    assert.strictEqual(reported.length, 1, 'only the final attempt is reported');
    assert.strictEqual(out[0].verdict, 'AUTHENTICATED');
    assert.strictEqual(out[0].attempt, 2, 'attempt counter must reflect the retry');
    await pool.enginePool.shutdown?.().catch?.(() => {});
  });

  await check('pool does NOT retry an ordinary failure', async () => {
    process.env.LOGIN_PACE_MIN_MS = '0';
    process.env.LOGIN_PACE_MAX_MS = '0';
    let calls = 0;
    class FakeSolver {
      async fullLogin() {
        calls += 1;
        throw new Error('ECONNRESET while talking to reddit');
      }
      async close() {}
    }
    const pool = new RotationWorkerPool({ SolverClass: FakeSolver, concurrency: 1 });
    const out = await pool.runAccountBatch([{ username: 'tester2', password: 'pw' }], { quiet: true });
    assert.strictEqual(calls, 1, `a plain network error must not be retried (calls=${calls})`);
    assert.strictEqual(out[0].verdict, 'EXCEPTION');
    await pool.enginePool.shutdown?.().catch?.(() => {});
  });

  await check('no two attempts ever share a lease identity (30 sequential)', async () => {
    const mgr = new ProfileLeaseManager({ mode: 'hybrid' });
    const sigs = [];
    for (let i = 0; i < 30; i += 1) {
      const lease = await mgr.acquireLease({ workerId: `uniq-${i}` });
      sigs.push(lease.profile.signatureId);
      await mgr.releaseLease(lease.leaseId);
    }
    assert.strictEqual(new Set(sigs).size, 30, 'all 30 identities must be unique');
    const stats = await mgr.getStats();
    assert.strictEqual(stats.activeCount, 0, 'no lease may leak');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n  Phase 8: ${results.length - failed.length}/${results.length} passed` +
      (failed.length ? ` — ${failed.length} FAILED` : '')
  );
  if (failed.length) {
    for (const f of failed) console.log(`    - ${f.name}: ${f.err?.message || f.err}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('Phase 8 crashed:', err);
  process.exitCode = 1;
});
