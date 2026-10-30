'use strict';

/**
 * Phase 1 Verification & Live TLS Parity Test Suite (`test/phase1_catalog.test.js`)
 */

const vm = require('vm');
const { Session, initTLS, destroyTLS } = require('node-tls-client');
const { getTlsClientAssetInfo } = require('../reddit_solver');
const {
  BROWSER_BRAND_CATALOG,
  listBrandsForMode,
  enumerateAllCatalogVariants,
  synthesizeProfile,
  buildContextInitScript,
  getSharedGenerator,
  getSharedInjector,
  buildTlsSessionOptions,
  buildProfileHttpHeaders,
  validateProfileParity,
  toSolverProfileAdapter,
} = require('../src/rotation');

function assert(condition, msg) {
  if (!condition) {
    throw new Error(`PHASE 1 ASSERTION FAILED: ${msg}`);
  }
}

async function runPhase1Tests() {
  console.log('='.repeat(78));
  console.log('PHASE 1 TEST SUITE — Browser Catalog, Fingerprint Synthesizer & TLS Bridge');
  console.log('='.repeat(78) + '\n');

  // ------------------------------------------------------------------
  // Test 1: Catalog Modes & Variant Matrix
  // ------------------------------------------------------------------
  console.log('--- [Test 1/5] Browser Brand Catalog & Mode Filtering ---');
  assert(BROWSER_BRAND_CATALOG.length === 9, `Expected 9 browser brands, got ${BROWSER_BRAND_CATALOG.length}`);

  const singleEngineBrands = listBrandsForMode('single-engine');
  assert(
    singleEngineBrands.length === 6 && singleEngineBrands.every((b) => b.engine === 'chromium'),
    'single-engine mode must return exactly the 6 Chromium-based brands'
  );

  const hybridBrands = listBrandsForMode('hybrid');
  assert(hybridBrands.length === 9, 'hybrid mode must return all 9 browser brands');

  const allVariants = enumerateAllCatalogVariants('hybrid');
  console.log(`  Total Browser Brands        : ${hybridBrands.length} (${hybridBrands.map((b) => b.brandId).join(', ')})`);
  console.log(`  Method 1 (Single Chromium)  : ${singleEngineBrands.length} brands (${singleEngineBrands.map((b) => b.brandId).join(', ')})`);
  console.log(`  Discrete Base OS/Ver Slots  : ${allVariants.length} variants (+ infinite 64-bit crypto seeds) -> OK\n`);

  // ------------------------------------------------------------------
  // Test 2: Apify fingerprint-suite Integration & Seed Determinism
  // ------------------------------------------------------------------
  console.log('--- [Test 2/5] FingerprintGenerator + Seed Uniqueness & Determinism ---');
  const hasBayesian = Boolean(getSharedGenerator() && getSharedInjector());
  assert(hasBayesian, 'fingerprint-generator and fingerprint-injector should be active');

  // Same seedHex -> identical signatureId
  const pFixedA = synthesizeProfile({ brandId: 'brave', os: 'windows', seedHex: 'deadbeefcafebabe' });
  const pFixedB = synthesizeProfile({ brandId: 'brave', os: 'windows', seedHex: 'deadbeefcafebabe' });
  assert(pFixedA.signatureId === pFixedB.signatureId, 'Identical seedHex must reproduce identical signatureId');

  // 100 fresh profiles -> 100 unique signatureIds
  const sigSet = new Set();
  for (let i = 0; i < 100; i++) {
    const brand = BROWSER_BRAND_CATALOG[i % BROWSER_BRAND_CATALOG.length];
    const prof = synthesizeProfile({ brandId: brand.brandId });
    sigSet.add(prof.signatureId);
  }
  assert(sigSet.size === 100, `Expected 100 unique signatures across 100 generations, got ${sigSet.size}`);
  console.log(`  Bayesian Suite Active: ${hasBayesian} | 100/100 Unique Crypto Signatures -> OK\n`);

  // ------------------------------------------------------------------
  // Test 3: 100-Profile Anti-Bot Parity Audit + Summary Matrix
  // ------------------------------------------------------------------
  console.log('--- [Test 3/5] 12-Point Anti-Bot Parity Audit Across All 9 Brands ---');
  console.log(
    '  ' +
      'Brand'.padEnd(20) +
      'Engine'.padEnd(10) +
      'OS'.padEnd(9) +
      'TLS ID'.padEnd(16) +
      'CH-UA'.padEnd(7) +
      'Screen'.padEnd(12) +
      'GPU Sample'
  );
  console.log('  ' + '-'.repeat(98));

  for (const brand of BROWSER_BRAND_CATALOG) {
    const sample = synthesizeProfile({ brandId: brand.brandId });
    const audit = validateProfileParity(sample);
    assert(audit.valid, `Parity violation on ${brand.brandId}: ${audit.violations.join('; ')}`);

    // Verify Firefox & Safari strip accidental sec-ch-ua even if passed in extraHeaders
    if (!brand.sendsClientHints) {
      const hdrs = buildProfileHttpHeaders(sample, {
        http1: false,
        extraHeaders: { 'sec-ch-ua': '"Fake";v="1"' },
      });
      assert(!('sec-ch-ua' in hdrs), `${brand.brandId} failed to strip accidental sec-ch-ua`);
    }

    const adapter = toSolverProfileAdapter(sample);
    assert(adapter.tlsClientId && adapter.userAgent, 'Adapter conversion failed');

    console.log(
      '  ' +
        sample.brandId.padEnd(20) +
        sample.engine.padEnd(10) +
        sample.os.padEnd(9) +
        sample.tlsClientId.padEnd(16) +
        (sample.sendsClientHints ? 'YES' : 'NO').padEnd(7) +
        `${sample.screen.width}x${sample.screen.height}`.padEnd(12) +
        sample.gpu.renderer.slice(0, 34)
    );
  }

  // Stress-audit 90 more random profiles across all OSes
  for (let i = 0; i < 90; i++) {
    const brand = BROWSER_BRAND_CATALOG[i % BROWSER_BRAND_CATALOG.length];
    const prof = synthesizeProfile({ brandId: brand.brandId });
    const audit = validateProfileParity(prof);
    assert(audit.valid, `Stress parity violation (${prof.brandId}/${prof.os}): ${audit.violations.join('; ')}`);
  }
  console.log('\n  Audited 99 generated profiles: 0 hardware/TLS/header parity violations -> OK\n');

  // ------------------------------------------------------------------
  // Test 4: Browser Init Script VM Syntax Verification
  // ------------------------------------------------------------------
  console.log('--- [Test 4/5] Context Init Script Syntax Check (All 9 Brands) ---');
  for (const brand of BROWSER_BRAND_CATALOG) {
    const prof = synthesizeProfile({ brandId: brand.brandId });
    const scriptCode = buildContextInitScript(prof);
    const compiled = new vm.Script(scriptCode);
    assert(Boolean(compiled), `Failed to compile init script for ${brand.brandId}`);
  }
  console.log('  All 9 brand context init scripts compiled cleanly in V8 vm.Script -> OK\n');

  // ------------------------------------------------------------------
  // Test 5: Live Multi-Engine TLS Handshake Test against Reddit /login/
  // ------------------------------------------------------------------
  console.log('--- [Test 5/5] Live Multi-Browser TLS & Header Handshake Verification ---');
  // initTLS() loads a ~15MB native library from os.tmpdir(); if it is missing the dependency
  // downloads it and calls process.exit(1) when that download fails (offline / firewall / CI),
  // which killed this whole suite with no message. Skip explicitly instead.
  const tlsAsset = getTlsClientAssetInfo();
  if (!tlsAsset.ok) {
    console.log(`  SKIP: node-tls-client native library not present (${tlsAsset.tempPath})`);
    console.log('        First `node reddit_solver.js --diagnose` run downloads it; offline hosts must copy it in');
    console.log('        by hand, or use the browser path (`--mode browser`), which needs no TLS binary.\n');
    return;
  }
  await initTLS();
  try {
    const liveTestBrands = [
      { brandId: 'edge', os: 'windows' },
      { brandId: 'opera', os: 'windows', versionMajor: '91' },
      { brandId: 'firefox', os: 'linux', versionMajor: '133' },
      { brandId: 'safari', os: 'macos', versionMajor: '17' },
    ];

    for (const spec of liveTestBrands) {
      const prof = synthesizeProfile(spec);
      const sessionOpts = buildTlsSessionOptions(prof, { timeout: 15000 });
      const headers = buildProfileHttpHeaders(prof, {
        http1: false,
        isDocumentNavigation: true,
        extraHeaders: {
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
        },
      });

      const session = new Session(sessionOpts);
      try {
        const t0 = Date.now();
        const res = await session.get('https://www.reddit.com/login/', {
          headers,
          followRedirects: true,
        });
        const ms = Date.now() - t0;
        const blocked = /Prove your humanity/i.test(res.body || '');
        assert(res.status === 200, `${prof.brandId} expected HTTP 200, got ${res.status}`);
        assert(!blocked, `${prof.brandId} (${sessionOpts.clientIdentifier}) triggered WAF block!`);
        console.log(
          `  [PASS] ${prof.brandId.padEnd(10)} | Engine=${prof.engine.padEnd(8)} | TLS=${sessionOpts.clientIdentifier.padEnd(12)} | HTTP ${res.status} (${ms}ms, ${res.body.length}B, WAF-Clean)`
        );
      } finally {
        await session.close();
      }
    }
  } finally {
    await destroyTLS();
  }

  console.log('\n' + '='.repeat(78));
  console.log('PHASE 1 COMPLETE — ALL 5 VERIFICATION SUITES PASSED (0 ERRORS)!');
  console.log('='.repeat(78));
}

runPhase1Tests().catch((err) => {
  console.error('\n[PHASE 1 TEST FAILURE]', err.message);
  console.error(err.stack);
  process.exit(1);
});
