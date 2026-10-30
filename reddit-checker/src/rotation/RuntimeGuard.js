'use strict';

/**
 * RuntimeGuard — the small, boring pieces that keep a long-running checker process healthy.
 *
 *   1. `envInt()`          — NaN-proof numeric env parsing (a typo in `.env` must never turn a
 *                            timeout into `NaN` and silently disable a safety net).
 *   2. `installGracefulShutdown()` — closes browsers / TLS sessions on Ctrl+C, SIGTERM or a hard
 *                            exit, so a Windows run never leaves zombie Chromium windows holding
 *                            the profile locks and 300MB each.
 *   3. `writeJsonAtomic()` — tmp-file + rename, so a crash mid-write cannot corrupt
 *                            `results/device_cache.json` (which is now on by default).
 *   4. `formatDuration()`  — one consistent "1m 12s" renderer for logs/summaries.
 */

const fs = require('fs');
const path = require('path');

/** Parse an integer env var with clamping; never returns NaN. */
function envInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Parse a boolean-ish env var (`1/true/yes/on` vs `0/false/no/off`). */
function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
  return fallback;
}

/**
 * Register shutdown hooks that run exactly once.
 *
 * @param {object} opts
 * @param {Function} opts.onShutdown  async cleanup (close pools, destroy sessions)
 * @param {object}  [opts.logger]
 * @param {string}  [opts.name='process']
 * @param {number}  [opts.timeoutMs=15000] hard deadline before a forced exit
 * @returns {Function} manual `shutdown(reason)` for tests / normal completion
 */
function installGracefulShutdown({
  onShutdown,
  logger = null,
  name = 'process',
  timeoutMs = 15000,
} = {}) {
  let running = null;
  let done = false;

  // Never leave a Node process hanging on a stray handle: if cleanup itself misbehaves, the
  // deadline wins. This is what keeps Ctrl+C on Windows from leaving Chromium behind.
  const run = (reason) => {
    if (done) return Promise.resolve();
    if (running) return running;
    done = true;

    running = Promise.resolve()
      .then(() => onShutdown?.(reason))
      .catch((err) => {
        logger?.warn?.('Shutdown', `cleanup error: ${err?.message || err}`);
      })
      .finally(() => {
        logger?.info?.('Shutdown', `[${name}] cleanup finished (${reason})`);
      });

    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.('Shutdown', `[${name}] cleanup exceeded ${timeoutMs}ms — forcing exit`);
        resolve();
      }, timeoutMs);
      // Deliberately NOT unref'd: an unref'd deadline lets Node exit mid-cleanup and the caller
      // would never learn that the timeout fired. It is cleared in `finally` right after the race.
    });

    return Promise.race([running, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map();
  for (const sig of signals) {
    if (process.platform === 'win32' && sig === 'SIGHUP') continue;
    const handler = () => {
      logger?.warn?.('Shutdown', `[${name}] ${sig} received — closing browsers & TLS sessions...`);
      run(sig)
        .catch(() => {})
        .finally(() => {
          // 128 + signal number is the conventional exit code (130 for SIGINT).
          process.exitCode = sig === 'SIGINT' ? 130 : 143;
          // Give stdout a tick to flush before the process actually goes away.
          setTimeout(() => process.exit(process.exitCode), 10).unref?.();
        });
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }

  // A browser pool that is still shutting down must not be torn out from under libuv.
  const beforeExit = () => {
    if (!done) run('beforeExit').catch(() => {});
  };
  process.once('beforeExit', beforeExit);

  const dispose = () => {
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
    process.removeListener('beforeExit', beforeExit);
  };

  return Object.assign(
    (reason = 'manual') => run(reason),
    { dispose, isDone: () => done }
  );
}

/** Atomic JSON write (tmp + rename) — survives a crash without corrupting the previous file. */
function writeJsonAtomic(filePath, data, { pretty = true } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows can refuse the rename if an AV scanner holds the file; fall back to a direct write
    // rather than losing the cache update.
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, pretty ? 2 : 0), 'utf-8');
    } catch {
      /* cache is best-effort */
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    if (!fs.existsSync(filePath)) throw err;
  }
  return filePath;
}

/** Human duration: 950ms · 12.4s · 3m 07s · 1h 04m */
function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '0ms';
  if (n < 1000) return `${Math.round(n)}ms`;
  const totalSec = n / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
}

module.exports = {
  envInt,
  envBool,
  installGracefulShutdown,
  writeJsonAtomic,
  formatDuration,
};
