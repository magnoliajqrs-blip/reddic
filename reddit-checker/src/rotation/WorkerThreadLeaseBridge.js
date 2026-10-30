'use strict';

/**
 * Phase 2 — Multi-Thread IPC Coordinator (`WorkerThreadLeaseBridge.js`)
 *
 * Bridges Node.js `worker_threads` (`Worker` / `parentPort` / `MessagePort`) to a SINGLE
 * central `ProfileLeaseManager` on the main thread so that parallel OS threads NEVER
 * run the same browser brand, variant, or TLS/JS fingerprint simultaneously.
 *
 * Includes automatic crash cleanup: if a `Worker` thread exits unexpectedly while holding
 * an active lease, all leases owned by that thread are immediately released back to the pool.
 */

const crypto = require('crypto');

const RPC_CHANNEL_TAG = '__reddit_rotation_lease_rpc_v1__';

/**
 * Main-thread host helper: attaches a `Worker` (or `MessagePort`) to a central `ProfileLeaseManager`.
 *
 * @param {import('node:worker_threads').Worker | import('node:worker_threads').MessagePort} target
 * @param {import('./ProfileLeaseManager').ProfileLeaseManager} leaseManager
 * @param {object} [options]
 * @param {string} [options.workerId] - Stable label for this worker thread (defaults to `thread-<threadId>`)
 * @returns {{ detach: () => void, workerId: string }}
 */
function attachLeaseManagerToWorker(target, leaseManager, options = {}) {
  if (!target || typeof target.on !== 'function' || typeof target.postMessage !== 'function') {
    throw new Error('attachLeaseManagerToWorker requires a valid Worker or MessagePort');
  }
  if (!leaseManager || typeof leaseManager.acquireLease !== 'function') {
    throw new Error('attachLeaseManagerToWorker requires a valid ProfileLeaseManager instance');
  }

  const workerId =
    options.workerId ||
    (typeof target.threadId === 'number'
      ? `thread-${target.threadId}`
      : `thread-${crypto.randomBytes(3).toString('hex')}`);

  const onMessage = async (msg) => {
    if (!msg || msg.channel !== RPC_CHANNEL_TAG || !msg.requestId) return;

    const { requestId, action, payload = {} } = msg;
    try {
      let result;
      if (action === 'acquireLease') {
        result = await leaseManager.acquireLease({
          ...payload,
          workerId: payload.workerId || workerId,
        });
      } else if (action === 'releaseLease') {
        result = await leaseManager.releaseLease(payload.leaseId);
      } else if (action === 'markBurned') {
        result = await leaseManager.markBurned(payload.leaseId, payload.options || {});
      } else if (action === 'getStats') {
        result = await leaseManager.getStats();
      } else {
        throw new Error(`Unsupported lease RPC action: "${action}"`);
      }

      target.postMessage({
        channel: RPC_CHANNEL_TAG,
        requestId,
        ok: true,
        result,
      });
    } catch (err) {
      target.postMessage({
        channel: RPC_CHANNEL_TAG,
        requestId,
        ok: false,
        error: err?.message || String(err),
      });
    }
  };

  const onExit = () => {
    leaseManager.releaseAllForWorker(workerId).catch(() => {});
  };

  target.on('message', onMessage);
  target.once('exit', onExit);

  return {
    workerId,
    detach() {
      target.off?.('message', onMessage);
      target.off?.('exit', onExit);
    },
  };
}

/**
 * Worker-thread client: drop-in async proxy matching `ProfileLeaseManager`'s `acquireLease`,
 * `releaseLease`, `withLease`, and `getStats` methods over `parentPort` or a `MessagePort`.
 */
class WorkerLeaseClient {
  /**
   * @param {import('node:worker_threads').MessagePort} [port] - Defaults to `require('node:worker_threads').parentPort`
   * @param {object} [options]
   * @param {number} [options.timeoutMs=15000]
   * @param {string} [options.workerId]
   */
  constructor(port = null, { timeoutMs = 15000, workerId = null } = {}) {
    const wt = require('node:worker_threads');
    this.port = port || wt.parentPort;
    if (!this.port) {
      throw new Error('WorkerLeaseClient must be used inside a worker_thread or given a MessagePort');
    }
    this.timeoutMs = timeoutMs;
    this.workerId = workerId || `thread-${wt.threadId}`;
    this._pending = new Map();

    this._onMessage = (msg) => {
      if (!msg || msg.channel !== RPC_CHANNEL_TAG || !msg.requestId) return;
      const entry = this._pending.get(msg.requestId);
      if (!entry) return;

      clearTimeout(entry.timer);
      this._pending.delete(msg.requestId);

      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || 'WorkerLeaseClient RPC failed'));
      }
    };

    this.port.on('message', this._onMessage);
  }

  _rpc(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `rpc_${crypto.randomBytes(6).toString('hex')}`;

      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error(`WorkerLeaseClient RPC "${action}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this._pending.set(requestId, { resolve, reject, timer });
      this.port.postMessage({
        channel: RPC_CHANNEL_TAG,
        requestId,
        action,
        payload,
      });
    });
  }

  acquireLease(options = {}) {
    return this._rpc('acquireLease', {
      workerId: this.workerId,
      ...options,
    });
  }

  releaseLease(leaseId) {
    return this._rpc('releaseLease', { leaseId });
  }

  markBurned(leaseId, options = {}) {
    return this._rpc('markBurned', { leaseId, options });
  }

  getStats() {
    return this._rpc('getStats', {});
  }

  async withLease(options, fn) {
    const lease = await this.acquireLease(options);
    try {
      return await fn(lease);
    } finally {
      await this.releaseLease(lease.leaseId);
    }
  }

  close() {
    for (const [, entry] of this._pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WorkerLeaseClient closed'));
    }
    this._pending.clear();
    if (typeof this.port.off === 'function') {
      this.port.off('message', this._onMessage);
    } else if (typeof this.port.removeListener === 'function') {
      this.port.removeListener('message', this._onMessage);
    }
  }
}

module.exports = {
  RPC_CHANNEL_TAG,
  attachLeaseManagerToWorker,
  WorkerLeaseClient,
};
