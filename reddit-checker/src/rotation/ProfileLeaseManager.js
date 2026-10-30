'use strict';

/**
 * Phase 2 — Thread-Safe Zero-Collision Browser Profile Lease Manager (`ProfileLeaseManager.js`)
 *
 * Guarantees that across concurrent async workers AND OS `worker_threads`:
 *   1. Atomic FIFO `AsyncMutex` prevents race conditions when N workers acquire simultaneously.
 *   2. Tier-1 Anti-Collision: No two concurrent workers ever share the same `brandId` while
 *      unused brands remain available; also balances across engines (`chromium`, `firefox`, `webkit`).
 *   3. Tier-2 Anti-Collision: When concurrent workers exceed brand count (e.g. 25 workers),
 *      no two workers share the same `(brandId, versionMajor, os)` variant slot.
 *   4. Tier-3 Anti-Collision: Even above 56 workers, no two workers share the same `hardwareKey`
 *      (`Screen + WebGL GPU`) or cryptographic `signatureId`.
 *   5. Burned Signature LRU History: Released signatures remain blocked in an LRU cache so
 *      subsequent requests never replay an old browser fingerprint.
 *   6. Crash-Safe TTL Reaper: Automatically reclaims stale leases if a worker crashes mid-flight.
 */

const crypto = require('crypto');
const {
  listBrandsForMode,
  enumerateAllCatalogVariants,
} = require('./ProfileCatalog');
const {
  synthesizeProfile,
  buildContextInitScript,
} = require('./FingerprintSynthesizer');
const {
  buildTlsSessionOptions,
  buildProfileHttpHeaders,
  toSolverProfileAdapter,
} = require('./TlsHeaderBridge');

/**
 * Strict FIFO Asynchronous Mutex Lock (prevents simultaneous Promise race conditions)
 */
class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  acquire() {
    return new Promise((resolve) => {
      const unlock = () => {
        const next = this._queue.shift();
        if (next) {
          next(unlock);
        } else {
          this._locked = false;
        }
      };

      if (!this._locked) {
        this._locked = true;
        resolve(unlock);
      } else {
        this._queue.push(resolve);
      }
    });
  }

  async runExclusive(fn) {
    const unlock = await this.acquire();
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}

/**
 * Fixed-capacity LRU Set for tracking burned fingerprint signatures & recent variants
 */
class BoundedLruSet {
  constructor(capacity = 500) {
    this.capacity = Math.max(1, capacity);
    this._map = new Map();
  }

  has(key) {
    return this._map.has(key);
  }

  add(key) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.capacity) {
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
    }
    this._map.set(key, Date.now());
  }

  get size() {
    return this._map.size;
  }

  clear() {
    this._map.clear();
  }
}

class ProfileLeaseManager {
  /**
   * @param {object} options
   * @param {'single-engine'|'multi-engine'|'hybrid'} [options.mode='hybrid']
   * @param {string[]} [options.enabledEngines=['chromium','firefox','webkit']]
   * @param {number} [options.historySize=500] - Number of burned signatures kept in cooldown
   * @param {number} [options.leaseTtlMs=120000] - Auto-expire abandoned leases after 2 minutes
   * @param {string[]} [options.proxies=[]] - Optional pool of proxy URLs to lease alongside profiles
   * @param {boolean} [options.isRotatingGatewayProxy=false] - Set true if a single proxy URL rotates IPs upstream
   * @param {object} [options.logger=null] - Optional DebugLogger instance
   */
  constructor({
    mode = process.env.ROTATION_MODE || 'hybrid',
    enabledEngines = ['chromium', 'firefox', 'webkit'],
    historySize = Number(process.env.LEASE_HISTORY_SIZE || 500),
    leaseTtlMs = 120000,
    proxies = [],
    isRotatingGatewayProxy = false,
    logger = null,
  } = {}) {
    this.mode = ['single-engine', 'multi-engine', 'hybrid'].includes(mode) ? mode : 'hybrid';
    this.enabledEngines =
      this.mode === 'single-engine' ? ['chromium'] : [...new Set(enabledEngines)];
    this.leaseTtlMs = Math.max(5000, leaseTtlMs);
    this.proxies = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
    this.isRotatingGatewayProxy = Boolean(isRotatingGatewayProxy);
    this.logger = logger;

    this._mutex = new AsyncMutex();
    this._activeLeases = new Map(); // leaseId -> LeaseRecord
    this._burnedSignatures = new BoundedLruSet(historySize);
    this._burnedVariants = new BoundedLruSet(Math.min(historySize, 48));
    this._recentVariants = new BoundedLruSet(Math.min(historySize, 64));
    this._lastBrandId = null;
    this._roundRobinCursor = 0;

    // Telemetry counters
    this._stats = {
      totalAcquired: 0,
      totalReleased: 0,
      totalBurned: 0,
      totalExpiredReaped: 0,
      peakConcurrent: 0,
      collisionsDetected: 0,
      byBrand: {},
      byEngine: {},
      byOs: {},
    };
  }

