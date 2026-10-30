'use strict';

/**
 * Phase 6 — Browser launch contract (hermetic, no real browser needed).
 *
 * Phase 3 launches real Chromium/Firefox/WebKit, so it can only run on a machine where
 * `npm run setup:browsers` has succeeded. That left the most fragile part of the stack —
 * launch args, context options, window handling, engine recycling, shutdown — completely
 * untested on a fresh clone. This suite fakes `rebrowser-playwright-core` and asserts the
 * contract EnginePoolManager relies on:
 *
 *   1. Discovery reports a source + executable for every engine.
 *   2. Chromium launch args are sane and never contain the dead `--start-minimized` flag.
 *   3. BROWSER_MINIMIZED actually minimises (through CDP), and only when headed.
 *   4. Each context gets its own UA / locale / timezone / proxy and the stealth init script.
 *   5. maxContextsPerEngine recycles the shared process instead of leaking it.
 *   6. shutdown() closes shared + dedicated browsers and never throws.
 */

const assert = require('assert');
const path = require('path');

// ── fake playwright, injected before src/rotation is loaded ───────────────────
const launches = [];

function makeBrowser(engine) {
  const ctxs = [];
  let connected = true;
  const browser = {
    engine,
    opts: null,
    contexts: ctxs,
    minimizeCalls: [],
    version: () => `999.0.0-fake-${engine}`,
    isConnected: () => connected,
    on(event, cb) {
      if (event === 'disconnected') browser._onDisconnected = cb;
    },
    async newContext(contextOptions) {
      const ctx = {
        opts: contextOptions,
        initScripts: [],
        cookieJar: [],
        closed: false,
        async addInitScript(script) {
          ctx.initScripts.push(script);
        },
        async addCookies(cookies) {
          ctx.cookieJar.push(...cookies);
        },
        async newPage() {
          return { isClosed: () => false, close: async () => {} };
        },
        async cookies() {
          return ctx.cookieJar;
        },
        async close() {
          ctx.closed = true;
        },
      };
      ctxs.push(ctx);
      return ctx;
    },
    async newBrowserCDPSession() {
      return {
        async send(method, params) {
          if (method === 'Target.getTargets') {
            return { targetInfos: [{ type: 'page', targetId: 'T1' }] };
          }
          if (method === 'Browser.getWindowForTarget') return { windowId: 4242 };
          if (method === 'Browser.setWindowBounds') {
            browser.minimizeCalls.push(params);
            return {};
          }
          return {};
        },
        async detach() {},
      };
    },
    async close() {
      connected = false;
    },
  };
  return browser;
}

const fakePlaywright = {};
for (const engine of ['chromium', 'firefox', 'webkit']) {
  fakePlaywright[engine] = {
    executablePath: () => process.execPath, // any real file: discovery only checks existence
    async launch(opts) {
      const b = makeBrowser(engine);
      b.opts = opts;
      launches.push(b);
      return b;
    },
  };
}

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

// Headed launches are refused on a Linux box without $DISPLAY (by design). These checks are
// about launch *construction*, so pretend we have a desktop; no window is ever really opened.
if (!process.env.DISPLAY && process.platform === 'linux') process.env.DISPLAY = ':99';

const {
  EnginePoolManager,
  discoverEngineBinaries,
  resolveEffectiveHeadless,
} = require('../src/rotation');

const checks = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, ok: true });
      console.log(`  [OK]   ${name}`);
    })
    .catch((err) => {
      checks.push({ name, ok: false, err });
      console.log(`  [FAIL] ${name}\n         ${err.message.split('\n')[0]}`);
    });
}

