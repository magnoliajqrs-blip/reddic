'use strict';

/**
 * Phase 4 End-to-End Integration Test Suite (`test/phase4_solver_rotation.test.js`)
 *
 * Verifies:
 *   1. Standalone `new RedditSolver()` auto-leases distinct browsers across concurrent & sequential runs,
 *      aligns `TlsHttpClient` (`firefox_*`, `safari_*`, `chrome_*`, `opera_*`) with exact engine headers,
 *      and releases leases cleanly on `solver.close()`.
 *   2. `RotationWorkerPool.runAccountBatch()` executes 9 parallel account workers with 9/9 DISTINCT
 *      browser brands, and automatically burns/cooldowns variants that return `WAF_BLOCKED` / HTTP 429.
 *   3. `RotationWorkerPool.verifyLiveRotation()` executes live multi-engine browser contexts + live
 *      Reddit `/login/` TLS handshakes with zero collisions.
 *   4. Live Multi-Engine `RedditSolver` BotGuard test (`Brave` / `Camoufox` / `Safari` -> live Reddit JS
 *      challenge + reCAPTCHA Enterprise token acquisition).
 */

const assert = require('assert');
const { initTLS, destroyTLS } = require('node-tls-client');
const {
  RedditSolver,
  RotationWorkerPool,
  ProfileLeaseManager,
  buildBrowserHeaders,
} = require('../reddit_solver');