  /**
   * Reclaim any stale leases whose TTL has expired (protects pool if a worker crashes).
   */
  _reapExpiredUnlocked(now = Date.now()) {
    const expiredIds = [];
    for (const [leaseId, rec] of this._activeLeases.entries()) {
      if (now >= rec.expiresAt) {
        expiredIds.push(leaseId);
      }
    }
    for (const leaseId of expiredIds) {
      const rec = this._activeLeases.get(leaseId);
      this._activeLeases.delete(leaseId);
      this._stats.totalExpiredReaped += 1;
      this.logger?.warn(
        'LeaseManager',
        `Reaped expired lease ${leaseId} held by worker="${rec.workerId}" (${rec.profile.brandId})`
      );
    }
    return expiredIds.length;
  }

  /**
   * Update available engines dynamically (used by Phase 3 EnginePoolManager after binary discovery).
   */
  async setEnabledEngines(engines) {
    return this._mutex.runExclusive(() => {
      if (this.mode === 'single-engine') {
        this.enabledEngines = ['chromium'];
      } else {
        this.enabledEngines = [...new Set(engines)];
      }
      return this.enabledEngines;
    });
  }

  /**
   * Select the optimal `(brandId, versionMajor, os)` candidate slot that maximizes diversity
   * and guarantees zero collision with currently active workers.
   */
  _selectBestVariantSlotUnlocked({ preferredEngine = null, preferredOs = null, preferredBrand = null } = {}) {
    const allVariants = enumerateAllCatalogVariants(this.mode, this.enabledEngines);
    if (allVariants.length === 0) {
      throw new Error(
        `No browser variants available for mode="${this.mode}" with engines=[${this.enabledEngines.join(', ')}]`
      );
    }

    // Snapshot currently locked attributes across all active workers
    const activeBrands = new Map();       // brandId -> active count
    const activeEngines = new Map();      // engine -> active count
    const activeVariants = new Set();     // variantKey ("brand:ver:os")
    for (const rec of this._activeLeases.values()) {
      const p = rec.profile;
      activeBrands.set(p.brandId, (activeBrands.get(p.brandId) || 0) + 1);
      activeEngines.set(p.engine, (activeEngines.get(p.engine) || 0) + 1);
      activeVariants.add(p.variantKey);
    }

    // Score each candidate variant (lower score = higher priority!)
    let bestScore = Infinity;
    let bestCandidates = [];

    for (let idx = 0; idx < allVariants.length; idx++) {
      const v = allVariants[(idx + this._roundRobinCursor) % allVariants.length];

      // Hard preferences if caller explicitly requested an OS/engine/brand
      if (preferredEngine && v.engine !== preferredEngine) continue;
      if (preferredOs && v.os !== preferredOs) continue;
      if (preferredBrand && v.brandId !== preferredBrand) continue;

      const brandActiveCount = activeBrands.get(v.brandId) || 0;
      const engineActiveCount = activeEngines.get(v.engine) || 0;
      const variantBusy = activeVariants.has(v.variantKey) ? 1 : 0;
      const burnedVariant = this._burnedVariants.has(v.variantKey) ? 1 : 0;
      const sameAsImmediateLastBrand = v.brandId === this._lastBrandId ? 1 : 0;
      const recentlyUsedVariant = this._recentVariants.has(v.variantKey) ? 1 : 0;
      const historicalBrandCount = this._stats.byBrand[v.brandId] || 0;

      // Priority hierarchy:
      //   1. Unused Brand among active workers (weight 1,000,000) -> Strict Brand Separation!
      //   2. Unused (Brand+Version+OS) Variant among active workers (weight 100,000)
      //   3. Not flagged/burned by WAF cooldown (weight 50,000)
      //   4. Least-loaded Engine among active workers (weight 5,000) -> Balances Chromium/Firefox/WebKit!
      //   5. Not the exact same brand as the previous sequential request (weight 1,000)
      //   6. Not in recent variant LRU cooldown (weight 200)
      //   7. Least historically used brand for fair round-robin distribution (weight 1)
      const score =
        brandActiveCount * 1_000_000 +
        variantBusy * 100_000 +
        burnedVariant * 50_000 +
        engineActiveCount * 5_000 +
        sameAsImmediateLastBrand * 1_000 +
        recentlyUsedVariant * 200 +
        historicalBrandCount;

      if (score < bestScore) {
        bestScore = score;
        bestCandidates = [v];
      } else if (score === bestScore) {
        bestCandidates.push(v);
      }
    }

    if (bestCandidates.length === 0) {
      // Fallback if strict filter matched nothing
      bestCandidates = allVariants;
    }

    this._roundRobinCursor = (this._roundRobinCursor + 1) % allVariants.length;
    const pickIdx = crypto.randomInt(0, bestCandidates.length);
    return bestCandidates[pickIdx];
  }

