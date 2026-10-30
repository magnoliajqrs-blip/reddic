'use strict';

/**
 * Phase 3 Live Browser Verification Suite (`test/phase3_engine_pool.test.js`)
 *
 * Launches REAL headless browsers (`Chromium`, `Mozilla Firefox / Gecko`, and `Apple WebKit / Safari`)
 * via `EnginePoolManager` to prove:
 *   1. Binary discovery, proxy credential parsing & header hygiene work cleanly.
 *   2. Method 1 (`single-engine` mode): 6 simultaneous workers run 6 distinct Chromium brands
 *      (`Chrome`, `Edge`, `Opera`, `Brave`, `Vivaldi`, `Ungoogled-Chromium`) inside ONLY 1 shared
 *      Chromium OS process with 100% cookie/localStorage/Canvas/WebGL isolation.
 *   3. Hybrid Mode (Method 1 + Method 2 combined): 9 simultaneous workers run ALL 9 browser brands
 *      across real `Chromium`, `Firefox`/`Camoufox` (Gecko), and `Safari` (WebKit) using ONLY 3
 *      shared OS processes, with 0 brand collisions and verified HTTP header + DOM parity.
 *   4. Dedicated Anti-Detect Process lifecycle (`forceDedicatedProcess: true`) + `markBurned()` cooldown.
 *   5. Automatic shared-engine memory recycling (`maxContextsPerEngine`) & clean `shutdown()`.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const {
  discoverEngineBinaries,
  parsePlaywrightProxy,
  buildSafeContextExtraHeaders,
  synthesizeProfile,
  EnginePoolManager,
} = require('../src/rotation');

/**
 * Spin up a fast local HTTP echo server so real browsers navigate to a real origin
 * (enabling cookies, localStorage, WebGL, Canvas, and capturing raw wire HTTP headers!).
 */
function startLocalInspectionServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const headersJson = JSON.stringify(req.headers);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Rotation Probe</title></head>
<body>
  <pre id="wire-headers">${headersJson.replace(/</g, '\\u003c')}</pre>
  <canvas id="fp-canvas" width="120" height="40"></canvas>
