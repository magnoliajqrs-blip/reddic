'use strict';

/**
 * Phase 2 Automated Verification Suite (`test/phase2_lease_collision.test.js`)
 *
 * Proves:
 *   1. 9 simultaneous workers in `hybrid` mode receive 9/9 DISTINCT browser brands & 3/3 engines.
 *   2. 6 simultaneous workers in `single-engine` mode receive 6/6 DISTINCT Chromium brands.
 *   3. High-concurrency stress test: 30 simultaneous workers get 30/30 unique `(brand,ver,os)` variants,
 *      and 70 simultaneous workers (>56 catalog slots) get 70/70 unique `signatureId`s & 0 parity errors.
 *   4. Sequential rotation & LRU history cooldown: 45 sequential jobs never repeat the previous brand
 *      and never replay a burned `signatureId`; static proxy list assigns distinct proxies per worker.
 *   5. Real OS `worker_threads` IPC test: 8 parallel OS threads simultaneously hold 8 DISTINCT browser
 *      brands via `WorkerThreadLeaseBridge`, plus crash-recovery auto-release when a thread exits abruptly.
 */

const assert = require('assert');
const { Worker } = require('node:worker_threads');
const path = require('path');

const {
  ProfileLeaseManager,
  formatLeaseTable,
  attachLeaseManagerToWorker,
  validateProfileParity,
} = require('../src/rotation');