async function main() {
  console.log('\n==============================================================================');
  console.log('  PHASE 6 TEST SUITE — BROWSER LAUNCH CONTRACT (HERMETIC, FAKE PLAYWRIGHT)');
  console.log('==============================================================================\n');

  await check('discovery finds every engine and records its source', () => {
    const d = discoverEngineBinaries();
    for (const engine of ['chromium', 'firefox', 'webkit']) {
      assert.strictEqual(d.engines[engine].available, true, `${engine} should be available`);
      assert.strictEqual(d.engines[engine].executablePath, process.execPath);
      assert.strictEqual(d.engines[engine].source, 'rebrowser-playwright-core');
    }
  });

  await check('headed chromium launches without the dead --start-minimized flag', async () => {
    launches.length = 0;
    const pool = new EnginePoolManager({ mode: 'single-engine', headless: false, minimizeWindow: false });
    const session = await pool.acquireBrowserSession({ workerId: 'p6-args' });
    const b = launches.at(-1);
    assert.ok(b.opts.args.includes('--no-sandbox'), 'chromium args must include --no-sandbox');
    assert.ok(!b.opts.args.includes('--start-minimized'), '--start-minimized is not a Chromium switch');
    assert.strictEqual(b.opts.headless, false, 'headed launch must keep headless=false');
    assert.ok(b.opts.executablePath, 'executablePath must be forwarded');
    assert.strictEqual(b.minimizeCalls.length, 0, 'minimizeWindow=false must not touch the window');
    await session.close();
    await pool.shutdown();
  });

  await check('BROWSER_MINIMIZED minimises the real window through CDP', async () => {
    launches.length = 0;
    const pool = new EnginePoolManager({ mode: 'single-engine', headless: false, minimizeWindow: true });
    const session = await pool.acquireBrowserSession({ workerId: 'p6-min' });
    const b = launches.at(-1);
    assert.strictEqual(b.minimizeCalls.length, 1, 'exactly one minimize call per new page');
    assert.deepStrictEqual(b.minimizeCalls[0].bounds, { windowState: 'minimized' });
    assert.strictEqual(b.minimizeCalls[0].windowId, 4242);
    await session.close();
    await pool.shutdown();
  });

  await check('headless mode never tries to minimise (no X11/CDP window)', async () => {
    launches.length = 0;
    const pool = new EnginePoolManager({ mode: 'single-engine', headless: true, minimizeWindow: true });
    const session = await pool.acquireBrowserSession({ workerId: 'p6-headless' });
    assert.strictEqual(launches.at(-1).minimizeCalls.length, 0);
    await session.close();
    await pool.shutdown();
  });

  await check('each context gets its own UA, locale, timezone, proxy and init script', async () => {
    launches.length = 0;
    const pool = new EnginePoolManager({ mode: 'hybrid', headless: true });
    const session = await pool.acquireBrowserSession({
      workerId: 'p6-context',
      proxyOverride: 'http://user:pass@198.51.100.9:3128',
    });
    const ctx = launches.at(-1).contexts.at(-1);
    assert.ok(ctx.opts.userAgent && ctx.opts.userAgent.length > 20, 'userAgent missing');
    assert.ok(ctx.opts.locale, 'locale missing');
    assert.ok(ctx.opts.timezoneId, 'timezoneId missing');
    assert.ok(ctx.opts.viewport && ctx.opts.viewport.width > 0, 'viewport missing');
    assert.ok(ctx.opts.screen && ctx.opts.screen.width > 0, 'screen missing');
    assert.deepStrictEqual(ctx.opts.proxy, {
      server: 'http://198.51.100.9:3128',
      username: 'user',
      password: 'pass',
    });
    assert.strictEqual(ctx.initScripts.length, 1, 'stealth init script must be injected once');

    // Firefox leaks sec-ch-ua unless the header builder strips it
    if (session.profile.engine === 'firefox') {
      assert.strictEqual(ctx.opts.extraHTTPHeaders['sec-ch-ua'], undefined);
    }
    await session.setCookies([{ name: 'a', value: 'b', domain: '.reddit.com', path: '/' }]);
    assert.strictEqual((await session.getCookies()).length, 1, 'cookie seeding into the context failed');
    await session.close();
    await pool.shutdown();
  });

  await check('maxContextsPerEngine recycles the shared process instead of leaking it', async () => {
    launches.length = 0;
    const pool = new EnginePoolManager({
      mode: 'single-engine',
      headless: true,
      maxContextsPerEngine: 5,
    });
    for (let i = 0; i < 5; i += 1) {
      const s = await pool.acquireBrowserSession({ workerId: `p6-recycle-${i}` });
      await s.close();
    }
    assert.strictEqual(launches.length, 1, 'the 5 sessions should share one process');
    const sixth = await pool.acquireBrowserSession({ workerId: 'p6-recycle-5' });
    assert.strictEqual(launches.length, 2, 'the 6th session should trigger a fresh launch');
    assert.strictEqual((await pool.getPoolStatus()).metrics.sharedEngineRecycles, 1);
    await sixth.close();
    await pool.shutdown();
  });

  await check('shutdown() closes every browser and is idempotent', async () => {
    launches.length = 0;
    const pool = new EnginePoolManager({ mode: 'hybrid', headless: true });
    const a = await pool.acquireBrowserSession({ workerId: 'p6-shutdown-a' });
    const b = await pool.acquireBrowserSession({ workerId: 'p6-shutdown-b' });
    await pool.shutdown();
    assert.strictEqual(a.browser.isConnected() || b.browser.isConnected(), false, 'browsers still connected');
    await pool.shutdown(); // must not throw
  });

  await check('resolveEffectiveHeadless respects explicit flags and headless Linux', () => {
    assert.strictEqual(resolveEffectiveHeadless(true, {}), true);
    assert.strictEqual(resolveEffectiveHeadless(false, { DISPLAY: ':0' }), false);
    assert.strictEqual(resolveEffectiveHeadless(false, {}), process.platform === 'linux' ? true : false);
    assert.strictEqual(resolveEffectiveHeadless(false, { FORCE_HEADED: '1' }), false);
    assert.strictEqual(resolveEffectiveHeadless(undefined, { HEADLESS: 'false', DISPLAY: ':0' }), false);
    assert.strictEqual(resolveEffectiveHeadless(undefined, { HEADLESS: '1' }), true);
  });

  const failed = checks.filter((c) => !c.ok);
  console.log('\n==============================================================================');
  if (failed.length) {
    console.log(`  ${failed.length}/${checks.length} PHASE 6 CHECKS FAILED`);
    for (const f of failed) console.log(`   - ${f.name}: ${f.err.stack.split('\n')[0]}`);
    console.log('==============================================================================\n');
    process.exit(1);
  }
  console.log(`  ALL PHASE 6 BROWSER-LAUNCH CHECKS PASSED (${checks.length}/${checks.length})`);
  console.log('==============================================================================\n');
}

main().catch((err) => {
  console.error(`\n[PHASE 6 FATAL] ${err.stack || err.message}\n`);
  process.exit(1);
});