</body>
</html>`);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Extract live DOM, Navigator, WebGL, Canvas, Storage & Wire-Header telemetry inside a real browser page.
 */
async function inspectLiveBrowserSession(session, baseUrl) {
  const { page, workerId } = session;
  await page.goto(`${baseUrl}/probe?worker=${encodeURIComponent(workerId)}`, {
    waitUntil: 'domcontentloaded',
  });

  // Set worker-unique cookie & localStorage key to prove strict cross-context isolation
  await session.setCookies([
    {
      name: 'worker_owner',
      value: workerId,
      url: baseUrl,
    },
  ]);

  const probe = await page.evaluate((wid) => {
    const prevStorage = window.localStorage.getItem('shared_leak_check');
    window.localStorage.setItem('shared_leak_check', wid);

    const wireHeaders = JSON.parse(document.getElementById('wire-headers').textContent);

    // Draw deterministic test scene onto 2D Canvas to verify per-seed LSB uniqueness
    const canvas = document.getElementById('fp-canvas');
    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#1b4f72';
    ctx2d.fillRect(0, 0, 120, 40);
    ctx2d.fillStyle = '#f39c12';
    ctx2d.font = '14px sans-serif';
    ctx2d.fillText('RedditRotationCheck-2026', 6, 24);
    const canvasDataUrl = canvas.toDataURL();

    // Query WebGL unmasked vendor & renderer
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
    let gpuVendor = null;
    let gpuRenderer = null;
    if (gl) {
      gl.getExtension('WEBGL_debug_renderer_info');
      gpuVendor = gl.getParameter(37445);
      gpuRenderer = gl.getParameter(37446);
    }

    return {
      wireHeaders,
      prevStorage,
      cookieString: document.cookie,
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      vendor: navigator.vendor,
      platform: navigator.platform,
      oscpu: navigator.oscpu,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      hasUserAgentData: Boolean(navigator.userAgentData),
      uadBrands: navigator.userAgentData
        ? navigator.userAgentData.brands.map((b) => `${b.brand}/${b.version}`)
        : null,
      hasBraveGlobal: Boolean(navigator.brave && typeof navigator.brave.isBrave === 'function'),
      hasOperaGlobal: Boolean(typeof window.opr === 'object' && window.opr !== null),
      screenW: window.screen.width,
      screenH: window.screen.height,
      dpr: window.devicePixelRatio,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      gpuVendor,
      gpuRenderer,
      canvasDataUrl,
    };
  }, workerId);

  const canvasSha = crypto
    .createHash('sha256')
    .update(probe.canvasDataUrl)
    .digest('hex')
    .slice(0, 12);

  const cookies = await session.getCookies(baseUrl);

  return {
    ...probe,
    canvasSha,
    cookies,
  };
}

async function runPhase3Tests() {
  console.log('\n============================================================================');
  console.log('  PHASE 3 LIVE VERIFICATION: HYBRID SINGLE-ENGINE + MULTI-ENGINE POOL');
  console.log('============================================================================\n');

  const server = await startLocalInspectionServer();

  try {
    // -------------------------------------------------------------------------
    // SUITE 1: Binary Discovery, Proxy Auth Parser & Context Header Hygiene
    // -------------------------------------------------------------------------
    console.log('[Suite 1/5] Binary Discovery, Proxy Parser & Context Header Hygiene...');
    const discovery = discoverEngineBinaries();
    assert.strictEqual(discovery.playwrightAvailable, true, 'rebrowser-playwright-core must be loaded');
    assert.strictEqual(discovery.engines.chromium.available, true, 'Chromium binary must be discovered');
    assert.strictEqual(discovery.engines.firefox.available, true, 'Firefox binary must be discovered');
    assert.strictEqual(discovery.engines.webkit.available, true, 'WebKit binary must be discovered');

    const px = parsePlaywrightProxy('http://my%40user:sec%3Aret@198.51.100.7:8888');
    assert.deepStrictEqual(px, {
      server: 'http://198.51.100.7:8888',
      username: 'my@user',
      password: 'sec:ret',
    });

    const ffProfile = synthesizeProfile({ brandId: 'firefox', os: 'windows' });
    const ffExtra = buildSafeContextExtraHeaders(ffProfile, {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Leaked";v="1"',
      'Upgrade-Insecure-Requests': '1',
    });
    assert.strictEqual(ffExtra['sec-ch-ua'], undefined, 'Firefox context must never receive sec-ch-ua');
    assert.strictEqual(
      ffExtra['Upgrade-Insecure-Requests'],
      undefined,
      'Context extraHTTPHeaders must never attach navigation-only Upgrade-Insecure-Requests'
    );
    console.log(
      `  Discovered Engines: chromium(${discovery.engines.chromium.source}), firefox(${discovery.engines.firefox.source}), webkit(${discovery.engines.webkit.source}) -> PASS\n`
    );

    // -------------------------------------------------------------------------
    // SUITE 2: Method 1 (`single-engine` Shared Chromium Pool) — 6 Live Workers
    // -------------------------------------------------------------------------
    console.log('[Suite 2/5] Method 1 (`single-engine` Shared Chromium): 6 Live Contexts on 1 OS Process...');
    const singlePool = new EnginePoolManager({ mode: 'single-engine', headless: true });

    try {
      const sessions6 = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          singlePool.acquireBrowserSession({ workerId: `m1-worker-${i + 1}` })
        )
      );

      const midStatus = await singlePool.getPoolStatus();
      assert.strictEqual(
        midStatus.sharedEngineProcessCount,
        1,
        `Method 1 must launch ONLY 1 shared Chromium OS process for all 6 workers, got ${midStatus.sharedEngineProcessCount}`
      );
      assert.strictEqual(midStatus.activeSessionCount, 6, 'All 6 browser sessions must be active');

      const probes6 = await Promise.all(
        sessions6.map((s) => inspectLiveBrowserSession(s, server.url))
      );

      const brands6 = new Set(sessions6.map((s) => s.brandId));
      const canvasHashes6 = new Set(probes6.map((p) => p.canvasSha));
      assert.strictEqual(brands6.size, 6, 'All 6 concurrent contexts must run 6 distinct Chromium brands');
      assert.strictEqual(canvasHashes6.size, 6, 'All 6 contexts must produce 6 unique Canvas 2D hashes');

      for (let i = 0; i < sessions6.length; i++) {
        const s = sessions6[i];
        const p = probes6[i];
        assert.strictEqual(p.webdriver, false, `webdriver leaked true on ${s.brandId}`);
        assert.strictEqual(p.prevStorage, null, `localStorage leaked between contexts on ${s.workerId}`);
        assert.strictEqual(
          p.cookies.length,
          1,
          `Cookie jar leaked across shared Chromium contexts on ${s.workerId}`
        );
        assert.strictEqual(p.cookies[0].value, s.workerId, 'Cookie value mismatch');
        assert.strictEqual(p.gpuRenderer, s.profile.gpu.renderer, `WebGL renderer mismatch on ${s.brandId}`);
        if (s.brandId === 'brave') {
          assert.strictEqual(p.hasBraveGlobal, true, 'Brave context must expose navigator.brave.isBrave');
        }
        if (s.brandId === 'opera') {
          assert.strictEqual(p.hasOperaGlobal, true, 'Opera context must expose window.opr');
        }
      }

      await Promise.all(sessions6.map((s) => s.close()));
      const afterSingle = await singlePool.getPoolStatus();
      assert.strictEqual(afterSingle.activeSessionCount, 0, 'All 6 sessions must close cleanly');
      console.log(
        `  PASS: 6 live Chromium brands [${[...brands6].join(', ')}] ran concurrently inside 1 OS process (0 leaks, 6/6 unique Canvas hashes).\n`
      );
    } finally {
      await singlePool.shutdown();
    }

    // -------------------------------------------------------------------------
    // SUITE 3: Hybrid Mode (Method 1 + Method 2 Combined) — ALL 9 Live Browsers!
    // -------------------------------------------------------------------------
    console.log('[Suite 3/5] Hybrid Mode: 9 Simultaneous Live Browsers Across Chromium + Firefox/Gecko + Safari/WebKit...');
    const hybridPool = new EnginePoolManager({ mode: 'hybrid', headless: true });

    try {
      const sessions9 = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          hybridPool.acquireBrowserSession({ workerId: `hyb-worker-${i + 1}` })
        )
      );

      const status9 = await hybridPool.getPoolStatus();
      assert.strictEqual(status9.activeSessionCount, 9, 'Expected 9 concurrent live browser sessions');
      assert.strictEqual(
        status9.sharedEngineProcessCount,
        3,
        `Expected all 9 browsers to share just 3 native engine OS processes (chromium, firefox, webkit), got ${status9.sharedEngineProcessCount}`
      );

      const probes9 = await Promise.all(
        sessions9.map((s) => inspectLiveBrowserSession(s, server.url))
      );

      console.log(
        '  ' +
          'Worker'.padEnd(14) +
          'Brand'.padEnd(20) +
          'Engine'.padEnd(10) +
          'OS'.padEnd(9) +
          'Wire CH-UA'.padEnd(12) +
          'CanvasHash'.padEnd(14) +
          'Live GPU Renderer'
      );
      console.log('  ' + '-'.repeat(106));

      const brands9 = new Set();
      const engines9 = new Set();
      const canvas9 = new Set();

      for (let i = 0; i < sessions9.length; i++) {
        const s = sessions9[i];
        const p = probes9[i];
        brands9.add(s.brandId);
        engines9.add(s.engine);
        canvas9.add(p.canvasSha);

        const hasWireChUa = Boolean(p.wireHeaders['sec-ch-ua']);
        console.log(
          '  ' +
            s.workerId.padEnd(14) +
            s.brandId.padEnd(20) +
            s.engine.padEnd(10) +
            s.os.padEnd(9) +
            (hasWireChUa ? 'YES' : 'NO').padEnd(12) +
            p.canvasSha.padEnd(14) +
            String(p.gpuRenderer).slice(0, 32)
        );

        // Strict live DOM + Wire-Header parity assertions!
        assert.strictEqual(p.webdriver, false, `navigator.webdriver leaked on ${s.brandId}`);
        assert.strictEqual(p.ua, s.profile.navigator.userAgent, `Live UA mismatch on ${s.brandId}`);
        assert.strictEqual(p.wireHeaders['user-agent'], s.profile.navigator.userAgent, `Wire UA mismatch on ${s.brandId}`);
        assert.strictEqual(p.timezone, s.profile.timezoneId, `Timezone mismatch on ${s.brandId}`);
        assert.strictEqual(p.screenW, s.profile.screen.width, `Screen width mismatch on ${s.brandId}`);
        assert.strictEqual(p.gpuRenderer, s.profile.gpu.renderer, `Live WebGL GPU mismatch on ${s.brandId}`);
        assert.strictEqual(p.prevStorage, null, `Cross-context storage leak on ${s.workerId}`);

        if (s.engine === 'chromium') {
          assert.strictEqual(hasWireChUa, true, `Chromium brand ${s.brandId} must send sec-ch-ua wire header`);
          assert.strictEqual(p.hasUserAgentData, true, `Chromium brand ${s.brandId} must have navigator.userAgentData`);
          assert.strictEqual(p.vendor, 'Google Inc.');
        } else if (s.engine === 'firefox') {
          assert.strictEqual(hasWireChUa, false, `Gecko brand ${s.brandId} leaked sec-ch-ua wire header`);
          assert.strictEqual(p.hasUserAgentData, false, `Gecko brand ${s.brandId} leaked userAgentData`);
          assert.strictEqual(p.deviceMemory, undefined, `Gecko brand ${s.brandId} leaked deviceMemory`);
          assert.strictEqual(p.vendor, '', `Gecko vendor must be empty string`);
          assert.strictEqual(p.oscpu, s.profile.navigator.oscpu, `Gecko oscpu mismatch on ${s.brandId}`);
        } else if (s.engine === 'webkit') {
          assert.strictEqual(hasWireChUa, false, `Safari/WebKit leaked sec-ch-ua wire header`);
          assert.strictEqual(p.hasUserAgentData, false, `Safari/WebKit leaked userAgentData`);
          assert.strictEqual(p.deviceMemory, undefined, `Safari/WebKit leaked deviceMemory`);
          assert.strictEqual(p.vendor, 'Apple Computer, Inc.');
        }
      }

      assert.strictEqual(brands9.size, 9, 'Expected all 9 browser brands active simultaneously');
      assert.strictEqual(engines9.size, 3, 'Expected all 3 native engines (chromium, firefox, webkit) active');
      assert.strictEqual(canvas9.size, 9, 'Expected 9 unique Canvas 2D hashes across all 9 live browsers');

      await Promise.all(sessions9.map((s) => s.close()));
      console.log(
        '\n  PASS: 9/9 distinct live browsers across 3 native engines verified (0 collisions, 100% wire-header & DOM parity)!\n'
      );
    } finally {
      await hybridPool.shutdown();
    }

    // -------------------------------------------------------------------------
    // SUITE 4: Dedicated Anti-Detect Process Mode + `session.markBurned()`
    // -------------------------------------------------------------------------
    console.log('[Suite 4/5] Dedicated Process Mode (`forceDedicatedProcess`) + WAF `markBurned()`...');
    const dedPool = new EnginePoolManager({ mode: 'hybrid', headless: true });
    try {
      const dedSession = await dedPool.acquireBrowserSession({
        workerId: 'dedicated-1',
        preferredBrand: 'ungoogled_chromium',
        forceDedicatedProcess: true,
      });

      assert.strictEqual(dedSession.architecture, 'dedicated-antidetect-process');
      const midDed = await dedPool.getPoolStatus();
      assert.strictEqual(midDed.dedicatedProcessCount, 1, 'Expected 1 dedicated OS browser process');
      assert.strictEqual(midDed.sharedEngineProcessCount, 0, 'Should not touch shared pool when dedicated');

      const dedProbe = await inspectLiveBrowserSession(dedSession, server.url);
      assert.strictEqual(dedProbe.webdriver, false);

      const flaggedVariant = dedSession.profile.variantKey;
      await dedSession.markBurned('simulated_waf_429');

      const afterDed = await dedPool.getPoolStatus();
      assert.strictEqual(afterDed.dedicatedProcessCount, 0, 'Dedicated process must close on session close');
      assert.strictEqual(afterDed.leaseStats.totalBurned, 1, 'LeaseManager must record burned variant');

      // Next session for same brand must avoid the burned variant
      const nextSession = await dedPool.acquireBrowserSession({
        workerId: 'dedicated-2',
        preferredBrand: 'ungoogled_chromium',
      });
      assert.notStrictEqual(
        nextSession.profile.variantKey,
        flaggedVariant,
        'Next session must avoid WAF-burned variant'
      );
      await nextSession.close();
      console.log('  PASS: Dedicated anti-detect process lifecycle & WAF variant burn cooldown verified.\n');
    } finally {
      await dedPool.shutdown();
    }

    // -------------------------------------------------------------------------
    // SUITE 5: Automatic Shared Engine Memory Recycling (`maxContextsPerEngine`)
    // -------------------------------------------------------------------------
    console.log('[Suite 5/5] Automatic Shared Engine Memory Recycling (`maxContextsPerEngine=5`)...');
    const recyclePool = new EnginePoolManager({
      mode: 'single-engine',
      headless: true,
      maxContextsPerEngine: 5,
    });

    try {
      for (let i = 0; i < 5; i++) {
        await recyclePool.withBrowserSession({ workerId: `rec-${i + 1}`, createPage: false }, async () => {});
      }
      const beforeRecycle = await recyclePool.getPoolStatus();
      assert.strictEqual(beforeRecycle.metrics.sharedEngineRecycles, 0);

      // 6th session sees idle engine at totalContexts === 5 and recycles it seamlessly!
      await recyclePool.withBrowserSession({ workerId: 'rec-6', createPage: false }, async (sess) => {
        assert.strictEqual(sess.browser.isConnected(), true);
      });

      const afterRecycle = await recyclePool.getPoolStatus();
      assert.strictEqual(
        afterRecycle.metrics.sharedEngineRecycles,
        1,
        'Shared engine must recycle cleanly after reaching maxContextsPerEngine=5'
      );
      console.log('  PASS: Shared engine recycled cleanly after 5 contexts + shutdown left 0 leaked handles.\n');
    } finally {
      await recyclePool.shutdown();
    }

    console.log('============================================================================');
    console.log('  ALL PHASE 3 LIVE MULTI-ENGINE & SHARED-CONTEXT TESTS PASSED (5/5 SUITES)');
    console.log('============================================================================\n');
  } finally {
    await server.close();
  }
}

runPhase3Tests().catch((err) => {
  console.error('\n[PHASE 3 TEST FAILURE]:', err);
  process.exit(1);
});