async function runPhase4Tests() {
  console.log('\n============================================================================');
  console.log('  PHASE 4 VERIFICATION: SOLVER INTEGRATION, WORKER POOL & LIVE BOTGUARD');
  console.log('============================================================================\n');

  await initTLS();
  try {
    // -------------------------------------------------------------------------
    // SUITE 1: Standalone `RedditSolver` Auto-Lease & Engine-Exact Header Parity
    // -------------------------------------------------------------------------
    console.log('[Suite 1/4] Standalone `RedditSolver` Concurrent Auto-Rotation & Header Parity...');
    const customLeaseMgr = new ProfileLeaseManager({ mode: 'hybrid' });

    const solvers = Array.from(
      { length: 6 },
      () => new RedditSolver({ rotationMode: 'hybrid', leaseManager: customLeaseMgr })
    );

    await Promise.all(solvers.map((s) => s.ensureProfileLease()));

    const leasedBrands = new Set(solvers.map((s) => s.profile.brandId));
    assert.strictEqual(
      leasedBrands.size,
      6,
      `Expected 6 concurrent RedditSolver instances to auto-lease 6 distinct brands, got ${leasedBrands.size}`
    );

    for (const s of solvers) {
      const h2 = buildBrowserHeaders(s.profile, { http1: false });
      assert.strictEqual('Connection' in h2, false, 'HTTP/2 headers must never contain Connection');
      if (s.profile.engine === 'chromium') {
        assert.strictEqual(Boolean(h2['sec-ch-ua']), true, `Chromium solver ${s.profile.brandId} must send sec-ch-ua`);
      } else {
        assert.strictEqual('sec-ch-ua' in h2, false, `Non-Chromium solver ${s.profile.brandId} must NOT send sec-ch-ua`);
      }
    }

    const midStats = await customLeaseMgr.getStats();
    assert.strictEqual(midStats.activeCount, 6, 'All 6 solver leases must be active before close()');

    await Promise.all(solvers.map((s) => s.close()));
    const postStats = await customLeaseMgr.getStats();
    assert.strictEqual(postStats.activeCount, 0, 'All 6 solver leases must release on solver.close()');
    console.log(`  PASS: 6 standalone RedditSolvers auto-leased [${[...leasedBrands].join(', ')}] and released cleanly.\n`);

    // -------------------------------------------------------------------------
    // SUITE 2: `RotationWorkerPool.runAccountBatch()` — 9 Concurrent Workers + 429 Burn
    // -------------------------------------------------------------------------
    console.log('[Suite 2/4] `RotationWorkerPool.runAccountBatch()` (9 Concurrent Workers + WAF Burn)...');

    // Controlled mock solver that holds each worker active for 80ms so all 9 overlap simultaneously
    class MockBatchSolver {
      constructor({ lease }) {
        this.lease = lease;
      }
      async fullLogin(username) {
        await new Promise((r) => setTimeout(r, 80));
        if (username === 'rate_limited_user') {
          return {
            success: false,
            status: 429,
            verdict: 'RATE_LIMITED',
            messages: ['Too many requests'],
          };
        }
        return {
          success: false,
          status: 200,
          verdict: 'INVALID_CREDENTIALS',
          messages: ['Invalid username or password'],
        };
      }
      async close() {}
    }

    const mockProxies = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${19001 + i}`);
    const batchPool = new RotationWorkerPool({
      rotationMode: 'hybrid',
      concurrency: 9,
      proxies: mockProxies,
      SolverClass: MockBatchSolver,
    });

    try {
      const dummyAccounts = Array.from({ length: 9 }, (_, i) => ({
        username: i === 4 ? 'rate_limited_user' : `acct_${i + 1}`,
        password: 'dummy_password',
      }));

      const batchResults = await batchPool.runAccountBatch(dummyAccounts, { quiet: true });
      assert.strictEqual(batchResults.length, 9, 'Must return results for all 9 accounts');

      const batchBrands = new Set(batchResults.map((r) => r.brandId));
      const batchEngines = new Set(batchResults.map((r) => r.engine));
      assert.strictEqual(batchBrands.size, 9, 'All 9 batch workers must run 9 distinct browser brands');
      assert.strictEqual(batchEngines.size, 3, 'Batch must utilize all 3 native browser engines');

      const afterBatchStats = await batchPool.leaseManager.getStats();
      assert.strictEqual(afterBatchStats.activeCount, 0, 'All batch leases must release after batch finishes');
      assert.strictEqual(afterBatchStats.totalBurned, 1, 'HTTP 429 worker must trigger automatic variant burn');
      console.log('  PASS: 9-worker account batch ran 9/9 distinct brands across 3 engines + auto-burned HTTP 429 variant.\n');
    } finally {
      await batchPool.shutdown();
    }

    // -------------------------------------------------------------------------
    // SUITE 3: Live `verifyLiveRotation()` (4 Concurrent Multi-Engine Browsers + Live Reddit)
    // -------------------------------------------------------------------------
    console.log('[Suite 3/4] Live `verifyLiveRotation(4)` (Real Multi-Engine DOM + Live Reddit WAF)...');
    // Pause briefly to keep shared sandbox IP window clean
    await new Promise((r) => setTimeout(r, 4000));

    const verifyPool = new RotationWorkerPool({
      rotationMode: 'hybrid',
      concurrency: 4,
    });
    try {
      const report = await verifyPool.verifyLiveRotation({
        count: 4,
        checkRedditLive: true,
        printTable: true,
      });
      assert.strictEqual(report.ok, true, 'verifyLiveRotation(4) must pass with 0 collisions & WAF-clean responses');
      assert.strictEqual(report.uniqueBrandCount, 4, 'Must lease 4 distinct brands');
    } finally {
      await verifyPool.shutdown();
    }

    // -------------------------------------------------------------------------
    // SUITE 4: Live End-to-End `RedditSolver` Token Acquisition with Non-Chrome Brand (`camoufox`)
    // -------------------------------------------------------------------------
    console.log('[Suite 4/4] Live End-to-End `RedditSolver` (`camoufox` Gecko Brand -> Reddit JS Challenge + Token)...');
    await new Promise((r) => setTimeout(r, 3000));

    const camoufoxSolver = new RedditSolver({
      mode: 'http',
      rotationMode: 'hybrid',
      preferredBrand: 'camoufox',
    });

    const tokenRes = await camoufoxSolver.getRecaptchaTokenOnly({ quiet: true });
    assert.strictEqual(camoufoxSolver.profile.brandId, 'camoufox', 'Solver must bind to requested camoufox brand');
    assert.strictEqual(camoufoxSolver.profile.engine, 'firefox', 'Camoufox must run on firefox/Gecko engine');
    assert.strictEqual(Boolean(camoufoxSolver.csrfToken), true, 'Live Reddit JS challenge must seed csrf_token');
    assert.strictEqual(
      Boolean(tokenRes && tokenRes.recaptchaToken && tokenRes.recaptchaToken.length > 500),
      true,
      'Must obtain valid live Google reCAPTCHA Enterprise token'
    );
    console.log(
      `  PASS: Camoufox (${camoufoxSolver.profile.tlsClientId}) solved live Reddit JS challenge & obtained ${tokenRes.recaptchaToken.length}-char token!\n`
    );

    console.log('============================================================================');
    console.log('  ALL PHASE 4 END-TO-END ROTATION INTEGRATION TESTS PASSED (4/4 SUITES)');
    console.log('============================================================================\n');
  } finally {
    await destroyTLS().catch(() => {});
  }
}

runPhase4Tests().catch((err) => {
  console.error('\n[PHASE 4 TEST FAILURE]:', err);
  process.exit(1);
});