async function runPhase2Tests() {
  console.log('\n======================================================================');
  console.log('  PHASE 2 VERIFICATION: ZERO-COLLISION LEASE MANAGER & WORKER THREADS');
  console.log('======================================================================\n');

  // ---------------------------------------------------------------------------
  // TEST 1: 9 Concurrent Workers in Hybrid Mode -> 9/9 Distinct Browser Brands
  // ---------------------------------------------------------------------------
  console.log('[Test 1] 9 Simultaneous Workers in Hybrid Mode (Method 1 + Method 2 Combined)...');
  const hybridMgr = new ProfileLeaseManager({ mode: 'hybrid' });

  const hybridLeases = await Promise.all(
    Array.from({ length: 9 }, (_, i) =>
      hybridMgr.acquireLease({ workerId: `worker-${i + 1}` })
    )
  );

  console.log('\n' + formatLeaseTable(hybridLeases) + '\n');

  const hybridBrands = new Set(hybridLeases.map((l) => l.profile.brandId));
  const hybridEngines = new Set(hybridLeases.map((l) => l.profile.engine));
  const hybridSigs = new Set(hybridLeases.map((l) => l.profile.signatureId));

  assert.strictEqual(
    hybridBrands.size,
    9,
    `Expected all 9 concurrent workers to get 9 distinct brands, got ${hybridBrands.size}: [${[...hybridBrands].join(', ')}]`
  );
  assert.strictEqual(
    hybridEngines.size,
    3,
    `Expected all 3 browser engines (chromium, firefox, webkit) active, got [${[...hybridEngines].join(', ')}]`
  );
  assert.strictEqual(hybridSigs.size, 9, 'Expected 9 unique cryptographic signatures');

  for (const l of hybridLeases) {
    await hybridMgr.releaseLease(l.leaseId);
  }
  const postHybridStats = await hybridMgr.getStats();
  assert.strictEqual(postHybridStats.activeCount, 0, 'All 9 leases must release cleanly');
  console.log('  PASS: 9/9 concurrent workers received 9 distinct brands across all 3 engines (0 collisions).\n');

  // ---------------------------------------------------------------------------
  // TEST 2: 6 Concurrent Workers in Single-Engine Mode (Method 1 Only)
  // ---------------------------------------------------------------------------
  console.log('[Test 2] 6 Simultaneous Workers in Single-Engine Mode (Shared Chromium Pool)...');
  const singleMgr = new ProfileLeaseManager({ mode: 'single-engine' });

  const singleLeases = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      singleMgr.acquireLease({ workerId: `ctx-${i + 1}` })
    )
  );

  const singleBrands = new Set(singleLeases.map((l) => l.profile.brandId));
  const singleEngines = new Set(singleLeases.map((l) => l.profile.engine));
  assert.strictEqual(singleBrands.size, 6, `Expected 6 distinct Chromium brands, got ${singleBrands.size}`);
  assert.deepStrictEqual([...singleEngines], ['chromium'], 'Single-engine mode must only lease Chromium contexts');

  for (const l of singleLeases) {
    await singleMgr.releaseLease(l.leaseId);
  }
  console.log(`  PASS: 6/6 single-engine contexts received distinct brands: [${[...singleBrands].join(', ')}].\n`);

  // ---------------------------------------------------------------------------
  // TEST 3: High-Concurrency Burst (30 Workers & 70 Extreme Burst > 56 Variants)
  // ---------------------------------------------------------------------------
  console.log('[Test 3] High-Concurrency Race Test (30 Simultaneous + 70 Extreme Burst)...');
  const burstMgr = new ProfileLeaseManager({ mode: 'hybrid', historySize: 1000 });

  // 3a: 30 simultaneous workers -> must get 30 distinct (brand, version, os) variant slots!
  const leases30 = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      burstMgr.acquireLease({ workerId: `burst30-${i + 1}` })
    )
  );
  const variants30 = new Set(leases30.map((l) => l.profile.variantKey));
  const sigs30 = new Set(leases30.map((l) => l.profile.signatureId));
  assert.strictEqual(
    variants30.size,
    30,
    `Expected 30 distinct (brand:version:os) variants across 30 workers, got ${variants30.size}`
  );
  assert.strictEqual(sigs30.size, 30, 'Expected 30 unique signatures');
  await Promise.all(leases30.map((l) => burstMgr.releaseLease(l.leaseId)));

  // 3b: 70 simultaneous workers (exceeds all 56 base catalog variants) -> 70/70 unique signatures & 0 parity errors
  const leases70 = await Promise.all(
    Array.from({ length: 70 }, (_, i) =>
      burstMgr.acquireLease({ workerId: `burst70-${i + 1}` })
    )
  );
  const sigs70 = new Set(leases70.map((l) => l.profile.signatureId));
  assert.strictEqual(
    sigs70.size,
    70,
    `Expected 70/70 unique cryptographic signatures even above 56 variants, got ${sigs70.size}`
  );

  for (const l of leases70) {
    const parity = validateProfileParity(l.profile);
    assert.strictEqual(
      parity.valid,
      true,
      `Parity violation on worker ${l.workerId} (${l.profile.brandId}): ${parity.violations.join('; ')}`
    );
  }
  await Promise.all(leases70.map((l) => burstMgr.releaseLease(l.leaseId)));

  const burstStats = await burstMgr.getStats();
  assert.strictEqual(burstStats.collisionsDetected, 0, 'Expected zero signature collisions');
  assert.strictEqual(burstStats.peakConcurrent, 70, 'Peak concurrent telemetry should record 70');
  console.log('  PASS: 30/30 unique variants at N=30, and 70/70 unique signatures + 100% TLS parity at N=70.\n');

  // ---------------------------------------------------------------------------
  // TEST 4: Sequential Anti-Repeat Rotation, Burned LRU & Proxy Pool Isolation
  // ---------------------------------------------------------------------------
  console.log('[Test 4] Sequential Anti-Repeat Rotation, Burned Signature LRU & Proxy Isolation...');
  const seqMgr = new ProfileLeaseManager({
    mode: 'hybrid',
    historySize: 200,
    proxies: [
      'http://user:pass@proxy-1.example:8080',
      'http://user:pass@proxy-2.example:8080',
      'http://user:pass@proxy-3.example:8080',
      'http://user:pass@proxy-4.example:8080',
    ],
  });

  // 4a: 4 concurrent workers must lease all 4 distinct static proxies
  const proxyLeases = await Promise.all(
    Array.from({ length: 4 }, (_, i) => seqMgr.acquireLease({ workerId: `px-${i + 1}` }))
  );
  const activeProxies = new Set(proxyLeases.map((l) => l.proxy));
  assert.strictEqual(activeProxies.size, 4, 'Expected 4 concurrent workers to receive 4 distinct proxies');
  await Promise.all(proxyLeases.map((l) => seqMgr.releaseLease(l.leaseId)));

  // 4b: 45 sequential single-worker runs -> never repeat immediate previous brand & never replay burned signature
  const seenSequentialSigs = new Set();
  let prevBrand = null;
  let consecutiveBrandRepeats = 0;

  for (let i = 0; i < 45; i++) {
    await seqMgr.withLease({ workerId: 'seq-worker' }, async (lease) => {
      if (lease.profile.brandId === prevBrand) {
        consecutiveBrandRepeats += 1;
      }
      prevBrand = lease.profile.brandId;
      assert.strictEqual(
        seenSequentialSigs.has(lease.profile.signatureId),
        false,
        `Replayed burned signatureId on sequential run #${i + 1}`
      );
      seenSequentialSigs.add(lease.profile.signatureId);
    });
  }

  assert.strictEqual(
    consecutiveBrandRepeats,
    0,
    `Expected 0 back-to-back brand repeats across 45 sequential runs, got ${consecutiveBrandRepeats}`
  );
  assert.strictEqual(seenSequentialSigs.size, 45, 'Expected 45 unique sequential signatures');

  // 4c: Verify explicit WAF `markBurned()` places flagged variant into cooldown
  const flaggedLease = await seqMgr.acquireLease({ workerId: 'waf-probe', preferredBrand: 'chrome' });
  const burnedVariantKey = flaggedLease.profile.variantKey;
  await seqMgr.markBurned(flaggedLease.leaseId, { reason: 'http_429' });
  const nextChromeLease = await seqMgr.acquireLease({ workerId: 'waf-probe-2', preferredBrand: 'chrome' });
  assert.notStrictEqual(
    nextChromeLease.profile.variantKey,
    burnedVariantKey,
    'markBurned() must avoid immediately re-selecting the WAF-flagged (brand:ver:os) variant'
  );
  await seqMgr.releaseLease(nextChromeLease.leaseId);

  console.log('  PASS: 45 sequential sessions had 0 consecutive brand repeats, markBurned() cooldown works, and 4/4 isolated proxies.\n');

  // ---------------------------------------------------------------------------
  // TEST 5: Real Node.js `worker_threads` Parallel IPC + Crash Auto-Recovery
  // ---------------------------------------------------------------------------
  console.log('[Test 5] Real OS Multi-Threading (`node:worker_threads`) + Crash Auto-Release...');
  const ipcMgr = new ProfileLeaseManager({ mode: 'hybrid' });
  const rotationModulePath = path.resolve(__dirname, '../src/rotation');

  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { WorkerLeaseClient } = require(workerData.rotationModulePath);

    (async () => {
      const client = new WorkerLeaseClient(parentPort, { workerId: workerData.workerName });
      const lease = await client.acquireLease();

      // Tell main thread we acquired our lease and wait for barrier release signal
      parentPort.postMessage({
        type: 'LEASE_ACQUIRED',
        workerName: workerData.workerName,
        leaseId: lease.leaseId,
        brandId: lease.profile.brandId,
        engine: lease.profile.engine,
        os: lease.profile.os,
        tlsClientId: lease.tlsSessionOptions.clientIdentifier,
        signatureId: lease.profile.signatureId,
      });

      if (workerData.simulateCrash) {
        // Exit abruptly WITHOUT calling releaseLease() to test crash cleanup!
        process.exit(1);
      }

      await new Promise((resolve) => {
        const onBarrier = (msg) => {
          if (msg && msg.type === 'RELEASE_BARRIER') {
            parentPort.off('message', onBarrier);
            resolve();
          }
        };
        parentPort.on('message', onBarrier);
      });

      await client.releaseLease(lease.leaseId);
      client.close();
      parentPort.postMessage({ type: 'DONE', workerName: workerData.workerName });
    })().catch((err) => {
      parentPort.postMessage({ type: 'ERROR', error: err.message });
      process.exit(2);
    });
  `;

  // 5a: Spawn 8 real OS threads simultaneously and hold barrier until ALL 8 hold active leases at once!
  const THREAD_COUNT = 8;
  const workers = [];
  const acquiredPromises = [];
  const exitPromises = [];

  for (let i = 0; i < THREAD_COUNT; i++) {
    const workerName = `os-thread-${i + 1}`;
    const w = new Worker(workerScript, {
      eval: true,
      workerData: { rotationModulePath, workerName, simulateCrash: false },
    });
    attachLeaseManagerToWorker(w, ipcMgr, { workerId: workerName });
    workers.push(w);

    acquiredPromises.push(
      new Promise((resolve, reject) => {
        w.on('message', (msg) => {
          if (msg?.type === 'LEASE_ACQUIRED') resolve(msg);
          if (msg?.type === 'ERROR') reject(new Error(msg.error));
        });
        w.once('error', reject);
      })
    );

    exitPromises.push(
      new Promise((resolve) => {
        w.once('exit', (code) => resolve(code));
      })
    );
  }

  // Wait until ALL 8 OS threads are simultaneously holding their browser leases
  const threadLeases = await Promise.all(acquiredPromises);
  const midBarrierStats = await ipcMgr.getStats();
  assert.strictEqual(midBarrierStats.activeCount, THREAD_COUNT, 'All 8 OS threads must hold active leases concurrently');

  const threadBrands = new Set(threadLeases.map((t) => t.brandId));
  const threadSigs = new Set(threadLeases.map((t) => t.signatureId));
  assert.strictEqual(
    threadBrands.size,
    THREAD_COUNT,
    `Expected 8 OS threads to get 8 distinct browser brands, got ${threadBrands.size}: [${[...threadBrands].join(', ')}]`
  );
  assert.strictEqual(threadSigs.size, THREAD_COUNT, 'Expected 8 distinct signatures across 8 OS threads');

  console.log(
    '  Active across 8 simultaneous OS threads: [' +
      threadLeases.map((t) => `${t.workerName}=${t.brandId}(${t.tlsClientId})`).join(', ') +
      ']'
  );

  // Release the barrier so all 8 threads release cleanly and exit
  for (const w of workers) {
    w.postMessage({ type: 'RELEASE_BARRIER' });
  }
  const exitCodes = await Promise.all(exitPromises);
  assert.deepStrictEqual(exitCodes, Array(THREAD_COUNT).fill(0), 'All 8 OS worker threads must exit with code 0');

  const afterBarrierStats = await ipcMgr.getStats();
  assert.strictEqual(afterBarrierStats.activeCount, 0, 'All 8 OS thread leases must be released');

  // 5b: Spawn 1 crashing OS thread that calls acquireLease() and immediately `process.exit(1)`
  const crashWorker = new Worker(workerScript, {
    eval: true,
    workerData: { rotationModulePath, workerName: 'crash-thread-99', simulateCrash: true },
  });
  attachLeaseManagerToWorker(crashWorker, ipcMgr, { workerId: 'crash-thread-99' });

  await new Promise((resolve) => {
    crashWorker.once('exit', () => resolve());
  });
  // Allow microtask queue on main thread to finish `releaseAllForWorker`
  await new Promise((r) => setTimeout(r, 25));

  const afterCrashStats = await ipcMgr.getStats();
  assert.strictEqual(
    afterCrashStats.activeCount,
    0,
    `Expected crashed worker's orphaned lease to be auto-released, but activeCount=${afterCrashStats.activeCount}`
  );

  // 5c: Verify TTL Reaper for non-thread hung async tasks
  const ttlMgr = new ProfileLeaseManager({ mode: 'hybrid', leaseTtlMs: 5000 });
  const shortLease = await ttlMgr.acquireLease({ workerId: 'hung-async-task' });
  // Simulate clock expiry by backdating `expiresAt`
  ttlMgr._activeLeases.get(shortLease.leaseId).expiresAt = Date.now() - 10;
  const reapedStats = await ttlMgr.getStats();
  assert.strictEqual(reapedStats.activeCount, 0, 'Expired hung lease must be reaped automatically');
  assert.strictEqual(reapedStats.totalExpiredReaped, 1, 'Expected totalExpiredReaped === 1');

  console.log('  PASS: 8/8 real OS `worker_threads` ran 8 distinct browsers concurrently + crash auto-recovery & TTL reaper verified!\n');

  console.log('======================================================================');
  console.log('  ALL PHASE 2 LEASE & MULTI-THREAD TESTS PASSED (5/5 SUITES)');
  console.log('======================================================================\n');
}

runPhase2Tests().catch((err) => {
  console.error('\n[PHASE 2 TEST FAILURE]:', err);
  process.exit(1);
});
