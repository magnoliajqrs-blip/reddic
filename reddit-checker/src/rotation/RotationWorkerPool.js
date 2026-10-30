'use strict';

/**
 * Phase 4 — High-Concurrency Zero-Collision Solver Worker Pool (`RotationWorkerPool.js`)
 *
 * Orchestrates N concurrent RedditSolver workers backed by a single central
 * `ProfileLeaseManager` + `EnginePoolManager` so that:
 *   1. No two concurrent workers EVER share the same browser brand (for N <= 9 in hybrid
 *      or N <= 6 in single-engine), variant, TLS JA3/JA4 profile, or Canvas/WebGL signature.
 *   2. Every worker's `TlsHttpClient` (HTTP/2) and `BrowserContext` (DOM/BotGuard) share
 *      the exact same synthesized browser identity & cookie jar 1:1.
 *   3. WAF rate-limits (`429` / `HUMANITY_BLOCK`) automatically burn & cooldown that variant.
 */

const crypto = require('crypto');
const { EnginePoolManager, resolveEffectiveHeadless } = require('./EnginePoolManager');
const { validateProfileParity } = require('./TlsHeaderBridge');

class RotationWorkerPool {
  /**
   * @param {object} [options]
   * @param {'hybrid'|'single-engine'|'multi-engine'} [options.rotationMode='hybrid']
   * @param {'auto'|'browser'|'http'} [options.solverMode='auto']
   * @param {number} [options.concurrency=4]
   * @param {boolean} [options.headless]
   * @param {boolean} [options.minimizeWindow]
   * @param {string[]} [options.proxies=[]]
   * @param {boolean} [options.isRotatingGatewayProxy=false]
   * @param {Function} [options.SolverClass=null] - Optional custom RedditSolver class
   * @param {object} [options.logger=null]
   */
  constructor({
    rotationMode = process.env.ROTATION_MODE || 'hybrid',
    solverMode = process.env.SOLVER_MODE || 'auto',
    concurrency = Number(process.env.WORKER_CONCURRENCY || 4),
    headless = undefined,
    minimizeWindow = process.env.BROWSER_MINIMIZED === 'true',
    proxies = [],
    isRotatingGatewayProxy = false,
    SolverClass = null,
    logger = null,
  } = {}) {
    this.rotationMode = rotationMode;
    this.solverMode = solverMode;
    this.concurrency = Math.max(1, Number(concurrency) || 4);
    this.headless = resolveEffectiveHeadless(headless);
    this.minimizeWindow = Boolean(minimizeWindow);
    this.logger = logger;
    this._SolverClass = SolverClass;

    this.enginePool = new EnginePoolManager({
      mode: this.rotationMode,
      headless: this.headless,
      minimizeWindow: this.minimizeWindow,
      proxies,
      isRotatingGatewayProxy,
      logger,
    });
    this.leaseManager = this.enginePool.leaseManager;
    this.isRotatingGatewayProxy = Boolean(isRotatingGatewayProxy);
    this._ipPacerNextAt = new Map(); // ipKey -> nextAllowedEpochMs
  }