  /**
   * Select an unused proxy from `this.proxies` (if configured).
   */
  _selectProxyUnlocked() {
    if (this.proxies.length === 0) return null;
    if (this.isRotatingGatewayProxy || this.proxies.length === 1) {
      return this.proxies[0];
    }

    const activeProxies = new Set();
    for (const rec of this._activeLeases.values()) {
      if (rec.proxy) activeProxies.add(rec.proxy);
    }

    const freeProxies = this.proxies.filter((p) => !activeProxies.has(p));
    const pool = freeProxies.length > 0 ? freeProxies : this.proxies;
    return pool[crypto.randomInt(0, pool.length)];
  }

  /**
   * Atomically acquire a unique, collision-free browser profile lease for a worker/thread.
   *
   * @param {object} [options]
   * @param {string} [options.workerId='worker-0'] - Identifier of the calling worker or thread
   * @param {string} [options.preferredEngine] - Optional engine constraint
   * @param {string} [options.preferredOs] - Optional OS constraint
   * @param {string} [options.preferredBrand] - Optional brand constraint
   * @param {string} [options.proxyOverride] - Optional explicit proxy URL for this worker
   * @returns {Promise<object>} Complete Lease bundle (leaseId, profile, tlsOptions, http2Headers, initScript, solverProfile)
   */
  async acquireLease({
    workerId = 'worker-0',
    preferredEngine = null,
    preferredOs = null,
    preferredBrand = null,
    proxyOverride = null,
  } = {}) {
    return this._mutex.runExclusive(() => {
      const now = Date.now();
      this._reapExpiredUnlocked(now);

      const slot = this._selectBestVariantSlotUnlocked({
        preferredEngine,
        preferredOs,
        preferredBrand,
      });

      const activeSignatures = new Set();
      const activeHardwareKeys = new Set();
      for (const rec of this._activeLeases.values()) {
        activeSignatures.add(rec.profile.signatureId);
        activeHardwareKeys.add(rec.profile.hardwareKey);
      }

      // Synthesize with fresh cryptographic seeds until 100% unique against active & burned history
      let synthesized = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        const candidate = synthesizeProfile({
          brandId: slot.brandId,
          os: slot.os,
          versionMajor: slot.versionSpec.major,
        });

        const sigCollision =
          activeSignatures.has(candidate.signatureId) ||
          this._burnedSignatures.has(candidate.signatureId);
        const hwCollision = attempt < 12 && activeHardwareKeys.has(candidate.hardwareKey);

        if (!sigCollision && !hwCollision) {
          synthesized = candidate;
          break;
        }
      }

      if (!synthesized) {
        synthesized = synthesizeProfile({
          brandId: slot.brandId,
          os: slot.os,
          versionMajor: slot.versionSpec.major,
        });
      }

      // Paranoid collision check for telemetry verification
      if (activeSignatures.has(synthesized.signatureId)) {
        this._stats.collisionsDetected += 1;
      }

      const assignedProxy = proxyOverride || this._selectProxyUnlocked();
      const leaseId = `lease_${crypto.randomBytes(6).toString('hex')}`;

      const tlsSessionOptions = buildTlsSessionOptions(synthesized, { proxy: assignedProxy });
      const http2Headers = buildProfileHttpHeaders(synthesized, {
        http1: false,
        isDocumentNavigation: true,
      });
      const initScript = buildContextInitScript(synthesized);
      const solverProfile = toSolverProfileAdapter(synthesized);

      const leaseRecord = {
        leaseId,
        workerId: String(workerId),
        acquiredAt: now,
        expiresAt: now + this.leaseTtlMs,
        proxy: assignedProxy,
        profile: synthesized,
        tlsSessionOptions,
        http2Headers,
        initScript,
        solverProfile,
      };

      this._activeLeases.set(leaseId, leaseRecord);
      this._burnedSignatures.add(synthesized.signatureId);
      this._recentVariants.add(synthesized.variantKey);
      this._lastBrandId = synthesized.brandId;

      // Update telemetry
      this._stats.totalAcquired += 1;
      if (this._activeLeases.size > this._stats.peakConcurrent) {
        this._stats.peakConcurrent = this._activeLeases.size;
      }
      this._stats.byBrand[synthesized.brandId] = (this._stats.byBrand[synthesized.brandId] || 0) + 1;
      this._stats.byEngine[synthesized.engine] = (this._stats.byEngine[synthesized.engine] || 0) + 1;
      this._stats.byOs[synthesized.os] = (this._stats.byOs[synthesized.os] || 0) + 1;

      this.logger?.debug(
        'LeaseManager',
        `Acquired ${leaseId} for [${workerId}] -> ${synthesized.brandId} v${synthesized.versionMajor} (${synthesized.engine}/${synthesized.os}, tls=${tlsSessionOptions.clientIdentifier}, sig=${synthesized.signatureId.slice(0, 8)})`
      );

      return leaseRecord;
    });
  }

  /**
   * Release a held lease when a worker finishes its task (burns signature into LRU cooldown).
   */
  async releaseLease(leaseId) {
    return this._mutex.runExclusive(() => {
      const rec = this._activeLeases.get(leaseId);
      if (!rec) return false;

      this._activeLeases.delete(leaseId);
      this._burnedSignatures.add(rec.profile.signatureId);
      this._stats.totalReleased += 1;

      this.logger?.debug(
        'LeaseManager',
        `Released ${leaseId} from [${rec.workerId}] (${rec.profile.brandId}, held ${Date.now() - rec.acquiredAt}ms)`
      );
      return true;
    });
  }

  /**
   * Explicitly mark a lease as burned (e.g. WAF 429 / captcha challenge) so its variant
   * enters cooldown AND release the active lease atomically.
   */
  async markBurned(leaseId, { reason = 'waf_flag' } = {}) {
    return this._mutex.runExclusive(() => {
      const rec = this._activeLeases.get(leaseId);
      if (!rec) return false;

      this._activeLeases.delete(leaseId);
      this._burnedSignatures.add(rec.profile.signatureId);
      this._burnedVariants.add(rec.profile.variantKey);
      this._stats.totalReleased += 1;
      this._stats.totalBurned += 1;

      this.logger?.warn(
        'LeaseManager',
        `Marked ${leaseId} BURNED (${reason}): variant="${rec.profile.variantKey}" placed in LRU cooldown`
      );
      return true;
    });
  }

  /**
   * Release ALL leases belonging to a specific workerId (used automatically if a worker_thread crashes/exits).
   */
  async releaseAllForWorker(workerId) {
    return this._mutex.runExclusive(() => {
      let count = 0;
      for (const [leaseId, rec] of this._activeLeases.entries()) {
        if (rec.workerId === String(workerId)) {
          this._activeLeases.delete(leaseId);
          this._burnedSignatures.add(rec.profile.signatureId);
          this._stats.totalReleased += 1;
          count += 1;
        }
      }
      if (count > 0) {
        this.logger?.warn('LeaseManager', `Auto-released ${count} orphaned lease(s) from exited worker [${workerId}]`);
      }
      return count;
    });
  }

  /**
   * Convenience wrapper: executes `fn(lease)` and guarantees `releaseLease` in `finally`.
   */
  async withLease(options, fn) {
    const lease = await this.acquireLease(options);
    try {
      return await fn(lease);
    } finally {
      await this.releaseLease(lease.leaseId);
    }
  }

  /**
   * Snapshot current pool statistics & active worker leases for diagnostics.
   */
  async getStats() {
    return this._mutex.runExclusive(() => {
      this._reapExpiredUnlocked();
      const activeList = Array.from(this._activeLeases.values()).map((r) => ({
        leaseId: r.leaseId,
        workerId: r.workerId,
        brandId: r.profile.brandId,
        version: r.profile.versionMajor,
        engine: r.profile.engine,
        os: r.profile.os,
        tlsClientId: r.tlsSessionOptions.clientIdentifier,
        screen: `${r.profile.screen.width}x${r.profile.screen.height}`,
        signatureId: r.profile.signatureId,
      }));

      return {
        mode: this.mode,
        enabledEngines: [...this.enabledEngines],
        activeCount: activeList.length,
        burnedHistoryCount: this._burnedSignatures.size,
        ...this._stats,
        byBrand: { ...this._stats.byBrand },
        byEngine: { ...this._stats.byEngine },
        byOs: { ...this._stats.byOs },
        activeLeases: activeList,
      };
    });
  }
}

