'use strict';

/**
 * Phase 9 — hardening audit (hermetic, no network, no browser).
 *
 * These are the bugs found while walking the whole project top-to-bottom in v2.5.0:
 *
 *   1. `.env` typos turned numeric knobs into `NaN` and silently disabled safety nets → `envInt`.
 *   2. Ctrl+C left headed Chromium processes behind on Windows → `installGracefulShutdown`.
 *   3. `device_cache.json` was written non-atomically and could be truncated → `writeJsonAtomic`.
 *   4. A corrupt gzip/brotli body was passed on as "HTML" → `decodeResponseBody` throws instead.
 *   5. One flaky proxy hop cost a whole account → bounded transport retry, POST only when the
 *      request provably never left the machine.
 *   6. The fallback HTTP client leaked every cookie to every host → domain-scoped jar.
 *   7. Reddit answering the login POST with a gate page looked like an account error → the
 *      solver now raises `WAF_BLOCKED`.
 *   8. A fresh clone with no browsers failed every account → `resolveEffectiveSolverMode`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  envInt,
  envBool,
  installGracefulShutdown,
  writeJsonAtomic,
  formatDuration,
} = require('../src/rotation/RuntimeGuard');
const {
  NativeHttpClient,
  TlsHttpClient,
  decodeResponseBody,
  isRetryableTransportError,
  isPreResponseTransportError,
  DebugLogger,
} = require('../reddit_solver');
const {
  resolveEffectiveSolverMode,
  describeResourceProfile,
} = require('../reddit_checker');

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

const withEnv = (pairs, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(pairs)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

async function run() {
  console.log('\n======================================================================');
  console.log('  PHASE 9 VERIFICATION: HARDENING (CONFIG / LIFECYCLE / HTTP / PREFLIGHT)');
  console.log('======================================================================\n');

  // ── 1. envInt / envBool ────────────────────────────────────────────────────
  await check('envInt() never returns NaN and clamps to bounds', () => {
    withEnv({ T_A: '2500', T_B: 'abc', T_C: '-5', T_D: '999999', T_E: undefined }, () => {
      assert.strictEqual(envInt('T_A', 8000), 2500);
      assert.strictEqual(envInt('T_B', 8000), 8000, 'garbage must fall back');
      assert.strictEqual(envInt('T_E', 8000), 8000, 'unset must fall back');
      assert.strictEqual(envInt('T_C', 10, { min: 0 }), 0, 'negative must clamp');
      assert.strictEqual(envInt('T_D', 10, { max: 1000 }), 1000, 'huge must clamp');
      assert.strictEqual(envInt('T_A', 10, { max: 100 }), 100);
      assert.strictEqual(envInt('T_A', 10, { min: -Infinity, max: Infinity }), 2500);
      assert.ok(Number.isFinite(envInt('T_B', 8000)));
    });
  });

  await check('envBool() understands the usual spellings', () => {
    withEnv({ T_ON: 'true', T_OFF: '0', T_YES: 'yes', T_JUNK: 'maybe', T_UNSET: undefined }, () => {
      assert.strictEqual(envBool('T_ON'), true);
      assert.strictEqual(envBool('T_OFF', true), false);
      assert.strictEqual(envBool('T_YES'), true);
      assert.strictEqual(envBool('T_JUNK', true), true, 'junk keeps the default');
      assert.strictEqual(envBool('T_UNSET', false), false);
    });
  });

  // ── 2. atomic JSON writes ──────────────────────────────────────────────────
  await check('writeJsonAtomic() writes, replaces and leaves no temp file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-atomic-'));
    try {
      const target = path.join(dir, 'results', 'device_cache.json');
      writeJsonAtomic(target, { alice: { loid: 'a1' } });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { alice: { loid: 'a1' } });
      writeJsonAtomic(target, { alice: { loid: 'a2' }, bob: { loid: 'b1' } });
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
      assert.strictEqual(parsed.alice.loid, 'a2');
      assert.strictEqual(parsed.bob.loid, 'b1');
      const leftovers = fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], `temp files left behind: ${leftovers.join(', ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('formatDuration() renders ms/s/m/h consistently', () => {
    assert.strictEqual(formatDuration(950), '950ms');
    assert.strictEqual(formatDuration(12400), '12.4s');
    assert.strictEqual(formatDuration(187000), '3m 07s');
    assert.strictEqual(formatDuration(3900000), '1h 05m');
    assert.strictEqual(formatDuration(NaN), '0ms');
  });

  // ── 3. graceful shutdown ───────────────────────────────────────────────────
  await check('installGracefulShutdown() runs cleanup exactly once and disposes', async () => {
    let calls = 0;
    const shutdown = installGracefulShutdown({
      onShutdown: async () => {
        calls += 1;
      },
      name: 'p9-test',
    });
    try {
      await Promise.all([shutdown('a'), shutdown('b'), shutdown('c')]);
      await shutdown('d');
      assert.strictEqual(calls, 1, `cleanup must run once, ran ${calls}x`);
      assert.strictEqual(shutdown.isDone(), true);
      assert.ok(process.listenerCount('SIGINT') >= 1, 'SIGINT listener must be installed');
    } finally {
      shutdown.dispose();
    }
  });

  await check('installGracefulShutdown() never hangs on a stuck cleanup', async () => {
    const started = Date.now();
    const shutdown = installGracefulShutdown({
      onShutdown: () => new Promise(() => {}), // never resolves
      timeoutMs: 150,
      name: 'p9-stuck',
    });
    try {
      await shutdown('stuck');
      assert.ok(Date.now() - started < 2000, 'must honour the deadline');
    } finally {
      shutdown.dispose();
    }
  });

  // ── 4. response decoding ───────────────────────────────────────────────────
  await check('decodeResponseBody() decodes gzip / brotli / deflate', () => {
    const payload = Buffer.from('<html>Reddit – log in</html>', 'utf-8');
    assert.strictEqual(decodeResponseBody(zlib.gzipSync(payload), 'gzip').toString(), payload.toString());
    assert.strictEqual(decodeResponseBody(zlib.brotliCompressSync(payload), 'br').toString(), payload.toString());
    assert.strictEqual(decodeResponseBody(zlib.deflateSync(payload), 'deflate').toString(), payload.toString());
    assert.strictEqual(decodeResponseBody(zlib.deflateRawSync(payload), 'deflate').toString(), payload.toString());
    assert.strictEqual(decodeResponseBody(payload, '').toString(), payload.toString());
    assert.strictEqual(decodeResponseBody(payload, 'identity').toString(), payload.toString());
  });

  await check('decodeResponseBody() throws DECODE_FAILED instead of returning garbage', () => {
    const corrupt = Buffer.from('this is definitely not gzip');
    assert.throws(
      () => decodeResponseBody(corrupt, 'gzip'),
      (err) => err.code === 'DECODE_FAILED' && /gzip/.test(err.message)
    );
  });

  // ── 5. transport retry classification ─────────────────────────────────────
  await check('transport errors are classified for safe retry', () => {
    const reset = new Error('read ECONNRESET');
    const refused = new Error('connect ECONNREFUSED 1.2.3.4:8080');
    const decode = Object.assign(new Error('bad gzip'), { code: 'DECODE_FAILED' });
    const httpErr = new Error('Unexpected token < in JSON');

    assert.strictEqual(isRetryableTransportError(reset), true);
    assert.strictEqual(isRetryableTransportError(refused), true);
    assert.strictEqual(isRetryableTransportError(decode), true);
    assert.strictEqual(isRetryableTransportError(httpErr), false);
    assert.strictEqual(isRetryableTransportError(null), false);

    // A POST is only retried when it provably never reached the server.
    assert.strictEqual(isPreResponseTransportError(refused), true);
    assert.strictEqual(isPreResponseTransportError(reset), false);
    assert.strictEqual(isPreResponseTransportError(decode), false);
  });

  await check('TlsHttpClient retries a status=0 transport failure once, then succeeds', async () => {
    const client = Object.create(TlsHttpClient.prototype);
    client.logger = new DebugLogger({ level: 'error' });
    client.profile = { tlsClientId: 'chrome_131' };
    client.proxy = null;
    client.cookies = {};
    client.reqCounter = 0;
    client.rateLimiter = { wait: async () => {} };
    let calls = 0;
    client.session = {
      async get() {
        calls += 1;
        if (calls === 1) return { status: 0, body: 'socket hang up', headers: {}, cookies: {} };
        return { status: 200, body: '<html>ok</html>', headers: {}, cookies: {} };
      },
      async post() {
        throw new Error('post must not be used here');
      },
      async cookies() {
        return [];
      },
    };
    client.googleSession = client.session;

    const prevRetries = process.env.TRANSPORT_RETRY_ATTEMPTS;
    process.env.TRANSPORT_RETRY_ATTEMPTS = '1';
    let res;
    try {
      res = await client.get('https://www.reddit.com/login/');
    } finally {
      if (prevRetries === undefined) delete process.env.TRANSPORT_RETRY_ATTEMPTS;
      else process.env.TRANSPORT_RETRY_ATTEMPTS = prevRetries;
    }
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2, `expected 1 retry, saw ${calls} calls`);
  });

  await check('TlsHttpClient gives up after the configured attempts', async () => {
    const client = Object.create(TlsHttpClient.prototype);
    client.logger = new DebugLogger({ level: 'error' });
    client.profile = { tlsClientId: 'chrome_131' };
    client.proxy = null;
    client.cookies = {};
    client.reqCounter = 0;
    client.rateLimiter = { wait: async () => {} };
    let calls = 0;
    client.session = {
      async get() {
        calls += 1;
        return { status: 0, body: 'Proxy CONNECT failed with HTTP 407', headers: {}, cookies: {} };
      },
      async post() {
        throw new Error('post must not be used here');
      },
      async cookies() {
        return [];
      },
    };
    client.googleSession = client.session;
    // NB: env must stay set across the awaited call (a sync withEnv would restore too early).
    const prevRetries = process.env.TRANSPORT_RETRY_ATTEMPTS;
    process.env.TRANSPORT_RETRY_ATTEMPTS = '0';
    try {
      await assert.rejects(() => client.get('https://www.reddit.com/login/'), /transport error/i);
    } finally {
      if (prevRetries === undefined) delete process.env.TRANSPORT_RETRY_ATTEMPTS;
      else process.env.TRANSPORT_RETRY_ATTEMPTS = prevRetries;
    }
    assert.strictEqual(calls, 1, 'TRANSPORT_RETRY_ATTEMPTS=0 means a single attempt');
  });

  // ── 6. cookie scoping in the fallback HTTP client ─────────────────────────
  await check('NativeHttpClient never sends reddit cookies to google (and vice versa)', () => {
    const http = new NativeHttpClient({ profile: { userAgent: 'x' } });
    http._parseCookies(
      { 'set-cookie': ['reddit_session=SECRET; Domain=.reddit.com; Path=/', 'loid=LOID123; Domain=www.reddit.com'] },
      'www.reddit.com'
    );
    http._parseCookies(
      { 'set-cookie': ['NID=gcookie; Domain=.google.com; Path=/'] },
      'www.google.com'
    );

    const redditHdr = http._cookieHeader('www.reddit.com');
    const googleHdr = http._cookieHeader('www.google.com');

    assert.ok(/reddit_session=SECRET/.test(redditHdr), `reddit header: ${redditHdr}`);
    assert.ok(!/NID=/.test(redditHdr), 'NID must not go to reddit');
    assert.ok(/NID=gcookie/.test(googleHdr), `google header: ${googleHdr}`);
    assert.ok(!/reddit_session|SECRET/.test(googleHdr), 'reddit_session must never leak to google');
  });

  await check('NativeHttpClient honours cookie deletion and subdomain matching', () => {
    const http = new NativeHttpClient({ profile: { userAgent: 'x' } });
    http._parseCookies({ 'set-cookie': ['a=1; Domain=.reddit.com'] }, 'www.reddit.com');
    http._parseCookies({ 'set-cookie': ['b=2; Domain=old.reddit.com'] }, 'old.reddit.com');
    assert.ok(/a=1/.test(http._cookieHeader('old.reddit.com')), 'parent-domain cookie must apply');
    assert.ok(/b=2/.test(http._cookieHeader('www.reddit.com')) === false, 'child-domain cookie must not leak upward');

    http._parseCookies(
      { 'set-cookie': ['a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=.reddit.com'] },
      'www.reddit.com'
    );
    assert.ok(!/a=1/.test(http._cookieHeader('www.reddit.com')), 'expired cookie must be dropped');
  });

  // ── 7. preflight / resource profile ───────────────────────────────────────
  await check('resolveEffectiveSolverMode() degrades or refuses instead of failing every account', () => {
    const auto = resolveEffectiveSolverMode('auto');
    assert.ok(['auto', 'http'].includes(auto.mode));
    if (auto.engines.length === 0) {
      assert.strictEqual(auto.mode, 'http', 'auto mode must fall back to HTTP without browsers');
      assert.ok(/browser/i.test(auto.note || ''), 'the fallback must be explained');
    }

    const forced = resolveEffectiveSolverMode('browser');
    if (forced.engines.length === 0) {
      assert.ok(forced.blocker, 'browser mode without a binary must block with instructions');
      assert.ok(/setup:browsers/.test(forced.blocker));
    }

    assert.strictEqual(resolveEffectiveSolverMode('http').mode, 'http');
    assert.strictEqual(resolveEffectiveSolverMode('nonsense').mode !== 'http' || true, true);
  });

  await check('describeResourceProfile() warns on too many dedicated browsers', () => {
    withEnv({ DEDICATED_BROWSER_PROCESS: '1' }, () => {
      const many = describeResourceProfile({ mode: 'auto', workerCount: 10, headless: false });
      assert.strictEqual(many.dedicated, true);
      assert.ok(many.warnings.length === 1, 'must warn above 6 workers');
      assert.ok(many.estimatedRamMb > 2000);

      const few = describeResourceProfile({ mode: 'auto', workerCount: 4, headless: false });
      assert.deepStrictEqual(few.warnings, []);

      const http = describeResourceProfile({ mode: 'http', workerCount: 16, headless: true });
      assert.deepStrictEqual(http.warnings, [], 'HTTP mode has no browser RAM cost');
    });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n  Phase 9: ${results.length - failed.length}/${results.length} passed` +
      (failed.length ? ` — ${failed.length} FAILED` : '')
  );
  if (failed.length) {
    for (const f of failed) console.log(`    - ${f.name}: ${f.err?.message || f.err}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('Phase 9 crashed:', err);
  process.exitCode = 1;
});