  /**
   * Per-IP sliding-window pacer between account starts on the SAME egress IP, so N concurrent
   * workers never burst Reddit Fastly's per-IP login bucket.
   * Workers using distinct proxies or a rotating gateway proxy run at 0ms full parallel speed!
   *
   * W10: gap is now JITTERED (a fixed 1850ms metronome is itself a bot signature) and
   * env-configurable:
   *   LOGIN_PACE_MIN_MS / LOGIN_PACE_MAX_MS  (direct IP defaults: 2500..5200ms)
   *   LOGIN_PACE_PROXY_MIN_MS / LOGIN_PACE_PROXY_MAX_MS (shared static proxy: 1300..2800ms)
   */
  async _pacePerIpIfShared(proxyUrl) {
    if (proxyUrl && this.isRotatingGatewayProxy) return;
    const key = proxyUrl || '__direct_host_ip__';
    const crypto = require('crypto');
    const [defMin, defMax] = proxyUrl ? [1300, 2800] : [2500, 5200];
    const minMs = Number(process.env[proxyUrl ? 'LOGIN_PACE_PROXY_MIN_MS' : 'LOGIN_PACE_MIN_MS'] || defMin);
    const maxMs = Number(process.env[proxyUrl ? 'LOGIN_PACE_PROXY_MAX_MS' : 'LOGIN_PACE_MAX_MS'] || defMax);
    const minGapMs = maxMs > minMs ? minMs + crypto.randomInt(0, maxMs - minMs + 1) : minMs;
    const now = Date.now();
    const scheduled = Math.max(now, this._ipPacerNextAt.get(key) || 0);
    this._ipPacerNextAt.set(key, scheduled + minGapMs);
    const waitMs = scheduled - now;
    if (waitMs > 0) {
      this.logger?.debug('WorkerPool', `Per-IP pacing (${key.slice(0, 24)}): waiting ${waitMs}ms before next account start`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  _getSolverModule() {
    return require('../../reddit_solver');
  }

  /**
   * Execute generic tasks concurrently across `this.concurrency` workers, injecting a unique
   * zero-collision browser lease into each task execution.
   *
   * @param {Array<any>} items
   * @param {(item: any, ctx: { workerId: string, index: number, lease: object, enginePool: EnginePoolManager }) => Promise<any>} taskFn
   */
  async runConcurrentTasks(items, taskFn) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.concurrency, items.length);

    const runWorkerLoop = async (slotIdx) => {
      const workerId = `worker-${slotIdx + 1}`;
      while (true) {
        const currentIdx = nextIndex++;
        if (currentIdx >= items.length) break;

        const item = items[currentIdx];
        const lease = await this.leaseManager.acquireLease({
          workerId,
          proxyOverride: item?.proxy || null,
        });

        let shouldBurn = false;
        let burnReason = null;

        try {
          const out = await taskFn(item, {
            workerId,
            index: currentIdx,
            lease,
            enginePool: this.enginePool,
            markBurned: (reason = 'waf_flag') => {
              shouldBurn = true;
              burnReason = reason;
            },
          });
          results[currentIdx] = out;
        } finally {
          if (shouldBurn) {
            await this.leaseManager
              .markBurned(lease.leaseId, { reason: burnReason || 'waf_flag' })
              .catch(() => {});
          } else {
            await this.leaseManager.releaseLease(lease.leaseId).catch(() => {});
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => runWorkerLoop(idx))
    );

    return results;
  }

  /**
   * Run a batch of Reddit account login checks in parallel with strict per-worker browser rotation.
   *
   * @param {Array<{ username: string, password: string, proxy?: string }>} accounts
   * @param {object} [options]
   * @param {boolean} [options.quiet=true]
   * @param {(res: object, index: number) => void} [options.onResult]
   */
  async runAccountBatch(accounts, { quiet = true, onResult = null } = {}) {
    const SolverClass = this._SolverClass || this._getSolverModule().RedditSolver;

    return this.runConcurrentTasks(
      accounts,
      async (acct, { workerId, index, lease, enginePool, markBurned }) => {
        const t0 = Date.now();
        await this._pacePerIpIfShared(lease.proxy);
        const solver = new SolverClass({
          proxy: lease.proxy,
          mode: this.solverMode,
          rotationMode: this.rotationMode,
          lease,
          enginePool,
          ownsLease: false,
          logger: this.logger,
          deviceCookies: acct.deviceCookies || null,
        });

        try {
          const loginRes = await solver.fullLogin(acct.username, acct.password, { quiet });
          if (loginRes.status === 429 || loginRes.verdict === 'RATE_LIMITED' || loginRes.verdict === 'WAF_BLOCKED') {
            markBurned(loginRes.verdict || `http_${loginRes.status}`);
          }

          const summary = {
            index,
            workerId,
            username: acct.username,
            brandId: lease.profile.brandId,
            engine: lease.profile.engine,
            os: lease.profile.os,
            tlsClientId: lease.tlsSessionOptions.clientIdentifier,
            signatureId: lease.profile.signatureId,
            durationMs: Date.now() - t0,
            ...loginRes,
          };

          if (typeof onResult === 'function') {
            onResult(summary, index);
          }
          return summary;
        } catch (err) {
          if (/humanity|429|rate/i.test(err.message)) {
            markBurned('exception_waf');
          }
          const failSummary = {
            index,
            workerId,
            username: acct.username,
            brandId: lease.profile.brandId,
            engine: lease.profile.engine,
            os: lease.profile.os,
            tlsClientId: lease.tlsSessionOptions.clientIdentifier,
            signatureId: lease.profile.signatureId,
            durationMs: Date.now() - t0,
            success: false,
            verdict: 'EXCEPTION',
            error: err.message,
          };
          if (typeof onResult === 'function') {
            onResult(failSummary, index);
          }
          return failSummary;
        } finally {
          await solver.close();
        }
      }
    );
  }

  /**
   * Live End-to-End Multi-Worker Rotation Verification (`--verify-rotation <N>`).
   *
   * Simultaneously acquires `count` real browser sessions across `EnginePoolManager` AND
   * executes matching `TlsHttpClient` handshakes against `https://www.reddit.com/login/`
   * to prove zero collisions, 100% DOM/TLS parity, and WAF-clean HTTP 200 responses.
   */
  async verifyLiveRotation({ count = 6, checkRedditLive = true, printTable = true } = {}) {
    const workerCount = Math.max(1, Math.min(24, Number(count) || 6));
    const { TlsHttpClient, isHumanityBlockPage, parseRedditJsChallenge } = this._getSolverModule();
    const startedAt = Date.now();

    // Acquire ALL `workerCount` live browser sessions simultaneously so they overlap in real time!
    const sessions = await Promise.all(
      Array.from({ length: workerCount }, (_, idx) =>
        this.enginePool.acquireBrowserSession({
          workerId: `worker-${idx + 1}`,
        })
      )
    );

    const midPoolStatus = await this.enginePool.getPoolStatus();

    try {
      const workerReports = await Promise.all(
        sessions.map(async (sess, idx) => {
          const wStart = Date.now();
          const parity = validateProfileParity(sess.profile);

          // 1. Inspect real live browser DOM + Canvas + WebGL inside isolated BrowserContext
          await sess.page.setContent(
            '<!doctype html><html><body><canvas id="c" width="96" height="32"></canvas></body></html>'
          );
          const domInfo = await sess.page.evaluate(() => {
            const c = document.getElementById('c');
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#2471a3';
            ctx.fillRect(0, 0, 96, 32);
            ctx.fillStyle = '#f1c40f';
            ctx.fillText('VerifyRotation', 4, 20);
            const dataUrl = c.toDataURL();

            const glCanvas = document.createElement('canvas');
            const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
            let gpuRenderer = null;
            if (gl) {
              gl.getExtension('WEBGL_debug_renderer_info');
              gpuRenderer = gl.getParameter(37446);
            }
            return {
              ua: navigator.userAgent,
              webdriver: navigator.webdriver,
              vendor: navigator.vendor,
              hasChUa: Boolean(navigator.userAgentData),
              gpuRenderer,
              dataUrl,
            };
          });

          const canvasHash = crypto
            .createHash('sha256')
            .update(domInfo.dataUrl)
            .digest('hex')
            .slice(0, 10);

          // 2. Verify matching TlsHttpClient handshake against live Reddit `/login/`
          let redditStatus = null;
          let redditWafClean = true;
          let redditChallengeDetected = false;

          if (checkRedditLive) {
            await this._pacePerIpIfShared(sess.lease.proxy);
            const tlsClient = new TlsHttpClient({
              proxy: sess.lease.proxy,
              profile: sess.solverProfile,
              enableRateLimit: false,
            });
            try {
              const res = await tlsClient.get('https://www.reddit.com/login/', {
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
              });
              redditStatus = res.status;
              redditWafClean = res.status === 200 && !isHumanityBlockPage(res.text);
              redditChallengeDetected = parseRedditJsChallenge(res.text).isChallenge;
            } finally {
              await tlsClient.close();
            }
          }

          const domMatchesProfile =
            domInfo.webdriver === false &&
            domInfo.ua === sess.profile.navigator.userAgent &&
            domInfo.gpuRenderer === sess.profile.gpu.renderer;

          return {
            workerId: sess.workerId,
            brandId: sess.brandId,
            version: sess.profile.versionMajor,
            engine: sess.engine,
            os: sess.os,
            tlsClientId: sess.tlsSessionOptions.clientIdentifier,
            signatureId: sess.profile.signatureId.slice(0, 12),
            canvasHash,
            parityValid: parity.valid,
            domMatchesProfile,
            redditStatus,
            redditWafClean,
            redditChallengeDetected,
            elapsedMs: Date.now() - wStart,
          };
        })
      );

      const uniqueBrands = new Set(workerReports.map((w) => w.brandId));
      const uniqueEngines = new Set(workerReports.map((w) => w.engine));
      const uniqueSignatures = new Set(workerReports.map((w) => w.signatureId));
      const uniqueCanvas = new Set(workerReports.map((w) => w.canvasHash));

      const maxPossibleBrands = this.rotationMode === 'single-engine' ? 6 : 9;
      const expectedUniqueBrands = Math.min(workerCount, maxPossibleBrands);

      const allOk =
        uniqueBrands.size >= expectedUniqueBrands &&
        uniqueSignatures.size === workerCount &&
        uniqueCanvas.size === workerCount &&
        workerReports.every((w) => w.parityValid && w.domMatchesProfile && w.redditWafClean);

      if (printTable) {
        console.log('\n' + '='.repeat(114));
        console.log(
          `HYBRID ROTATION LIVE VERIFICATION — Mode: ${this.rotationMode} | Concurrent Workers: ${workerCount} | Shared OS Processes: ${midPoolStatus.sharedEngineProcessCount}`
        );
        console.log('='.repeat(114));
        console.log(
          '  ' +
            'Worker'.padEnd(11) +
            'Brand'.padEnd(20) +
            'Ver'.padEnd(6) +
            'Engine'.padEnd(10) +
            'OS'.padEnd(9) +
            'TLS Profile'.padEnd(16) +
            'Canvas'.padEnd(12) +
            'DOM'.padEnd(6) +
            'Reddit WAF'
        );
        console.log('  ' + '-'.repeat(110));
        for (const w of workerReports) {
          const wafLabel = checkRedditLive
            ? w.redditWafClean
              ? `HTTP ${w.redditStatus} CLEAN`
              : `HTTP ${w.redditStatus} BLOCKED`
            : 'SKIPPED';
          console.log(
            '  ' +
              w.workerId.padEnd(11) +
              w.brandId.padEnd(20) +
              String(w.version).padEnd(6) +
              w.engine.padEnd(10) +
              w.os.padEnd(9) +
              w.tlsClientId.padEnd(16) +
              w.canvasHash.padEnd(12) +
              (w.domMatchesProfile ? 'OK' : 'ERR').padEnd(6) +
              wafLabel
          );
        }
        console.log('='.repeat(114));
        console.log(
          `  Summary: ${uniqueBrands.size}/${workerCount} Unique Brands | ${uniqueEngines.size} Native Engines [${[
            ...uniqueEngines,
          ].join(', ')}] | ${uniqueCanvas.size}/${workerCount} Unique Canvas | Verdict: ${
            allOk ? 'PASS (ZERO COLLISIONS)' : 'WARN'
          }`
        );
        console.log('='.repeat(114) + '\n');
      }

      return {
        ok: allOk,
        rotationMode: this.rotationMode,
        workerCount,
        sharedEngineProcessCount: midPoolStatus.sharedEngineProcessCount,
        uniqueBrandCount: uniqueBrands.size,
        uniqueEngineCount: uniqueEngines.size,
        uniqueSignatureCount: uniqueSignatures.size,
        uniqueCanvasCount: uniqueCanvas.size,
        elapsedMs: Date.now() - startedAt,
        workers: workerReports,
      };
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  }

  async shutdown() {
    await this.enginePool.shutdown();
  }
}

module.exports = {
  RotationWorkerPool,
};