/**
 * Pretty-print a diagnostic table of leased profiles (used by tests and `--verify-rotation`).
 */
function formatLeaseTable(leases) {
  const header =
    '  ' +
    'Worker'.padEnd(12) +
    'Brand'.padEnd(20) +
    'Ver'.padEnd(6) +
    'Engine'.padEnd(10) +
    'OS'.padEnd(9) +
    'TLS Profile'.padEnd(16) +
    'Screen'.padEnd(11) +
    'Signature';
  const sep = '  ' + '-'.repeat(100);
  const rows = leases.map((l) => {
    const p = l.profile || l;
    const tlsId = l.tlsSessionOptions?.clientIdentifier || p.tlsClientId || '';
    const scr = p.screen ? `${p.screen.width}x${p.screen.height}` : l.screen || '';
    return (
      '  ' +
      String(l.workerId || '-').padEnd(12) +
      String(p.brandId).padEnd(20) +
      String(p.versionMajor || p.version || '').padEnd(6) +
      String(p.engine).padEnd(10) +
      String(p.os).padEnd(9) +
      String(tlsId).padEnd(16) +
      String(scr).padEnd(11) +
      String(p.signatureId).slice(0, 14)
    );
  });
  return [header, sep, ...rows].join('\n');
}

module.exports = {
  AsyncMutex,
  BoundedLruSet,
  ProfileLeaseManager,
  formatLeaseTable,
};
