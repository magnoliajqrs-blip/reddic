'use strict';

/**
 * Reddit Login Solver with reCAPTCHA Enterprise v3 — Fixed & Enhanced Debug Edition
 *
 * Complete 4-Step Flow:
 *   1. Reddit JS Challenge (GET /login/ -> parse dynamic form & jsc_token -> solve -> fetch login-step partial)
 *   2. reCAPTCHA Enterprise Config Discovery (live site-key, captcha-action, release version)
 *   3. reCAPTCHA Token Acquisition:
 *        - Browser mode: Puppeteer-Extra + StealthPlugin (synced cookies + matching UA/fingerprint)
 *        - HTTP mode:    Anchor + Protobuf Reload (live v= discovery, zero browser overhead)
 *        - Auto mode:    Browser primary with automatic HTTP fallback
 *   4. Reddit Shreddit Login API (POST /svc/shreddit/account/login + Faceplate HTML/JSON & JWT verification)
 *
 * CLI Usage:
 *   node reddit_solver.js --test                          # Run unit & regression test suite
 *   node reddit_solver.js --diagnose [--debug]            # Live non-destructive protocol diagnostics
 *   node reddit_solver.js [--mode auto|browser|http]      # Acquire reCAPTCHA token only
 *   node reddit_solver.js --login <user> <pass> [--debug] # Full 4-step login flow
 *
 * Debug Flags:
 *   --debug            Enable structured debug logs, HTTP trace, cookie deltas & failure dumps
 *   --trace            Maximum verbosity (headers, partial body excerpts, browser network events)
 *   --debug-unmasked   Show unmasked tokens/cookies in debug output (passwords always redacted)
 *   --dump             Save HTML/JSON/screenshot artifacts for every run to ./debug_artifacts
 *   --dump-dir <path>  Custom directory for debug artifacts
 *   --mode <mode>      Solver mode: auto (default) | browser | http
 *   --proxy <url>      HTTP/HTTPS proxy URL (e.g. http://user:pass@host:port)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const zlib = require('zlib');
const { Buffer } = require('buffer');
const { URL, URLSearchParams } = require('url');
const { Session, initTLS, destroyTLS } = require('node-tls-client');
const {
  BROWSER_CATALOG,
  synthesizeProfile,
  buildTlsSessionOptions,
  buildProfileHttpHeaders,
  toSolverProfileAdapter,
  ProfileLeaseManager,
  EnginePoolManager,
  resolveEffectiveHeadless,
  discoverEngineBinaries,
  RotationWorkerPool,
  createNetworkTracker,
  waitForBrowserReady,
} = require('./src/rotation');

/**
 * Ensure Windows `%TEMP%\tls-client-64.dll` is healthy before `initTLS()` loads it via Koffi:
 *   1. Deletes any partial/0-byte `< 10MB` file in `%TEMP%` that would break `koffi.load()`.
 *   2. Restores from `<project>/.bin_cache/tls-client-64.dll` if `install.bat` cached it under another Admin/User `%TEMP%`.
 */
function ensureWindowsTlsDllReady() {
  if (process.platform !== 'win32') return;
  const dllName = process.arch === 'x64' ? 'tls-client-64.dll' : 'tls-client-32.dll';
  const tempDll = path.join(os.tmpdir(), dllName);
  const cachedDll = path.join(__dirname, '.bin_cache', dllName);
  const MIN_VALID_BYTES = 10 * 1024 * 1024;

  try {
    if (fs.existsSync(tempDll)) {
      const sz = fs.statSync(tempDll).size;
      if (sz >= MIN_VALID_BYTES) {
        if (!fs.existsSync(cachedDll)) {
          fs.mkdirSync(path.dirname(cachedDll), { recursive: true });
          fs.copyFileSync(tempDll, cachedDll);
        }
        return;
      }
      fs.unlinkSync(tempDll);
    }
    if (fs.existsSync(cachedDll) && fs.statSync(cachedDll).size >= MIN_VALID_BYTES) {
      fs.copyFileSync(cachedDll, tempDll);
    }
  } catch {}
}

/**
 * Locate the `node-tls-client` native library that `initTLS()` loads through Koffi.
 *
 * The library stores it in `os.tmpdir()` and, when it is missing, downloads it - and on a
 * failed download it calls `process.exit(1)` from inside the dependency, which looks like a
 * silent crash. Knowing this up-front lets us warn the user (and lets tests skip) instead.
 *
 * @returns {{ok:boolean,platform:string,arch:string,fileName:string,tempPath:string,cachedPath:string|null}}
 */
function getTlsClientAssetInfo() {
  const nameByPlatform = {
    win32: { x64: 'tls-client-64.dll', ia32: 'tls-client-32.dll' },
    darwin: { arm64: 'tls-client-arm64.dylib', x64: 'tls-client-x86.dylib' },
    linux: { x64: 'tls-client-x64.so', arm64: 'tls-client-arm64.so', ia32: 'tls-client-x64.so' },
  };
  const platformMap = nameByPlatform[process.platform] || {};
  const fileName = platformMap[process.arch] || platformMap.x64 || 'tls-client-x64.so';
  const tempPath = path.join(os.tmpdir(), fileName);
  const cachedPath = fs.existsSync(path.join(__dirname, '.bin_cache'))
    ? path.join(__dirname, '.bin_cache', fileName)
    : null;
  const isUsable = (candidate) => {
    try {
      // Partial downloads (0-byte or truncated) fail inside koffi.load(), so treat them as missing
      return fs.statSync(candidate).size > 1024 * 1024;
    } catch {
      return false;
    }
  };
  return {
    ok: isUsable(tempPath) || (cachedPath ? isUsable(cachedPath) : false),
    platform: process.platform,
    arch: process.arch,
    fileName,
    tempPath,
    cachedPath,
  };
}

// Default process-wide lease manager so standalone `new RedditSolver()` calls rotate browsers automatically
const _SHARED_STANDALONE_LEASE_MANAGERS = new Map();
function getDefaultLeaseManager(rotationMode = 'hybrid') {
  const normalized = ['single-engine', 'multi-engine', 'hybrid'].includes(rotationMode)
    ? rotationMode
    : 'hybrid';
  if (!_SHARED_STANDALONE_LEASE_MANAGERS.has(normalized)) {
    const discovered = discoverEngineBinaries();
    const installedEngines = Object.entries(discovered.engines)
      .filter(([, v]) => v.available)
      .map(([k]) => k);
    _SHARED_STANDALONE_LEASE_MANAGERS.set(
      normalized,
      new ProfileLeaseManager({
        mode: normalized,
        enabledEngines: installedEngines.length > 0 ? installedEngines : ['chromium', 'firefox', 'webkit'],
      })
    );
  }
  return _SHARED_STANDALONE_LEASE_MANAGERS.get(normalized);
}

// ============================================================
// BUILT-IN .ENV LOADER (BUG-09 FIX: zero-dependency .env support)
// ============================================================

function loadDotEnv(envPath = path.join(__dirname, '.env')) {
  const loadedKeys = [];
  if (!fs.existsSync(envPath)) return { envPath, exists: false, loadedKeys };

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx === -1) continue;

    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = val;
      loadedKeys.push(key);
    }
  }
  return { envPath, exists: true, loadedKeys };
}

const ENV_STATUS = loadDotEnv();

// Lazy-loaded Puppeteer + StealthPlugin registered EXACTLY ONCE (BUG-08 FIX)
let _puppeteerInstance = null;
function getPuppeteer() {
  if (!_puppeteerInstance) {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    _puppeteerInstance = puppeteerExtra;
  }
  return _puppeteerInstance;
}

// ============================================================
// STRUCTURED DEBUG LOGGER & DIAGNOSTIC ENGINE (BUG-15 FIX)
// ============================================================

const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function maskSecret(value, { visibleStart = 8, visibleEnd = 4, unmasked = false } = {}) {
  if (value === undefined || value === null || value === '') return '(empty)';
  const str = String(value);
  if (unmasked) return `${str} (len=${str.length})`;
  const hash = crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
  if (str.length <= visibleStart + visibleEnd + 4) {
    return `${str.slice(0, Math.min(3, str.length))}*** (len=${str.length}, sha256=${hash})`;
  }
  return `${str.slice(0, visibleStart)}...${str.slice(-visibleEnd)} (len=${str.length}, sha256=${hash})`;
}

function maskProxyUrl(proxyUrl) {
  if (!proxyUrl) return '(direct)';
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      return `${u.protocol}//${u.username ? u.username.slice(0, 2) + '***' : ''}:***@${u.host}`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid-proxy-url)';
  }
}

class DebugLogger {
  constructor(opts = {}) {
    const envDebug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
    const envLevel = (process.env.LOG_LEVEL || (envDebug ? 'debug' : 'info')).toLowerCase();
    this.levelName = opts.level || (LOG_LEVELS[envLevel] !== undefined ? envLevel : 'info');
    this.level = LOG_LEVELS[this.levelName] ?? LOG_LEVELS.info;
    this.unmasked = Boolean(
      opts.unmasked ??
      (process.env.DEBUG_UNMASKED === '1' && process.env.NODE_ENV !== 'production')
    );
    this.useColor = opts.useColor ?? (!process.env.NO_COLOR && Boolean(process.stdout.isTTY));
    this.dumpOnError = Boolean(
      opts.dumpOnError ??
      (this.level >= LOG_LEVELS.debug || process.env.DEBUG_DUMP === '1')
    );
    this.dumpAlways = Boolean(opts.dumpAlways ?? (process.env.DEBUG_DUMP === 'always'));
    this.dumpDir = opts.dumpDir || process.env.DEBUG_DUMP_DIR || path.join(__dirname, 'debug_artifacts');
    this.runId = `run_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}`;
    this.startTime = Date.now();
    this.events = [];
    this.stepTimings = {};
    this.httpTrace = [];
  }

  _color(code, text) {
    return this.useColor ? `${code}${text}${ANSI.reset}` : text;
  }

  _formatPrefix(levelLabel, colorCode, scope) {
    const ts = new Date().toISOString().slice(11, 23);
    const elapsed = `+${String(Date.now() - this.startTime).padStart(5, ' ')}ms`;
    const lvl = this._color(colorCode, levelLabel.padEnd(5, ' '));
    const scp = scope ? this._color(ANSI.cyan, `[${scope}]`) + ' ' : '';
    return `${this._color(ANSI.gray, `[${ts} ${elapsed}]`)} [${lvl}] ${scp}`;
  }

  _record(level, scope, message, meta) {
    this.events.push({
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - this.startTime,
      level,
      scope: scope || 'main',
      message,
      ...(meta !== undefined ? { meta } : {}),
    });
  }

  error(scope, msg, meta) {
    this._record('error', scope, msg, meta);
    if (this.level >= LOG_LEVELS.error) {
      console.error(`${this._formatPrefix('ERROR', ANSI.red, scope)}${msg}`);
      if (meta && this.level >= LOG_LEVELS.debug) {
        console.error(this._color(ANSI.dim, '  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')));
      }
    }
  }

  warn(scope, msg, meta) {
    this._record('warn', scope, msg, meta);
    if (this.level >= LOG_LEVELS.warn) {
      console.warn(`${this._formatPrefix('WARN', ANSI.yellow, scope)}${msg}`);
      if (meta && this.level >= LOG_LEVELS.debug) {
        console.warn(this._color(ANSI.dim, '  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')));
      }
    }
  }

  info(scope, msg, meta) {
    this._record('info', scope, msg, meta);
    if (this.level >= LOG_LEVELS.info) {
      console.log(`${this._formatPrefix('INFO', ANSI.green, scope)}${msg}`);
      if (meta && this.level >= LOG_LEVELS.debug) {
        console.log(this._color(ANSI.dim, '  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')));
      }
    }
  }

  debug(scope, msg, meta) {
    this._record('debug', scope, msg, meta);
    if (this.level >= LOG_LEVELS.debug) {
      console.log(`${this._formatPrefix('DEBUG', ANSI.blue, scope)}${msg}`);
      if (meta !== undefined) {
        console.log(this._color(ANSI.dim, '  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')));
      }
    }
  }

  trace(scope, msg, meta) {
    this._record('trace', scope, msg, meta);
    if (this.level >= LOG_LEVELS.trace) {
      console.log(`${this._formatPrefix('TRACE', ANSI.magenta, scope)}${msg}`);
      if (meta !== undefined) {
        console.log(this._color(ANSI.dim, '  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')));
      }
    }
  }

  mask(val, visibleStart = 8, visibleEnd = 4) {
    return maskSecret(val, { visibleStart, visibleEnd, unmasked: this.unmasked });
  }

  startStep(name) {
    this.stepTimings[name] = { startMs: Date.now(), durationMs: null, status: 'running' };
  }

  endStep(name, status = 'ok', details = {}) {
    const entry = this.stepTimings[name] || { startMs: Date.now() };
    entry.durationMs = Date.now() - entry.startMs;
    entry.status = status;
    Object.assign(entry, details);
    this.stepTimings[name] = entry;
    return entry.durationMs;
  }

  recordHttp(entry) {
    this.httpTrace.push(entry);
  }

  saveArtifact(filename, content) {
    try {
      const targetDir = path.join(this.dumpDir, this.runId);
      fs.mkdirSync(targetDir, { recursive: true });
      const fullPath = path.join(targetDir, filename);
      if (Buffer.isBuffer(content)) {
        fs.writeFileSync(fullPath, content);
      } else if (typeof content === 'string') {
        fs.writeFileSync(fullPath, content, 'utf-8');
      } else {
        fs.writeFileSync(fullPath, JSON.stringify(content, null, 2), 'utf-8');
      }
      this.debug('Artifacts', `Saved debug artifact: ${fullPath}`);
      return fullPath;
    } catch (err) {
      this.warn('Artifacts', `Failed to write artifact ${filename}: ${err.message}`);
      return null;
    }
  }

  writeDiagnosticReport(extra = {}) {
    const report = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      totalDurationMs: Date.now() - this.startTime,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      envFileLoaded: ENV_STATUS.exists,
      stepTimings: this.stepTimings,
      httpTrace: this.httpTrace,
      ...extra,
      events: this.events,
    };
    return this.saveArtifact('diagnostic_report.json', report);
  }
}

// ============================================================
// BROWSER PROFILES, DEVICE & FINGERPRINT GENERATORS (BUG-04 & BUG-07 FIX)
// ============================================================

// Valid node-tls-client@2.1.0 identifiers paired with matching User-Agent & Client Hints
const VALID_TLS_CLIENT_IDS = new Set([
  'chrome_103', 'chrome_104', 'chrome_105', 'chrome_106', 'chrome_107', 'chrome_108',
  'chrome_109', 'chrome_110', 'chrome_111', 'chrome_112', 'chrome_116_PSK', 'chrome_116_PSK_PQ',
  'chrome_117', 'chrome_120', 'chrome_124', 'chrome_131', 'chrome_131_PSK',
  'firefox_117', 'firefox_120', 'firefox_123', 'firefox_132', 'firefox_133',
  'safari_15_6_1', 'safari_16_0', 'opera_89', 'opera_90', 'opera_91',
]);

const BROWSER_PROFILES = [
  {
    name: 'chrome_131_win',
    tlsClientId: 'chrome_131',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  },
  {
    name: 'edge_131_win',
    tlsClientId: 'chrome_131',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    secChUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  },
  {
    name: 'chrome_131_mac',
    tlsClientId: 'chrome_131',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"',
  },
  {
    name: 'chrome_124_win',
    tlsClientId: 'chrome_124',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  },
];

function selectBrowserProfile(customOptions = {}) {
  if (customOptions.synthesizedProfile) {
    return toSolverProfileAdapter(customOptions.synthesizedProfile);
  }

  const explicitTls = customOptions.tlsClientId || process.env.TLS_CLIENT_ID || null;
  const explicitUa = customOptions.userAgent || process.env.USER_AGENT || null;

  // Default path: synthesize a full 9-brand multi-engine rotation profile (`chrome`, `edge`, `opera`,
  // `brave`, `vivaldi`, `ungoogled_chromium`, `firefox`, `camoufox`, `safari`)
  if (!explicitTls && !explicitUa) {
    const allBrandIds = Object.keys(BROWSER_CATALOG);
    const chosenBrand =
      customOptions.preferredBrand && BROWSER_CATALOG[customOptions.preferredBrand]
        ? customOptions.preferredBrand
        : allBrandIds[crypto.randomInt(0, allBrandIds.length)];
    const synth = synthesizeProfile({
      brandId: chosenBrand,
      os: customOptions.preferredOs || null,
    });
    return toSolverProfileAdapter(synth);
  }

  const base = BROWSER_PROFILES[crypto.randomInt(0, BROWSER_PROFILES.length)];
  const requestedTls = explicitTls || base.tlsClientId;
  const resolvedTls = VALID_TLS_CLIENT_IDS.has(requestedTls) ? requestedTls : 'chrome_131';
  const customUa = explicitUa || base.userAgent;

  return {
    ...base,
    tlsClientId: resolvedTls,
    tlsClientIdRequested: requestedTls,
    tlsClientIdFallbackUsed: resolvedTls !== requestedTls,
    userAgent: customUa,
  };
}

// BUG-04 FIXED: Uses crypto.randomInt() with realistic desktop resolutions (no Buffer out-of-bounds or BigInt crash)
function generateRandomDevice() {
  const presets = [
    { width: 1920, height: 1080, dpr: 1, colorDepth: 24 },
    { width: 1536, height: 864, dpr: 1.25, colorDepth: 24 },
    { width: 1440, height: 900, dpr: 2, colorDepth: 24 },
    { width: 2560, height: 1440, dpr: 1, colorDepth: 24 },
    { width: 1680, height: 1050, dpr: 1, colorDepth: 24 },
  ];
  return presets.map((p) => ({
    width: p.width,
    height: p.height,
    dpr: p.dpr,
    pixelRatio: p.dpr,
    colorDepth: p.colorDepth,
    touchAction: 'auto',
    viewPort: `width=${p.width}, height=${p.height}, scale=1, deviceScaleFactor=${p.dpr}`,
  }));
}

// BUG-04 FIXED: Uses crypto.randomInt(0, possibleShadows.length) instead of 1-byte readUInt32LE(0)
function generateShadow() {
  const possibleShadows = [
    'GFIxIPIVC+Ic+pVFd0OPpNbbkhkTTMTfBw+7V1XmuCJslVosYmDjP7FlDzj0NbErxqH1H1pz2o0iT6CBQxj36v7CW9Vb5FSWdkGCCRxn7+RBg0z8IK3MXrb0Ec3gZ0Pw=',
    '11nViDGcV9tqPN+AdANXsT7zy6woTWqJgWWmaV1k3OK4fCFXF3HA2zIK2xqi+DNL9xdNvaUc1muyH9vDRVssC/AELvQ==',
    'BEYssUZKjP6GFT+G0YI8gxng+hSh6HMxZbSLFQJllPj6i6B/19zutHuQ7O4BPogMkWS3D3v2a7RxNyFJnkRcfHnCtgKZHUPE3OxZyWF+wlU=',
    'hOSzXmoHeJxesSF6Q002wiIl09k45jhsVFhIkAU1MKUBAtuNMwppHfw/FcPU7hD16WmQXUlfMpp/O76iopS2WnPwffCyl50xXXLkNTGmDYw=',
    '2ngAWDBpN0/hEynFtmbjV9BwsfGd/hGQ7jKX63AhbS1xDRs1+9pAsrE0EA/bw5eiwdhDPE3LMgKRLJEPTC9aQP4cgF8hMdIKFv1Zji9Kx3c=',
  ];
  return possibleShadows[crypto.randomInt(0, possibleShadows.length)];
}

// ============================================================
// CONSTANTS & DEFAULTS (BUG-03 & BUG-10 FIX)
// ============================================================

const DEFAULT_SITE_KEY = '6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ';
const SITE_KEY = process.env.RECAPTCHA_SITE_KEY || DEFAULT_SITE_KEY;

// Updated fallback reCAPTCHA release + dynamic auto-discovery via fetchLiveRecaptchaVersion()
const DEFAULT_RECAPTCHA_VERSION = process.env.RECAPTCHA_VERSION || 'NhfdZHzre166o-vFZrWsq3yu';
const ORIGIN = 'https://www.reddit.com:443';

// BUG-03 FIXED: Reddit's <auth-flow-login> expects captcha-action="v1/web/login_with_password" (NOT "login")
const DEFAULT_ACTION = process.env.RECAPTCHA_ACTION || 'v1/web/login_with_password';

const DEFAULT_USER_AGENT = BROWSER_PROFILES[0].userAgent;

// HTTP/2-compliant headers for node-tls-client (BUG-16 FIX + Phase 4 Multi-Engine Bridge:
// NEVER send `Connection: keep-alive` over HTTP/2, and NEVER attach `sec-ch-ua*` to Firefox/Camoufox/Safari!)
function buildBrowserHeaders(profile = BROWSER_PROFILES[0], { http1 = false } = {}) {
  if (profile && profile._synthesized) {
    return buildProfileHttpHeaders(profile._synthesized, {
      http1,
      isDocumentNavigation: false,
    });
  }

  // W13: locale-aware Accept-Language even on the legacy/env-override path (was hardcoded
  // 'en-US,en;q=0.9' for every run) — prefer profile languages, then env override, then default.
  const legacyLangs = Array.isArray(profile.languages) && profile.languages.length
    ? profile.languages
    : null;
  const acceptLanguage =
    process.env.ACCEPT_LANGUAGE ||
    (legacyLangs
      ? legacyLangs.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(',')
      : 'en-US,en;q=0.9');

  const headers = {
    'User-Agent': profile.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
    // NativeHttpClient on Node <22 does not have zstd decompression, so advertise gzip/deflate/br for HTTP/1.1
    'Accept-Encoding': http1 ? 'gzip, deflate, br' : 'gzip, deflate, br, zstd',
  };
  if (profile.secChUa) {
    headers['sec-ch-ua'] = profile.secChUa;
    headers['sec-ch-ua-mobile'] = profile.secChUaMobile || '?0';
    headers['sec-ch-ua-platform'] = profile.secChUaPlatform || '"Windows"';
  }
  if (http1) {
    headers['Connection'] = 'keep-alive';
  }
  return headers;
}

// ============================================================
// PROTOBUF WIRE FORMAT ENCODER
// ============================================================

class ProtobufWriter {
  constructor() {
    this._parts = [];
  }

  _writeVarint(value) {
    if (value < 0) {
      const buf = Buffer.alloc(10);
      let bigVal = BigInt(value) & 0xFFFFFFFFFFFFFFFFn;
      let i = 0;
      while (bigVal > 0x7Fn) {
        buf[i++] = Number(bigVal & 0x7Fn) | 0x80;
        bigVal >>= 7n;
      }
      buf[i++] = Number(bigVal & 0x7Fn);
      this._parts.push(buf.subarray(0, i));
      return;
    }
    const bytes = [];
    while (value > 0x7F) {
      bytes.push((value & 0x7F) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7F);
    this._parts.push(Buffer.from(bytes));
  }

  _writeTag(fieldNumber, wireType) {
    this._writeVarint((fieldNumber << 3) | wireType);
  }

  writeString(fieldNumber, value) {
    if (value == null) return;
    const encoded = Buffer.from(value, 'utf-8');
    this._writeTag(fieldNumber, 2);
    this._writeVarint(encoded.length);
    this._parts.push(encoded);
  }

  writeBytes(fieldNumber, value) {
    if (value == null) return;
    this._writeTag(fieldNumber, 2);
    this._writeVarint(value.length);
    this._parts.push(Buffer.from(value));
  }

  writeInt32(fieldNumber, value) {
    if (value == null) return;
    this._writeTag(fieldNumber, 0);
    this._writeVarint(value >>> 0);
  }

  writeSint32(fieldNumber, value) {
    if (value == null) return;
    this._writeTag(fieldNumber, 0);
    const zigzag = ((value << 1) ^ (value >> 31)) >>> 0;
    this._writeVarint(zigzag);
  }

  toBuffer() {
    return Buffer.concat(this._parts);
  }
}

// ============================================================
// TELEMETRY GENERATOR (WITH CRYPTO ENTROPY)
// ============================================================

function randomFloat() {
  return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
}

function generateField20(opts = {}) {
  const {
    screenHeight = 1080,
    devicePixelRatio = 1.0,
    colorDepth = 24,
    pageLoadMs = 1100 + crypto.randomInt(0, 900),
  } = opts;

  const fcp = pageLoadMs * (0.3 + randomFloat() * 0.3);
  const domInteractive = pageLoadMs * (0.7 + randomFloat() * 0.5);
  const viewportTs = Math.floor(pageLoadMs * (1.2 + randomFloat() * 1.3));
  // W7: non-uniform (triangular-ish) interaction timing + widened ranges — the previous
  // `300 + uniform(0..600)` produced the same flat distribution for every account.
  const interactionTs = Math.floor(180 + (randomFloat() + randomFloat()) * 0.5 * 1400);
  const anchorElapsed = 12000 + crypto.randomInt(0, 28000);
  const interactionVal = anchorElapsed - 400 - crypto.randomInt(0, 5200);

  const timingEvents = [
    [3, viewportTs, screenHeight],
    [1, interactionTs, interactionVal],
  ];

  const perfMetrics = [
    [2, 73, parseFloat(fcp.toFixed(13))],
    [2, 65, parseFloat(domInteractive.toFixed(13))],
  ];

  const dprScaled = parseFloat((devicePixelRatio * 7.75).toFixed(15));
  // W7: humanness via averaged RNG (bell-ish around mid-range, edges less likely)
  const humanness = parseFloat(((randomFloat() + randomFloat() + randomFloat()) / 3 * 0.75 + 0.12).toFixed(17));

  const envInfo = [
    null, null, null,
    [14, dprScaled, humanness, colorDepth + 20],
    [0, null, 0],
    0, 0, 0,
  ];

  const domains = [
    'www.redditstatic.com',
    'id.rlcdn.com',
    'www.reddit.com',
    'w3-reporting.reddit.com',
    'www.google.com',
    'accounts.google.com',
    'appleid.cdn-apple.com',
    'www.gstatic.com',
  ];

  const signalCount = 4 + crypto.randomInt(0, 8);
  const elapsedMs = 400 + crypto.randomInt(0, 1100);
  const sessionMeta = [signalCount, elapsedMs];

  const telemetry = [timingEvents, perfMetrics, envInfo, domains, sessionMeta];
  const jsonStr = JSON.stringify(telemetry);
  const b64Payload = Buffer.from(jsonStr, 'utf-8').toString('base64');

  return 'tb' + b64Payload;
}

function generateField22(opts = {}) {
  const {
    screenWidth = 1920,
    screenHeight = 1080,
    colorDepth = 24,
    timezoneOffsetMin = new Date().getTimezoneOffset(),
    userAgent = DEFAULT_USER_AGENT,
  } = opts;

  const buf = Buffer.alloc(1150, 0);

  buf[0] = 0x04;
  const wPacked = screenWidth >> 4;
  buf[1] = (wPacked >> 4) & 0xFF;
  buf[2] = ((wPacked & 0x0F) << 4);
  const hPacked = screenHeight >> 4;
  buf[3] = (hPacked >> 4) & 0xFF;
  buf[4] = ((hPacked & 0x0F) << 4) | 0x02;
  buf[5] = Math.floor(colorDepth / 8);
  const tz = timezoneOffsetMin & 0xFFFF;
  buf[6] = (tz >> 8) & 0xFF;
  buf[7] = tz & 0xFF;

  const entropySalt = crypto.randomBytes(4).toString('hex');
  const seed = parseInt(
    crypto.createHash('md5').update(userAgent + entropySalt).digest('hex').slice(0, 8),
    16
  );
  let rngState = seed;
  const nextRng = () => {
    rngState = (Math.imul(rngState, 1103515245) + 12345) & 0x7FFFFFFF;
    return rngState / 0x7FFFFFFF;
  };

  const CHROME_BITS = [
    1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1, 1,1,1,1,1,1,0,1, 1,1,1,1,1,1,1,1,
    1,1,1,1,1,0,1,1, 1,1,1,1,1,1,1,1, 1,1,1,1,0,0,1,1, 1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,0, 1,1,1,1,0,0,1,1, 1,1,1,0,1,1,1,1, 1,1,0,0,1,1,1,1,
    1,1,1,1,1,1,1,1, 0,1,1,1,1,1,0,1, 1,0,1,1,1,1,1,1, 1,1,1,0,1,1,1,1,
    1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1, 1,1,0,1,1,1,1,1, 1,1,1,1,1,1,1,0,
    1,1,1,1,1,1,1,1, 1,0,1,1,1,1,1,1, 1,1,1,1,1,1,1,1, 1,1,1,1,1,1,0,1,
  ];

  // W3: engine-aware feature-bit preset — a Firefox/Safari lease must NOT ship Chrome's exact
  // feature buffer. Deterministically derive per-engine variants (stable per engine, distinct
  // across engines) since Google's field22 semantics are opaque.
  const engineKey = String(opts.engine || 'chromium').toLowerCase();
  let featureBits = CHROME_BITS;
  if (engineKey !== 'chromium') {
    const engineHash = crypto.createHash('sha256').update(`field22:${engineKey}`).digest();
    featureBits = CHROME_BITS.map((bit, i) => {
      // Flip ~18% of bits deterministically based on the engine hash
      const byte = engineHash[(i * 7) % engineHash.length];
      return byte % 6 === 0 ? (bit ? 0 : 1) : bit;
    });
  }

  for (let i = 0; i < featureBits.length; i++) {
    const byteOff = 8 + Math.floor(i / 8);
    const bitOff = 7 - (i % 8);
    if (byteOff < buf.length) {
      if (featureBits[i]) buf[byteOff] |= (1 << bitOff);
      else buf[byteOff] &= ~(1 << bitOff);
    }
  }

  for (let idx = 32; idx < buf.length; idx++) {
    if (buf[idx] === 0) {
      let density;
      if (idx < 200) density = 0.80;
      else if (idx < 500) density = 0.70;
      else if (idx < 800) density = 0.60;
      else density = 0.45;

      let byteVal = 0;
      for (let bit = 0; bit < 8; bit++) {
        if (nextRng() < density) byteVal |= (1 << bit);
      }
      buf[idx] = byteVal;
    }
  }

  return buf.toString('base64');
}

// ============================================================
// PROTOBUF RELOAD PAYLOAD BUILDER
// ============================================================

function buildReloadPayload({
  version = DEFAULT_RECAPTCHA_VERSION,
  initialToken,
  sessionHash = 0,
  operation = 'q',
  action = DEFAULT_ACTION,
  siteKey = SITE_KEY,
  botguardToken = '',
  anchorMs = 20000,
  executeMs = 30000,
  userAgent = DEFAULT_USER_AGENT,
  screenWidth = 1920,
  screenHeight = 1080,
  devicePixelRatio = 1.0,
  colorDepth = 24,
  timezoneOffsetMin = new Date().getTimezoneOffset(),
  engine = 'chromium',
} = {}) {
  const field20 = generateField20({ screenHeight, devicePixelRatio, colorDepth });
  const field22 = generateField22({ userAgent, screenWidth, screenHeight, colorDepth, timezoneOffsetMin, engine });

  const writer = new ProtobufWriter();
  writer.writeString(1, version);
  writer.writeString(2, initialToken);
  writer.writeSint32(5, sessionHash);
  writer.writeString(6, operation);
  writer.writeString(8, action);
  writer.writeString(14, siteKey);
  if (botguardToken) {
    writer.writeString(16, botguardToken);
  }
  writer.writeString(20, field20);
  writer.writeString(22, field22);
  writer.writeString(25, 'W10'); // base64("[]")
  writer.writeInt32(28, anchorMs);
  writer.writeInt32(29, executeMs);

  return writer.toBuffer();
}

// ============================================================
// RATE LIMITER UTILITY (BUG-05 FIX: bounded jitter, zero overflow)
// ============================================================

class JitterRateLimiter {
  constructor({ minMs = 500, maxMs = 1500, enabled = true } = {}) {
    this.minMs = Math.max(0, Number(minMs) || 0);
    this.maxMs = Math.max(this.minMs, Number(maxMs) || this.minMs);
    this.enabled = Boolean(enabled) && this.maxMs > 0;
    this.lastRequestAt = 0;
  }

  computeWaitMs(now = Date.now()) {
    if (!this.enabled || this.lastRequestAt === 0) return 0;
    const targetGap =
      this.maxMs > this.minMs
        ? crypto.randomInt(this.minMs, this.maxMs + 1)
        : this.minMs;
    const elapsed = now - this.lastRequestAt;
    return Math.max(0, targetGap - elapsed);
  }

  /**
   * W8: context-aware pacing — humans linger on document navigations (reading a page) but fire
   * API calls quickly. Gap uses an averaged-RNG (bell-ish) distribution instead of flat uniform:
   *   kind='document' -> ~1.2x..2.6x of base range, bell around the middle
   *   kind='api'      -> ~0.5x..1.1x of base range
   */
  computeWaitMsFor(kind = 'api', now = Date.now()) {
    if (!this.enabled || this.lastRequestAt === 0) return 0;
    const avg = (crypto.randomInt(0, 1000) + crypto.randomInt(0, 1000) + crypto.randomInt(0, 1000)) / 3000; // 0..1 bell
    const base = this.minMs + avg * (this.maxMs - this.minMs);
    const scaled = kind === 'document' ? base * 2.1 + 500 : base * 0.75 + 120;
    const elapsed = now - this.lastRequestAt;
    return Math.max(0, Math.floor(scaled - elapsed));
  }

  async wait(logger = null, scope = 'RateLimit', kind = 'api') {
    const waitMs = this.computeWaitMsFor(kind);
    if (waitMs > 0) {
      if (logger) logger.debug(scope, `Throttling outbound ${kind} request for ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastRequestAt = Date.now();
    return waitMs;
  }
}

// ============================================================
// HTTP CLIENTS (Native HTTPS + Proxy Tunnel & TLS-Fingerprinted Client)
// ============================================================

function createProxyTunnelSocket(proxyUrl, targetHost, targetPort, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const isHttpsProxy = p.protocol === 'https:';
    const transport = isHttpsProxy ? https : http;
    const proxyPort = Number(p.port) || (isHttpsProxy ? 443 : 8080);
    const connectHeaders = {
      Host: `${targetHost}:${targetPort}`,
    };
    if (p.username || p.password) {
      const auth = Buffer.from(
        `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`
      ).toString('base64');
      connectHeaders['Proxy-Authorization'] = `Basic ${auth}`;
    }

    const connectReq = transport.request({
      host: p.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: connectHeaders,
      timeout: timeoutMs,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
      }
      const tlsSocket = tls.connect(
        {
          socket,
          servername: targetHost,
        },
        () => resolve(tlsSocket)
      );
      tlsSocket.on('error', reject);
    });

    connectReq.on('timeout', () => {
      connectReq.destroy();
      reject(new Error('Proxy CONNECT timeout'));
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

class NativeHttpClient {
  constructor({
    proxy = null,
    profile = BROWSER_PROFILES[0],
    logger = null,
    rateLimitMinMs = Number(process.env.RATE_LIMIT_MIN_MS ?? 350),
    rateLimitMaxMs = Number(process.env.RATE_LIMIT_MAX_MS ?? 1100),
    enableRateLimit = process.env.DISABLE_RATE_LIMIT !== '1',
  } = {}) {
    this.cookies = {};
    this.proxy = proxy;
    this.profile = profile;
    this.logger = logger;
    this.reqCounter = 0;
    this.rateLimiter = new JitterRateLimiter({
      minMs: rateLimitMinMs,
      maxMs: rateLimitMaxMs,
      enabled: enableRateLimit,
    });
  }

  _parseCookies(headers) {
    const added = [];
    const sc = headers['set-cookie'];
    if (!sc) return added;
    for (const c of Array.isArray(sc) ? sc : [sc]) {
      const firstPart = c.split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx === -1) continue;
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      if (name && value) {
        this.cookies[name] = value;
        added.push(name);
      }
    }
    return added;
  }

  _cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(url, { method = 'GET', headers = {}, body = null, followRedirects = true, _redirectDepth = 0 } = {}) {
    if (_redirectDepth > 8) {
      throw new Error(`Maximum redirect depth exceeded for ${url}`);
    }

    await this.rateLimiter.wait(this.logger, 'NativeHTTP');

    const reqId = ++this.reqCounter;
    const startedAt = Date.now();
    const u = new URL(url);
    const reqHeaders = {
      ...buildBrowserHeaders(this.profile, { http1: true }),
      ...headers,
      Host: u.host,
    };
    const ck = this._cookieHeader();
    if (ck && !reqHeaders.Cookie && !reqHeaders.cookie) {
      reqHeaders.Cookie = ck;
    }

    let tunnelSocket = null;
    if (this.proxy && u.protocol === 'https:') {
      tunnelSocket = await createProxyTunnelSocket(this.proxy, u.hostname, Number(u.port) || 443);
    }

    this.logger?.debug('NativeHTTP', `-> [#N${reqId}] ${method} ${url}`, {
      proxy: maskProxyUrl(this.proxy),
      bodyBytes: body ? Buffer.byteLength(body) : 0,
    });

    // BUG-01 FIXED: Clean Promise wrapper with NO illegal `await` inside sync `res.on('end')`
    return new Promise((resolve, reject) => {
      const transport = u.protocol === 'http:' ? http : https;
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
        ...(tunnelSocket ? { createConnection: () => tunnelSocket } : {}),
      };

      const req = transport.request(reqOpts, (res) => {
        const setCookieNames = this._parseCookies(res.headers);
        if (
          followRedirects &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          const redir = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume();
          const nextMethod = res.statusCode === 307 || res.statusCode === 308 ? method : 'GET';
          this.logger?.debug('NativeHTTP', `<- [#N${reqId}] HTTP ${res.statusCode} redirect -> ${redir}`);
          return this.request(redir, {
            method: nextMethod,
            headers,
            body: nextMethod === 'GET' ? null : body,
            followRedirects,
            _redirectDepth: _redirectDepth + 1,
          }).then(resolve, reject);
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let raw = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') raw = zlib.gunzipSync(raw);
            else if (enc === 'br') raw = zlib.brotliDecompressSync(raw);
            else if (enc === 'deflate') raw = zlib.inflateSync(raw);
          } catch (decompressErr) {
            this.logger?.warn('NativeHTTP', `Decompression warning (${enc}): ${decompressErr.message}`);
          }

          const durationMs = Date.now() - startedAt;
          const text = raw.toString('utf-8');

          this.logger?.recordHttp({
            client: 'NativeHttpClient',
            reqId: `N${reqId}`,
            method,
            url,
            status: res.statusCode,
            durationMs,
            responseBytes: raw.length,
            setCookies: setCookieNames,
          });

          this.logger?.debug(
            'NativeHTTP',
            `<- [#N${reqId}] HTTP ${res.statusCode} (${durationMs}ms, ${raw.length}B)${setCookieNames.length ? ` set-cookie=[${setCookieNames.join(', ')}]` : ''}`
          );

          resolve({
            status: res.statusCode,
            url,
            headers: res.headers,
            text,
            rawBuffer: raw,
            cookies: { ...this.cookies },
          });
        });
        res.on('error', reject);
      });

      req.on('error', (err) => {
        this.logger?.error('NativeHTTP', `[#N${reqId}] Request error on ${method} ${url}: ${err.message}`);
        reject(err);
      });
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error(`NativeHttpClient timeout after 30000ms (${method} ${url})`));
      });
      if (body) {
        if (Buffer.isBuffer(body)) req.write(body);
        else req.write(body, 'utf-8');
      }
      req.end();
    });
  }

  async get(url, headers = {}) {
    return this.request(url, { method: 'GET', headers });
  }

  async post(url, body, headers = {}) {
    return this.request(url, { method: 'POST', headers, body });
  }
}

class TlsHttpClient {
  constructor({
    proxy = null,
    profile = null,
    logger = null,
    rateLimitMinMs = Number(process.env.RATE_LIMIT_MIN_MS ?? 350),
    rateLimitMaxMs = Number(process.env.RATE_LIMIT_MAX_MS ?? 1100),
    enableRateLimit = process.env.DISABLE_RATE_LIMIT !== '1',
  } = {}) {
    this.logger = logger;
    this.profile = profile || selectBrowserProfile();
    this.proxy = proxy || process.env.PROXY_URL || null;
    this.cookies = {};
    this.reqCounter = 0;

    if (this.profile.tlsClientIdFallbackUsed) {
      this.logger?.warn(
        'TlsClient',
        `Invalid TLS_CLIENT_ID "${this.profile.tlsClientIdRequested}" is not supported by node-tls-client@2.1.0; falling back to "${this.profile.tlsClientId}"`
      );
    }

    // BUG-13 FIXED + Phase 4 Engine-Accurate TLS Extension Order:
    // Chromium/Opera randomize TLS extensions (`true`), Firefox/Safari use fixed NSS/Apple order (`false`)
    const sessionOpts = this.profile._synthesized
      ? buildTlsSessionOptions(this.profile._synthesized, {
          proxy: this.proxy,
          timeout: 30000,
        })
      : {
          clientIdentifier: this.profile.tlsClientId,
          timeout: 30000,
          randomTlsExtensionOrder:
            this.profile.tlsClientId.startsWith('chrome_') ||
            this.profile.tlsClientId.startsWith('opera_'),
          forceHttp1: false,
          ...(this.proxy ? { proxy: this.proxy } : {}),
        };

    this.session = new Session(sessionOpts);
    // W1: dedicated Google/reCAPTCHA session — SAME browser TLS fingerprint (JA3/JA4) as Reddit
    // traffic, but forced HTTP/1.1: Google's BotGuard reload endpoint rejects our protobuf POST
    // over h2 (stream PROTOCOL_ERROR / null token), while h1 with the correct browser JA3 works.
    this.googleSession = new Session({ ...sessionOpts, forceHttp1: true });
    this.rateLimiter = new JitterRateLimiter({
      minMs: rateLimitMinMs,
      maxMs: rateLimitMaxMs,
      enabled: enableRateLimit,
    });
    this.native = new NativeHttpClient({
      proxy: this.proxy,
      profile: this.profile,
      logger: this.logger,
      rateLimitMinMs,
      rateLimitMaxMs,
      enableRateLimit,
    });
  }

  async _syncAllCookies(resCookies, resHeaders) {
    const beforeKeys = new Set(Object.keys(this.cookies));
    if (resCookies && typeof resCookies === 'object') {
      for (const [name, value] of Object.entries(resCookies)) {
        if (name && value !== undefined && value !== null) {
          this.cookies[name] = String(value);
        }
      }
    }

    // Also inspect session's internal tough-cookie jar so cookies set on 302 hops are never lost
    try {
      const jarCookies = await this.session.cookies();
      if (Array.isArray(jarCookies)) {
        for (const c of jarCookies) {
          if (c && c.key && c.value !== undefined) {
            this.cookies[c.key] = String(c.value);
          }
        }
      }
    } catch {
      // Ignore jar serialization errors
    }

    // Also parse raw Set-Cookie header if present
    const sc = resHeaders?.['set-cookie'] || resHeaders?.['Set-Cookie'];
    if (sc) {
      for (const raw of Array.isArray(sc) ? sc : [sc]) {
        const pair = String(raw).split(';')[0];
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim();
          const v = pair.slice(eqIdx + 1).trim();
          if (k) this.cookies[k] = v;
        }
      }
    }

    return Object.keys(this.cookies).filter((k) => !beforeKeys.has(k));
  }

  _cookieObj() {
    return { ...this.cookies };
  }

  async _execute(method, url, { headers = {}, body = null, followRedirects = true, domainScoped = false, useGoogleSession = false } = {}) {
    const activeSession = useGoogleSession ? this.googleSession : this.session;
    const mergedHeaders = useGoogleSession
      ? { ...buildBrowserHeaders(this.profile, { http1: true }), ...headers }
      : { ...buildBrowserHeaders(this.profile), ...headers };

    // W8: derive pacing context from the request itself — full page navigations get human
    // "reading" gaps, XHR/API calls stay snappy.
    const paceKind = String(mergedHeaders['Sec-Fetch-Dest'] || '').toLowerCase() === 'document'
      ? 'document'
      : 'api';
    await this.rateLimiter.wait(this.logger, 'TlsClient', paceKind);
    const reqId = ++this.reqCounter;
    const startedAt = Date.now();

    this.logger?.debug('TlsClient', `-> [#T${reqId}] ${method} ${url}`, {
      tlsProfile: this.profile.tlsClientId,
      proxy: maskProxyUrl(this.proxy),
      cookieKeysSent: domainScoped ? ['(session-jar-only)'] : Object.keys(this.cookies),
      bodyBytes: body ? Buffer.byteLength(body) : 0,
    });
    this.logger?.trace('TlsClient', `[#T${reqId}] Request headers`, mergedHeaders);

    const reqOptions = {
      headers: mergedHeaders,
      followRedirects,
      // domainScoped=true (cross-site e.g. google.com): rely on the tough-cookie jar's domain
      // rules instead of blasting ALL Reddit cookies to a third-party host.
      ...(domainScoped ? {} : { cookies: this._cookieObj() }),
      ...(this.proxy ? { proxy: this.proxy } : {}),
      ...(body !== null ? { body: typeof body === 'string' ? body : body } : {}),
    };

    const res =
      method === 'POST'
        ? await activeSession.post(url, reqOptions)
        : await activeSession.get(url, reqOptions);

    const durationMs = Date.now() - startedAt;

    // BUG-13 FIXED: Detect node-tls-client status === 0 transport/proxy errors immediately
    if (res.status === 0) {
      const errDetail = (res.body || 'Unknown TLS/transport failure').slice(0, 300);
      this.logger?.error('TlsClient', `[#T${reqId}] Transport error (status=0 after ${durationMs}ms): ${errDetail}`);
      throw new Error(`TLS client transport error on ${method} ${url}: ${errDetail}`);
    }

    const newCookies = await this._syncAllCookies(res.cookies, res.headers);
    const bodyText = res.body || '';

    this.logger?.recordHttp({
      client: `TlsHttpClient(${this.profile.tlsClientId})`,
      reqId: `T${reqId}`,
      method,
      url,
      finalUrl: res.url || url,
      status: res.status,
      durationMs,
      responseBytes: Buffer.byteLength(bodyText),
      newCookies,
    });

    this.logger?.debug(
      'TlsClient',
      `<- [#T${reqId}] HTTP ${res.status} (${durationMs}ms, ${Buffer.byteLength(bodyText)}B)${
        res.url && res.url !== url ? ` -> ${res.url}` : ''
      }${newCookies.length ? ` +cookies=[${newCookies.join(', ')}]` : ''}`
    );
    this.logger?.trace('TlsClient', `[#T${reqId}] Response headers`, res.headers);

    return {
      status: res.status,
      url: res.url || url,
      headers: res.headers || {},
      text: bodyText,
      cookies: { ...this.cookies },
    };
  }

  async get(url, headers = {}) {
    return this._execute('GET', url, { headers });
  }

  async post(url, body, headers = {}) {
    return this._execute('POST', url, { headers, body });
  }

  // Google/reCAPTCHA traffic MUST use the same browser TLS fingerprint as the Reddit traffic
  // (W1 fix): previously routed through NativeHttpClient (Node.js TLS stack -> Node JA3 leak!).
  async googleGet(url, headers = {}) {
    if (process.env.GOOGLE_VIA_NATIVE === '1') return this.native.get(url, headers);
    return this._execute('GET', url, { headers, domainScoped: true, useGoogleSession: true });
  }

  async googlePost(url, body, headers = {}) {
    if (process.env.GOOGLE_VIA_NATIVE === '1') return this.native.post(url, body, headers);
    return this._execute('POST', url, { headers, body, domainScoped: true, useGoogleSession: true });
  }

  async close() {
    try {
      await this.session.close();
    } catch {
      // Ignore session close errors
    }
    try {
      if (this.googleSession) await this.googleSession.close();
    } catch {
      // Ignore session close errors
    }
  }
}

// ============================================================
// ANCHOR, RELOAD, REDDIT FORM & JWT PARSERS
// ============================================================

function extractAnchorToken(html) {
  const patterns = [
    /id="recaptcha-token"\s+value="([^"]+)"/,
    /value="([^"]+)"\s+id="recaptcha-token"/,
    /value="(03AFcWeA[^"]+)"/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) return m[1];
  }
  return '';
}

function parseAnchorInit(html) {
  const m = html.match(/recaptcha\.anchor\.Main\.init\("(.+?)"\);/s);
  if (!m) return null;

  let raw = m[1];
  raw = raw.replace(/\\\\/g, '\x00BSLASH\x00');
  raw = raw.replace(/\\x22/g, '"');
  raw = raw.replace(/\\x27/g, "'");
  raw = raw.replace(/\\u003d/g, '=');
  raw = raw.replace(/\x00BSLASH\x00/g, '\\');

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractSessionHash(html) {
  const initArray = parseAnchorInit(html);
  if (!initArray) return 0;

  let conf = null;
  for (const item of initArray) {
    if (Array.isArray(item) && item.length > 0 && item[0] === 'conf') {
      conf = item;
      break;
    }
  }
  if (!conf) return 0;

  let confProtoB64 = null;
  for (const item of conf) {
    if (typeof item === 'string' && item.length > 50 && !item.startsWith('6L')) {
      confProtoB64 = item;
      break;
    }
  }

  if (confProtoB64) {
    try {
      const confData = Buffer.from(confProtoB64, 'base64');
      let h = 0;
      for (const b of confData) {
        h = ((h << 5) - h + b) & 0xFFFFFFFF;
      }
      if (h > 0x7FFFFFFF) h -= 0x100000000;
      return h;
    } catch {
      // fall through
    }
  }
  return 0;
}

function extractInitParams(html) {
  const result = {};
  const initArray = parseAnchorInit(html);
  if (!initArray) return result;

  result.anchorToken = extractAnchorToken(html);

  if (initArray.length > 1 && Array.isArray(initArray[1])) {
    const bgArr = initArray[1];
    if (bgArr.length >= 5 && typeof bgArr[4] === 'string') {
      result.bgdata = bgArr[4];
      result.bgdataLength = bgArr[4].length;
    }
  }

  for (const item of initArray) {
    if (Array.isArray(item) && item.length > 0 && item[0] === 'conf') {
      result.siteKey = item[2] || null;
      if (item.length > 9 && Array.isArray(item[9])) result.confHints = item[9];
      if (item.length > 36 && typeof item[36] === 'string') result.confHash = item[36];
      break;
    }
  }

  if (initArray.length > 4 && typeof initArray[4] === 'string') result.origin = initArray[4];
  if (initArray.length > 13 && typeof initArray[13] === 'string') result.sessionKeyB64 = initArray[13];
  if (initArray.length > 18 && typeof initArray[18] === 'number') result.serverTimestamp = initArray[18];
  if (initArray.length > 21 && Array.isArray(initArray[21])) result.timingHints = initArray[21];
  if (initArray.length > 24 && typeof initArray[24] === 'string') result.sessionId = initArray[24];
  if (initArray.length > 30 && typeof initArray[30] === 'string') result.secondaryToken = initArray[30];
  if (initArray.length > 31 && typeof initArray[31] === 'number') result.expiryTimestamp = initArray[31];

  return result;
}

function parseReloadResponse(responseText) {
  let text = String(responseText || '').trim();

  const prefixes = [")]}'\n", ")]}\n", ")]}'"];
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  text = text.trim();

  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) {
      return { error: 'Unexpected format', raw: text.slice(0, 200) };
    }
    return {
      messageType: data[0] || null,
      recaptchaToken: data[1] || null,
      ttlSeconds: data[3] || null,
      verificationToken: data[8] || null,
      grecaptchaCookie: data[12] || null,
      tokenA: data[14] || null,
      tokenB: data[15] || null,
      successFlag: data[16] ?? null,
      rawArrayLength: data.length,
    };
  } catch {
    return { error: 'JSON parse failed', raw: text.slice(0, 200) };
  }
}

// BUG-10 FIXED: Preserve Google's `.` padding on base64url origin encoding
function encodeOrigin(origin) {
  return Buffer.from(origin, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '.');
}

function generateCb() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let cb = '';
  for (let i = 0; i < 12; i++) {
    cb += chars[crypto.randomInt(0, chars.length)];
  }
  return cb;
}

function buildAnchorUrl({
  siteKey = SITE_KEY,
  version = DEFAULT_RECAPTCHA_VERSION,
  origin = ORIGIN,
  cb = null,
  anchorMs = 20000,
  executeMs = 30000,
} = {}) {
  if (!cb) cb = generateCb();
  const co = encodeOrigin(origin);
  const params = new URLSearchParams({
    ar: '1',
    k: siteKey,
    co,
    hl: 'en',
    v: version,
    size: 'invisible',
    'anchor-ms': String(anchorMs),
    'execute-ms': String(executeMs),
    cb,
  });
  return `https://www.google.com/recaptcha/enterprise/anchor?${params.toString()}`;
}

function buildReloadUrl(siteKey = SITE_KEY) {
  return `https://www.google.com/recaptcha/enterprise/reload?k=${siteKey}`;
}

// Parse HTML attributes regardless of order (name="x" value="y" OR value="y" name="x")
function parseHtmlTagAttributes(tagHtml) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = attrRegex.exec(tagHtml)) !== null) {
    const key = m[1];
    if (key.toLowerCase() === 'input' || key.toLowerCase() === 'form') continue;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

// BUG-02 FIXED: Dynamically parse Reddit's JS challenge form (supports `jsc_token`, `token`, and any future hidden fields)
function parseRedditJsChallenge(html) {
  if (!html || typeof html !== 'string') {
    return { isChallenge: false, inlineValue: '', tokenField: null, tokenValue: '', fields: {} };
  }

  const inlineMatch =
    html.match(/await\s*\(\s*async\s+(\w+)\s*=>\s*\1\s*\+\s*\1\s*\)\(\s*["']([0-9a-fA-F]+)["']\s*\)/) ||
    html.match(/await\s*\(async\s+\w+=>\w\+\w\)\("([0-9a-fA-F]+)"\)/);
  const inlineValue = inlineMatch ? (inlineMatch[2] || inlineMatch[1] || '') : '';

  const formMatch = html.match(/<form[^>]*action=["']\/login\/?["'][^>]*>([\s\S]*?)<\/form>/i);
  const searchScope = formMatch ? formMatch[1] : html;
  const fields = {};
  const inputTags = searchScope.match(/<input\b[^>]*>/gi) || [];

  for (const tag of inputTags) {
    const attrs = parseHtmlTagAttributes(tag);
    if (attrs.name) {
      fields[attrs.name] = attrs.value ?? '';
    }
  }

  let tokenField = null;
  let tokenValue = '';
  if (fields.jsc_token) {
    tokenField = 'jsc_token';
    tokenValue = fields.jsc_token;
  } else if (fields.token) {
    tokenField = 'token';
    tokenValue = fields.token;
  } else {
    for (const [k, v] of Object.entries(fields)) {
      if (k.toLowerCase().includes('token') && v) {
        tokenField = k;
        tokenValue = v;
        break;
      }
    }
  }

  const isChallenge = Boolean(inlineValue && (tokenValue || fields.js_challenge === '1'));
  let solutionUrl = '';
  if (isChallenge) {
    const solution = inlineValue + inlineValue;
    const params = new URLSearchParams();
    const orderedKeys = Object.keys(fields);
    if (orderedKeys.length > 0) {
      for (const k of orderedKeys) {
        params.set(k, k === 'solution' ? solution : fields[k]);
      }
      if (!params.has('solution')) params.set('solution', solution);
    } else {
      params.set('solution', solution);
      params.set('js_challenge', '1');
      if (tokenField && tokenValue) params.set(tokenField, tokenValue);
      params.set('jsc_orig_r', '');
    }
    solutionUrl = `https://www.reddit.com/login/?${params.toString()}`;
  }

  return {
    isChallenge,
    inlineValue,
    solution: inlineValue ? inlineValue + inlineValue : '',
    tokenField,
    tokenValue,
    fields,
    solutionUrl,
  };
}

// Detect Reddit WAF "Prove your humanity" hard block page
function isHumanityBlockPage(html) {
  if (!html || typeof html !== 'string') return false;
  return /<title>\s*Reddit\s*-\s*Prove your humanity\s*<\/title>/i.test(html);
}

// Extract live Shreddit metadata (<shreddit-app release=...>, login-step partial URL, site-key, captcha-action)
function extractShredditPageConfig(html) {
  if (!html || typeof html !== 'string') return {};
  const release = html.match(/<shreddit-app\b[^>]*\brelease="([^"]+)"/i)?.[1] || null;
  const correlationId = html.match(/<shreddit-app\b[^>]*\bcorrelation-id="([^"]+)"/i)?.[1] || null;
  const serverRenderId = html.match(/<shreddit-app\b[^>]*\bserverRenderId="([^"]+)"/i)?.[1] || null;
  const loid = html.match(/<shreddit-app\b[^>]*\bloid="([^"]+)"/i)?.[1] || null;
  const siteKey =
    html.match(/captcha-site-key="([^"]+)"/i)?.[1] ||
    html.match(/<reputation-recaptcha\b[^>]*\bsite-key="([^"]+)"/i)?.[1] ||
    null;
  const captchaAction = html.match(/captcha-action="([^"]+)"/i)?.[1] || null;
  const checkboxSiteKey = html.match(/checkbox-site-key="([^"]+)"/i)?.[1] || null;
  const loginStepPartial =
    html.match(/src="(\/svc\/shreddit\/partial\/[^"]+\/login-step[^"]*)"/i)?.[1]?.replace(/&amp;/g, '&') ||
    null;
  const loginActionPath =
    html.match(/<faceplate-form\b[^>]*\bid="login"[^>]*\baction="([^"]+)"/i)?.[1] ||
    '/svc/shreddit/account/login';
  const csrfFromHtml =
    html.match(/name="csrf_token"\s+value="([^"]+)"/i)?.[1] ||
    html.match(/"csrf_token"\s*:\s*"([^"]+)"/i)?.[1] ||
    null;

  return {
    release,
    correlationId,
    serverRenderId,
    loid,
    siteKey,
    captchaAction,
    checkboxSiteKey,
    loginStepPartial,
    loginActionPath,
    csrfFromHtml,
  };
}

// Decode Reddit's `token_v2` JWT payload safely (checks whether session is anonymous `sub: "loid"` vs authenticated `sub: "t2_..."`)
function inspectRedditJwt(tokenV2) {
  if (!tokenV2 || typeof tokenV2 !== 'string') {
    return { present: false, valid: false, isAuthenticatedUser: false, sub: null };
  }
  const parts = tokenV2.split('.');
  if (parts.length !== 3) {
    return { present: true, valid: false, isAuthenticatedUser: false, sub: null };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    const sub = payload.sub || null;
    const isAuthenticatedUser = Boolean(sub && sub !== 'loid' && sub !== 'anon' && sub.startsWith('t2_'));
    return {
      present: true,
      valid: true,
      sub,
      lid: payload.lid || null,
      exp: payload.exp || null,
      flo: payload.flo ?? null,
      isAuthenticatedUser,
    };
  } catch {
    return { present: true, valid: false, isAuthenticatedUser: false, sub: null };
  }
}

// Classify Reddit `/svc/shreddit/account/login` response accurately (fixes false-positive HTTP 200 on Faceplate HTML errors!)
function classifyLoginResponse({ status, headers = {}, text = '', cookies = {} }) {
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const body = String(text || '');
  const jwtInfo = inspectRedditJwt(cookies.token_v2);
  const hasRedditSession = Boolean(cookies.reddit_session);

  let jsonData = null;
  if (contentType.includes('json') || body.trim().startsWith('{')) {
    try {
      jsonData = JSON.parse(body);
    } catch {
      jsonData = null;
    }
  }

  // Extract human-readable alerts/helper messages from Faceplate partial HTML
  const extractedMessages = [];
  const helperMatches = body.matchAll(/helper-text-message="([^"]+)"/gi);
  for (const m of helperMatches) {
    if (m[1].trim()) extractedMessages.push(m[1].trim());
  }
  const alertAttrMatches = body.matchAll(/<(?:faceplate-alert|faceplate-banner)\b[^>]*\bmessage="([^"]+)"/gi);
  for (const m of alertAttrMatches) {
    if (m[1].trim()) extractedMessages.push(m[1].trim());
  }
  const alertInnerMatches = body.matchAll(/<(?:faceplate-alert|faceplate-banner|div[^>]*role="alert")[^>]*>([\s\S]*?)<\/(?:faceplate-alert|faceplate-banner|div)>/gi);
  for (const m of alertInnerMatches) {
    const stripped = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped) extractedMessages.push(stripped);
  }

  // Detect redirect indicators in Faceplate partials or JSON
  const redirectTarget =
    jsonData?.dest ||
    jsonData?.redirect ||
    headers.location ||
    headers['x-reddit-redirect'] ||
    body.match(/<(?:faceplate-redirect|shreddit-redirect)\b[^>]*\b(?:href|url)="([^"]+)"/i)?.[1] ||
    body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i)?.[1] ||
    null;

  // Detect 2FA / OTP step transition (including Shreddit HTTP 202 OTP status)
  const otpRequired =
    status === 202 ||
    /pageindex="[23]"/i.test(body) ||
    /slot="login_otp_(?:app|backup)"[^>]*active/i.test(body) ||
    Boolean(jsonData?.two_fa || jsonData?.otp || jsonData?.reason === 'TWO_FA_REQUIRED');

  const combinedErrors = [
    jsonData?.reason,
    jsonData?.explanation,
    jsonData?.message,
    ...(Array.isArray(jsonData?.errors) ? jsonData.errors.map((e) => JSON.stringify(e)) : []),
    ...extractedMessages,
  ]
    .filter(Boolean)
    .map((s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));

  const joinedLower = (combinedErrors.join(' ') + ' ' + body.slice(0, 2500)).toLowerCase();
  const jsChallengeAgain = parseRedditJsChallenge(body).isChallenge;

  const isPasswordResetRedirect = Boolean(
    redirectTarget && /\/(?:password|resetpassword|forgot|account\/lock)/i.test(redirectTarget)
  );
  const isBanRedirect = Boolean(
    redirectTarget && /\/(?:appeals|suspended|banned)/i.test(redirectTarget)
  );
  const hasPasswordResetAlert =
    isPasswordResetRedirect ||
    /reset your password|password reset|need to reset|locked your account|security precaution|suspicious activity/i.test(
      joinedLower
    );
  const hasBanAlert =
    isBanRedirect ||
    /permanently (?:banned|suspended)|account (?:is|has been) (?:suspended|banned)|suspended from reddit/i.test(
      joinedLower
    );

  const authenticated =
    (hasRedditSession ||
      jwtInfo.isAuthenticatedUser ||
      (status === 200 &&
        Boolean(redirectTarget) &&
        !isPasswordResetRedirect &&
        !isBanRedirect &&
        combinedErrors.length === 0 &&
        !otpRequired)) &&
    !isPasswordResetRedirect &&
    !isBanRedirect;

  let category = 'UNKNOWN_FAILURE';
  if (authenticated) {
    category = 'AUTHENTICATED';
  } else if (otpRequired) {
    category = 'OTP_REQUIRED';
  } else if (hasPasswordResetAlert) {
    category = 'PASSWORD_RESET_REQUIRED';
  } else if (hasBanAlert) {
    category = 'BANNED_SUSPENDED';
  } else if (status === 429 || /rate.?limit|too many requests|try again later/i.test(joinedLower)) {
    category = 'RATE_LIMITED';
  } else if (jsChallengeAgain) {
    category = 'JS_CHALLENGE_TRIGGERED';
  } else if (/csrf/i.test(joinedLower)) {
    category = 'CSRF_ERROR';
  } else if (/captcha|recaptcha|human verification|use_checkbox/i.test(joinedLower)) {
    category = 'CAPTCHA_REJECTED';
  } else if (/invalid (?:username|email) or password|incorrect (?:username|email) or password|wrong_password|invalid_credentials/i.test(joinedLower)) {
    category = 'INVALID_CREDENTIALS';
  } else if (status === 400) {
    category = 'BAD_REQUEST_400';
  } else if (status === 401 || status === 403) {
    category = `HTTP_${status}_FORBIDDEN`;
  } else if (status >= 500) {
    category = `SERVER_ERROR_${status}`;
  }

  return {
    authenticated,
    category,
    otpRequired,
    redirectTarget,
    hasRedditSession,
    jwtInfo,
    messages: [...new Set(combinedErrors)],
    contentType,
    jsonData,
  };
}

/**
 * Format Unix epoch seconds (`created_utc`) into a compact human-readable account age (`3y 4m`, `5m`, `12d`).
 */
function formatAccountAge(createdUtc) {
  if (!createdUtc || !Number.isFinite(Number(createdUtc))) return null;
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(createdUtc));
  const days = Math.floor(ageSec / 86400);
  if (days >= 365) {
    const yrs = Math.floor(days / 365);
    const mos = Math.floor((days % 365) / 30);
    return mos > 0 ? `${yrs}y ${mos}m` : `${yrs}y`;
  }
  if (days >= 30) {
    return `${Math.floor(days / 30)}m ${days % 30}d`;
  }
  return `${days}d`;
}

/**
 * Deterministic Post-Login Account Health Classifier (Step 5):
 * Inspects authenticated `/api/v1/me`, anonymous `/user/<name>/about`, and `/settings/account`
 * to separate genuine clean active accounts from:
 *   - `PASSWORD_RESET_REQUIRED` (Security-locked / forced password reset)
 *   - `BANNED_SUSPENDED`        (Permanently banned / suspended)
 *   - `BANNED_TEMP`             (Temporarily banned with expiration timestamp)
 *   - `SHADOWBANNED`            (Logged in OK, but public profile returns 404 Not Found to outsiders)
 */
function classifyAccountHealthData({
  fallbackUsername = '',
  meJson = null,
  meStatus = 0,
  publicAboutJson = null,
  publicAboutStatus = 0,
  settingsHtml = '',
  settingsFinalUrl = '',
} = {}) {
  const me = meJson && typeof meJson === 'object' ? (meJson.data && meJson.data.name ? meJson.data : meJson) : null;
  const hasAuthenticatedMe = Boolean(me && typeof me.name === 'string' && me.name.length > 0);
  const actualUsername = hasAuthenticatedMe ? me.name : fallbackUsername;

  const totalKarma = hasAuthenticatedMe
    ? Number(me.total_karma ?? (Number(me.link_karma || 0) + Number(me.comment_karma || 0)))
    : null;
  const linkKarma = hasAuthenticatedMe ? Number(me.link_karma || 0) : null;
  const commentKarma = hasAuthenticatedMe ? Number(me.comment_karma || 0) : null;
  const createdUtc = hasAuthenticatedMe && me.created_utc ? Number(me.created_utc) : null;
  const accountAge = formatAccountAge(createdUtc);
  const emailVerified = hasAuthenticatedMe ? Boolean(me.has_verified_email) : null;
  const isGold = hasAuthenticatedMe ? Boolean(me.is_gold) : false;
  const isMod = hasAuthenticatedMe ? Boolean(me.is_mod) : false;

  const baseMeta = {
    username: actualUsername,
    userId: hasAuthenticatedMe && me.id ? (String(me.id).startsWith('t2_') ? me.id : `t2_${me.id}`) : null,
    totalKarma,
    linkKarma,
    commentKarma,
    createdUtc,
    accountAge,
    emailVerified,
    isGold,
    isMod,
  };

  // 1. Check `/api/v1/me` forced password reset / unset password flags
  if (hasAuthenticatedMe && (me.force_password_reset === true || me.password_set === false)) {
    return {
      healthy: false,
      verdict: 'PASSWORD_RESET_REQUIRED',
      statusLabel: 'PASSWORD_RESET_LOCKED',
      reason:
        me.force_password_reset === true
          ? 'Account security locked by Reddit — Password reset required (force_password_reset=true)'
          : 'Account has no active password / reset required (password_set=false)',
      ...baseMeta,
    };
  }

  // 2. Check `/api/v1/me` suspension flags (`is_suspended` + `suspension_expiration_utc`)
  if (hasAuthenticatedMe && me.is_suspended === true) {
    const expUtc = me.suspension_expiration_utc ? Number(me.suspension_expiration_utc) : null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expUtc && expUtc > nowSec) {
      const untilDate = new Date(expUtc * 1000).toISOString().slice(0, 10);
      return {
        healthy: false,
        verdict: 'BANNED_TEMP',
        statusLabel: `TEMP_BANNED_UNTIL_${untilDate}`,
        reason: `Account temporarily banned/suspended until ${untilDate}`,
        suspensionExpirationUtc: expUtc,
        ...baseMeta,
      };
    }
    return {
      healthy: false,
      verdict: 'BANNED_SUSPENDED',
      statusLabel: 'PERMANENTLY_BANNED',
      reason: 'Account is permanently banned / suspended on Reddit (me.is_suspended=true)',
      ...baseMeta,
    };
  }

  // 3. Check `/settings/account` redirect or system lock/ban banners (post-free settings shell!)
  const urlStr = String(settingsFinalUrl || '');
  const htmlStr = String(settingsHtml || '');

  if (
    /\/(?:password|resetpassword|account\/locked)/i.test(urlStr) ||
    /locked your account as a security precaution|locked your account after detecting some unusual activity|to keep using reddit, reset your password|we['’]?ve locked your account|reset your password to continue|suspended your account due to suspicious activity|force-password-reset=["']true["']|"forcePasswordReset"\s*:\s*true/i.test(
      htmlStr
    )
  ) {
    return {
      healthy: false,
      verdict: 'PASSWORD_RESET_REQUIRED',
      statusLabel: 'SECURITY_LOCKED_RESET_PASS',
      reason: 'Reddit security lock banner detected — Password reset required to unlock account',
      ...baseMeta,
    };
  }

  if (
    /\/appeals\b/i.test(urlStr) ||
    /<shreddit-ban-banner|<shreddit-suspended-banner|your account has been permanently (?:banned|suspended)|your account is currently suspended/i.test(
      htmlStr
    )
  ) {
    return {
      healthy: false,
      verdict: 'BANNED_SUSPENDED',
      statusLabel: 'BANNED_BANNER_DETECTED',
      reason: 'Reddit account ban/suspension banner detected on authenticated session',
      ...baseMeta,
    };
  }

  // 4. Check anonymous public profile probe (`/user/<actualUsername>/about`) for Shadowban & Public Suspension!
  const pubData = publicAboutJson?.data || null;
  if (pubData && pubData.is_suspended === true) {
    return {
      healthy: false,
      verdict: 'BANNED_SUSPENDED',
      statusLabel: 'PUBLIC_PROFILE_SUSPENDED',
      reason: 'Public profile reports account is suspended (about.is_suspended=true)',
      ...baseMeta,
    };
  }

  if (hasAuthenticatedMe && publicAboutStatus === 404) {
    return {
      healthy: false,
      verdict: 'SHADOWBANNED',
      statusLabel: 'SHADOWBANNED_OR_LOCKED_404',
      reason: 'Account logged in, but public profile returns HTTP 404 to anonymous viewers (Shadowbanned / Security-Hidden)',
      ...baseMeta,
    };
  }

  // 5. REDDIT BAN SIGNATURE (verified live 2026-10-29 on known-banned accounts): a banned /
  //    security-flagged account logs in "successfully" (reddit_session + token_v2 issued), BUT
  //    oauth `/api/v1/me` returns HTTP 200 with an IDENTITY-STRIPPED body — only `{"features": {...}}`,
  //    no `name`/`id`/karma. Public profile still looks normal (no is_suspended field), and
  //    /settings/account renders with no banner. Corroborate with the public probe (200) so a
  //    genuinely broken session still routes to retry instead of a false ban verdict.
  if (
    !hasAuthenticatedMe &&
    meStatus === 200 &&
    meJson &&
    typeof meJson === 'object' &&
    publicAboutStatus === 200 &&
    // Anti false-positive: when Reddit network-security flags the IP, sessions degrade and
    // /settings/account force-redirects to /login (or the probe fails). Genuine banned accounts
    // RENDER the settings shell fine. Require it, or route to retry instead of a false ban.
    htmlStr.length > 0 &&
    !/\/login(?:[/?#]|$)/i.test(urlStr)
  ) {
    return {
      healthy: false,
      verdict: 'BANNED_SUSPENDED',
      statusLabel: 'IDENTITY_STRIPPED_ME_SESSION',
      reason:
        'Login succeeded but oauth /api/v1/me returned HTTP 200 with identity-stripped body ' +
        '("features" only, no username) — confirmed banned / security-flagged account signature',
      ...baseMeta,
    };
  }

  // 6. STRICT ANTI-POLLUTION GUARD #1: `/api/v1/me` MUST positively authenticate.
  //    If the probe failed for ANY reason (network error, timeout, WAF block, 401/403, missing token),
  //    the ban status is UNKNOWN — refuse to classify as clean (routes to retry_errors.txt, NEVER hits.txt).
  if (!hasAuthenticatedMe) {
    return {
      healthy: false,
      verdict: 'SESSION_INVALID',
      statusLabel: `ME_PROBE_INCONCLUSIVE_HTTP_${meStatus || 'ERR'}`,
      reason: `Authenticated /api/v1/me probe failed or returned no username (HTTP ${meStatus || 'no-response'}) — ban status unknown, refusing clean-hit classification`,
      ...baseMeta,
    };
  }

  // 7. STRICT ANTI-POLLUTION GUARD #2: the public ban/shadowban probe MUST return a definitive
  //    answer (200 = evaluated above, 404 = shadowbanned above). Any other outcome
  //    (0 network error, 401/403/429 WAF/rate-limit, 5xx) means ban status is UNKNOWN.
  if (publicAboutStatus !== 200) {
    return {
      healthy: false,
      verdict: 'SESSION_INVALID',
      statusLabel: `PUBLIC_PROBE_INCONCLUSIVE_HTTP_${publicAboutStatus || 'ERR'}`,
      reason: `Public ban/shadowban probe inconclusive (HTTP ${publicAboutStatus || 'no-response'}) — cannot confirm account is unbanned, refusing clean-hit classification`,
      ...baseMeta,
    };
  }

  return {
    healthy: true,
    verdict: 'AUTHENTICATED',
    statusLabel: 'ACTIVE',
    reason: 'Account is active, unbanned, and publicly visible',
    ...baseMeta,
  };
}

// Auto-discover Chrome/Chromium binary on Linux, macOS, and Windows
function findSystemBrowserExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  try {
    const rawPptr = require('puppeteer');
    const bundled = typeof rawPptr.executablePath === 'function' ? rawPptr.executablePath() : null;
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // Ignore if bundled browser isn't downloaded
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        ]
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ============================================================
// REDDIT SOLVER - MAIN ORCHESTRATOR CLASS
// ============================================================

class RedditSolver {
  constructor({
    proxy = null,
    mode = process.env.SOLVER_MODE || 'auto',
    rotationMode = process.env.ROTATION_MODE || 'hybrid',
    preferredBrand = process.env.PREFERRED_BRAND || null,
    headless = undefined,
    lease = null,
    leaseManager = null,
    enginePool = null,
    ownsLease = false,
    logger = null,
    profile = null,
    deviceCookies = null,
  } = {}) {
    this.logger = logger || new DebugLogger();
    this.rotationMode = ['single-engine', 'multi-engine', 'hybrid'].includes(rotationMode)
      ? rotationMode
      : 'hybrid';
    this.preferredBrand = preferredBrand || null;
    this.headless = resolveEffectiveHeadless(headless);
    this.lease = lease || null;
    this._leaseManager =
      leaseManager ||
      enginePool?.leaseManager ||
      getDefaultLeaseManager(this.rotationMode);
    this.enginePool = enginePool || null;
    this._ownedEnginePool = null;
    this._ownsLease = Boolean(ownsLease);
    this._autoLeasePending =
      !lease &&
      !profile &&
      (Boolean(this.preferredBrand) || (!process.env.TLS_CLIENT_ID && !process.env.USER_AGENT));
    this._closed = false;

    this.profile =
      (lease && lease.solverProfile) ||
      profile ||
      selectBrowserProfile({ preferredBrand: this.preferredBrand });
    this.proxy = proxy || lease?.proxy || process.env.PROXY_URL || null;
    this.mode = ['auto', 'browser', 'http'].includes(mode) ? mode : 'auto';
    this.client = new TlsHttpClient({
      proxy: this.proxy,
      profile: this.profile,
      logger: this.logger,
    });

    // W16: optional returning-device preseed — cached first-party cookies (loid/rdt/edgebucket/csv)
    // from this account's previous check make the session look like a returning device, not a
    // brand-new one. Enabled by the checker only when DEVICE_CACHE=1.
    if (deviceCookies && typeof deviceCookies === 'object') {
      const allowed = ['loid', 'rdt', 'edgebucket', 'csv'];
      for (const k of allowed) {
        if (deviceCookies[k]) this.client.cookies[k] = String(deviceCookies[k]);
      }
    }

    this.siteKey = SITE_KEY;
    this.version = DEFAULT_RECAPTCHA_VERSION;
    this.action = DEFAULT_ACTION;
    this.origin = ORIGIN;

    this.challengeUrl = '';
    this.loginPageUrl = 'https://www.reddit.com/login/';
    this.loginPageHtml = '';
    this.loginPartialHtml = '';
    this.csrfToken = '';
    this.anonymousTokenV2 = '';
    this.shredditConfig = {};
  }

  /**
   * Ensure this solver instance holds an exclusive, collision-free browser lease before I/O.
   */
  async ensureProfileLease() {
    if (!this._autoLeasePending || this.lease) return this.lease;
    this._autoLeasePending = false;

    const acquired = await this._leaseManager.acquireLease({
      workerId: `solver-${this.logger.runId || 'standalone'}`,
      preferredBrand: this.preferredBrand,
      proxyOverride: this.proxy,
    });

    this.lease = acquired;
    this._ownsLease = true;
    this.profile = acquired.solverProfile;
    this.proxy = this.proxy || acquired.proxy || null;

    // Re-bind TlsHttpClient to the exact leased profile & TLS session configuration
    await this.client.close();
    this.client = new TlsHttpClient({
      proxy: this.proxy,
      profile: this.profile,
      logger: this.logger,
    });

    this.logger.debug(
      'Rotation',
      `Bound solver to lease ${acquired.leaseId} -> ${this.profile.brandId} (${this.profile.engine}/${this.profile.os}, tls=${this.profile.tlsClientId})`
    );
    return this.lease;
  }

  /**
   * Release network session, standalone browser pool (if owned), and profile lease lock.
   */
  async close() {
    if (this._closed) return;
    this._closed = true;

    await this.client.close().catch(() => {});

    if (this._ownedEnginePool) {
      const pool = this._ownedEnginePool;
      this._ownedEnginePool = null;
      await pool.shutdown().catch(() => {});
    }

    if (this._ownsLease && this.lease && this._leaseManager) {
      const lid = this.lease.leaseId;
      this._ownsLease = false;
      await this._leaseManager.releaseLease(lid).catch(() => {});
    }
  }

  // ----------------------------------------------------------
  // STEP 1: Solve Reddit JS Challenge & Extract Live Login Config
  // ----------------------------------------------------------
  async solveJsChallenge() {
    await this.ensureProfileLease();
    this.logger.startStep('step1_js_challenge');
    this.logger.info(
      'Step1:JSChallenge',
      `Fetching Reddit /login/ page [Brand=${this.profile.brandId || this.profile.name}, TLS=${this.profile.tlsClientId}]...`
    );

    let parsedChallenge = { isChallenge: false, tokenValue: '', tokenField: null, inlineValue: '', fields: {} };
    let finalHtml = '';

    // W6: cookie warm-up — a real user lands on reddit.com BEFORE navigating to /login. Visiting
    // the frontpage first seeds natural first-party cookies (loid, rdt, edgebucket, session_tracker,
    // csv) so the login no longer comes from a "1-minute-old device". Opt-out: COOKIE_WARMUP=0.
    if (process.env.COOKIE_WARMUP !== '0') {
      try {
        const warmupRes = await this.client.get('https://www.reddit.com/', {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        });
        this.logger.info(
          'Step1:JSChallenge',
          `Cookie warm-up: frontpage HTTP ${warmupRes.status} -> cookies=[${Object.keys(this.client.cookies).join(', ')}]`
        );
        // Human dwell: "reading" the frontpage before clicking Login
        await new Promise((r) => setTimeout(r, 900 + crypto.randomInt(0, 2200)));
      } catch (warmErr) {
        this.logger.warn('Step1:JSChallenge', `Cookie warm-up warning (non-fatal): ${warmErr.message}`);
      }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const loginRes = await this.client.get('https://www.reddit.com/login/', {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      });

      const html = loginRes.text;
      this.logger.info('Step1:JSChallenge', `Initial /login/ -> HTTP ${loginRes.status} (${html.length} chars)`);

      parsedChallenge = parseRedditJsChallenge(html);
      finalHtml = html;

      if (isHumanityBlockPage(html)) {
        if (attempt < 2) {
          this.logger.warn(
            'Step1:JSChallenge',
            'Fastly per-IP burst bucket touched on initial /login/; backing off 5.5s and retrying cleanly...'
          );
          await this.client.close();
          this.client = new TlsHttpClient({ proxy: this.proxy, profile: this.profile, logger: this.logger });
          await new Promise((r) => setTimeout(r, 5500));
          continue;
        }
        this.logger.error(
          'Step1:JSChallenge',
          'Reddit WAF served "Prove your humanity" hard challenge! Check HTTP/2 headers, TLS fingerprint, or rotate IP/proxy.'
        );
        if (this.logger.dumpOnError) {
          this.logger.saveArtifact('step1_waf_humanity_block.html', html);
        }
      } else if (parsedChallenge.isChallenge) {
        this.challengeUrl = parsedChallenge.solutionUrl;
        this.logger.info(
          'Step1:JSChallenge',
          `Detected JS challenge (inline=${parsedChallenge.inlineValue}, field=${parsedChallenge.tokenField}=${this.logger.mask(parsedChallenge.tokenValue, 10, 4)})`
        );
        this.logger.debug('Step1:JSChallenge', 'Challenge form fields parsed', {
          fields: Object.keys(parsedChallenge.fields),
          solutionUrl: this.challengeUrl,
        });

        const challengeRes = await this.client.get(this.challengeUrl, {
          'Referer': 'https://www.reddit.com/login/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Upgrade-Insecure-Requests': '1',
        });

        this.loginPageUrl = challengeRes.url || this.challengeUrl;
        finalHtml = challengeRes.text;

        if (isHumanityBlockPage(finalHtml) && attempt < 2) {
          this.logger.warn(
            'Step1:JSChallenge',
            'Fastly per-IP burst bucket touched on challenge redirect; backing off 5.5s and retrying cleanly...'
          );
          await this.client.close();
          this.client = new TlsHttpClient({ proxy: this.proxy, profile: this.profile, logger: this.logger });
          await new Promise((r) => setTimeout(r, 5500));
          continue;
        }

        // Verify JS challenge didn't loop
        const secondCheck = parseRedditJsChallenge(finalHtml);
        if (secondCheck.isChallenge) {
          this.logger.warn('Step1:JSChallenge', 'Reddit returned a second JS challenge page after solution!');
          if (this.logger.dumpOnError) {
            this.logger.saveArtifact('step1_second_challenge.html', finalHtml);
          }
        } else {
          this.logger.info(
            'Step1:JSChallenge',
            `JS challenge solved -> HTTP ${challengeRes.status} (${finalHtml.length} chars, url=${this.loginPageUrl})`
          );
        }
      } else {
        this.logger.info('Step1:JSChallenge', 'No JS challenge gate served; already on Shreddit login page');
      }
      break;
    }

    this.loginPageHtml = finalHtml;
    if (this.logger.dumpAlways) {
      this.logger.saveArtifact('step1_login_page.html', finalHtml);
    }

    // Extract <shreddit-app> config & fetch login-step partial for live site-key and captcha-action
    const baseCfg = extractShredditPageConfig(finalHtml);
    let partialCfg = {};

    if (baseCfg.loginStepPartial) {
      try {
        const partialUrl = `https://www.reddit.com${baseCfg.loginStepPartial}`;
        const partialRes = await this.client.get(partialUrl, {
          'Accept': 'text/vnd.reddit.partial+html, text/html;q=0.9',
          'Referer': this.loginPageUrl,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Reddit-Retry': 'attempt=0, max=3',
        });
        if (partialRes.status === 200 && partialRes.text) {
          this.loginPartialHtml = partialRes.text;
          partialCfg = extractShredditPageConfig(partialRes.text);
          if (this.logger.dumpAlways) {
            this.logger.saveArtifact('step1_login_partial.html', partialRes.text);
          }
        }
      } catch (partialErr) {
        this.logger.warn('Step1:JSChallenge', `Optional login-step partial fetch warning: ${partialErr.message}`);
      }
    }

    this.shredditConfig = {
      ...baseCfg,
      ...Object.fromEntries(Object.entries(partialCfg).filter(([, v]) => v !== null && v !== undefined)),
    };

    if (!process.env.RECAPTCHA_SITE_KEY && this.shredditConfig.siteKey) {
      this.siteKey = this.shredditConfig.siteKey;
    }
    if (!process.env.RECAPTCHA_ACTION && this.shredditConfig.captchaAction) {
      this.action = this.shredditConfig.captchaAction;
    }

    this.csrfToken =
      this.client.cookies.csrf_token ||
      this.shredditConfig.csrfFromHtml ||
      '';

    // Preserve pre-login anonymous `token_v2` (`loid` Bearer token) BEFORE Step 4 login overwrites `token_v2`!
    // Used in Step 5C for cookieless outside-visitor Shadowban / Public Suspension checks.
    if (this.client.cookies.token_v2) {
      this.anonymousTokenV2 = this.client.cookies.token_v2;
    }

    const jwtCheck = inspectRedditJwt(this.client.cookies.token_v2);
    const cookieKeys = Object.keys(this.client.cookies);

    this.logger.info(
      'Step1:JSChallenge',
      `Session seeded: cookies=[${cookieKeys.join(', ') || 'none'}], csrf=${this.logger.mask(this.csrfToken)}, action="${this.action}"`
    );
    this.logger.debug('Step1:JSChallenge', 'Extracted live Shreddit configuration', {
      siteKey: this.siteKey,
      captchaAction: this.action,
      release: this.shredditConfig.release,
      loginActionPath: this.shredditConfig.loginActionPath,
      jwtSubject: jwtCheck.sub,
    });

    const elapsedMs = this.logger.endStep('step1_js_challenge', this.csrfToken ? 'ok' : 'warn_no_csrf', {
      cookieCount: cookieKeys.length,
      hasCsrf: Boolean(this.csrfToken),
      release: this.shredditConfig.release,
      action: this.action,
    });

    return {
      csrfToken: this.csrfToken,
      jsToken: parsedChallenge.tokenValue,
      tokenField: parsedChallenge.tokenField,
      inlineValue: parsedChallenge.inlineValue,
      shredditConfig: this.shredditConfig,
      durationMs: elapsedMs,
      cookies: { ...this.client.cookies },
    };
  }

  // ----------------------------------------------------------
  // Discover Live Google reCAPTCHA Release Version (`v=`)
  // ----------------------------------------------------------
  async fetchLiveRecaptchaVersion() {
    if (this._versionFetched) return this.version;
    try {
      const sdkUrl = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(this.siteKey)}`;
      const res = await this.client.googleGet(sdkUrl, {
        'Accept': '*/*',
        'Referer': 'https://www.reddit.com/',
      });
      const match = res.text.match(/releases\/([A-Za-z0-9_-]+)\/recaptcha/);
      if (match && match[1]) {
        if (match[1] !== this.version) {
          this.logger.debug('reCAPTCHA:SDK', `Discovered live reCAPTCHA release v=${match[1]} (was ${this.version})`);
        }
        this.version = match[1];
        this._versionFetched = true;
      }
    } catch (err) {
      this.logger.warn('reCAPTCHA:SDK', `Could not auto-fetch enterprise.js version (${err.message}); using ${this.version}`);
    }
    return this.version;
  }

  // ----------------------------------------------------------
  // STEP 2+3 (Method A — Primary): Hybrid Multi-Engine Browser Pool (`rebrowser-playwright-core`)
  // Runs genuine Chromium (`Chrome`, `Edge`, `Opera`, `Brave`, `Vivaldi`, `Ungoogled-Chromium`),
  // Mozilla Firefox / `Camoufox` (Gecko), or `Safari` (WebKit) matching `this.lease` 1:1!
  // Falls back to Puppeteer Stealth only if Playwright binaries are unavailable on host.
  // ----------------------------------------------------------
  async getRecaptchaTokenBrowser() {
    await this.ensureProfileLease();
    try {
      return await this._getRecaptchaTokenViaHybridPool();
    } catch (poolErr) {
      this.logger.warn(
        'Step2:BrowserPool',
        `Hybrid EnginePool solver warning (${poolErr.message}); attempting Puppeteer Stealth fallback...`
      );
      return await this._getRecaptchaTokenPuppeteerFallback();
    }
  }

  async _getRecaptchaTokenViaHybridPool() {
    this.logger.startStep('step2_recaptcha_browser');

    const pool =
      this.enginePool ||
      this._ownedEnginePool ||
      (this._ownedEnginePool = new EnginePoolManager({
        mode: this.rotationMode,
        headless: this.headless,
        logger: this.logger,
      }));

    // If this solver has a synthesized profile but not a lease wrapper (e.g. custom profile passed in),
    // construct an ad-hoc lease bundle so EnginePoolManager matches it 1:1 without mutating LeaseManager.
    const effectiveLease =
      this.lease ||
      (this.profile?._synthesized
        ? {
            leaseId: 'custom_profile',
            proxy: this.proxy,
            profile: this.profile._synthesized,
            tlsSessionOptions: buildTlsSessionOptions(this.profile._synthesized, { proxy: this.proxy }),
            http2Headers: buildProfileHttpHeaders(this.profile._synthesized, { http1: false }),
            initScript: require('./src/rotation').buildContextInitScript(this.profile._synthesized),
            solverProfile: this.profile,
          }
        : null);

    const session = await pool.acquireBrowserSession({
      workerId: `solver-${this.logger.runId || '0'}`,
      existingLease: effectiveLease,
      preferredBrand: this.preferredBrand,
      proxyOverride: this.proxy,
    });

    this.logger.info(
      'Step2:Browser',
      `Executing BotGuard in [${session.brandId} / ${session.engine} / ${session.os}] (${session.architecture}, action="${this.action}")...`
    );

    let networkTracker = null;
    try {
      const { page } = session;

      // Attach BEFORE navigation so the very first request is counted by the readiness gate.
      networkTracker = createNetworkTracker(page);

      page.on('pageerror', (err) => {
        this.logger.debug('Browser:PageError', err.message);
      });
      page.on('requestfailed', (req) => {
        const u = req.url();
        if (u.includes('reddit.com') || u.includes('google.com') || u.includes('gstatic.com')) {
          this.logger.debug('Browser:ReqFailed', `${req.method()} ${u} -> ${req.failure()?.errorText || 'failed'}`);
        }
      });

      // Sync Step 1 cookies from TlsHttpClient into this isolated BrowserContext
      const existingCookies = Object.entries(this.client.cookies).map(([name, value]) => ({
        name,
        value: String(value),
        domain: '.reddit.com',
        path: '/',
        secure: true,
      }));
      if (existingCookies.length > 0) {
        await session.setCookies(existingCookies);
        this.logger.debug(
          'Step2:Browser',
          `Seeded ${existingCookies.length} Step-1 cookies into isolated ${session.brandId} context`
        );
      }

      const targetUrl = this.loginPageUrl || 'https://www.reddit.com/login/';
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // ── READINESS GATE ────────────────────────────────────────────────────
      // `domcontentloaded` fires long before shreddit is done: it keeps streaming chunks and the
      // reCAPTCHA anchor fetches on its own schedule, and Reddit can still write `session` /
      // `csrf_token` after DOMContentLoaded. Reading cookies or calling execute() in that window
      // pairs a fresh token with a stale csrf on the login POST. Wait for load + network quiet +
      // a real login form before going further.
      const readiness = await waitForBrowserReady(page, {
        tracker: networkTracker,
        logger: this.logger,
        label: `recaptcha:${session.brandId}`,
        isReady: async () => {
          const state = await page
            .evaluate(() => ({
              grecaptcha:
                typeof grecaptcha !== 'undefined' &&
                typeof grecaptcha.enterprise !== 'undefined' &&
                typeof grecaptcha.enterprise.execute === 'function',
              form: Boolean(document.querySelector('faceplate-text-input, input[name="username"]')),
              csrfCookie: Boolean((document.cookie || '').includes('csrf_token')),
            }))
            .catch(() => ({ grecaptcha: false, form: false, csrfCookie: false }));
          return {
            ok: state.form || state.grecaptcha,
            reason: state.form || state.grecaptcha ? '' : 'login form and grecaptcha both missing',
            ...state,
          };
        },
      });
      this.logger.info(
        'Step2:Browser',
        `Page ready=${readiness.ready} in ${readiness.waitedMs}ms ` +
          `(readyState=${readiness.document?.readyState}, ` +
          `requests=${readiness.network?.finished ?? 0}/${readiness.network?.started ?? 0}, ` +
          `quiet=${readiness.network?.quiet})` +
          (readiness.reason ? ` — ${readiness.reason}` : '')
      );

      await page
        .waitForFunction(
          () =>
            typeof grecaptcha !== 'undefined' &&
            typeof grecaptcha.enterprise !== 'undefined' &&
            typeof grecaptcha.enterprise.execute === 'function',
          null,
          { timeout: 18000 }
        )
        .catch(() => null);

      let hasGrecaptcha = await page.evaluate(
        () =>
          typeof grecaptcha !== 'undefined' &&
          typeof grecaptcha.enterprise !== 'undefined' &&
          typeof grecaptcha.enterprise.execute === 'function'
      );

      if (!hasGrecaptcha) {
        this.logger.info('Step2:Browser', `Triggering lazy reCAPTCHA SDK load inside ${session.brandId}...`);
        await page
          .evaluate((siteKey) => {
            const input = document.querySelector('faceplate-text-input, input[name="username"]');
            if (input) input.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof grecaptcha === 'undefined') {
              const s = document.createElement('script');
              s.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
              document.head.appendChild(s);
            }
          }, this.siteKey)
          .catch(() => null);

        await page.waitForFunction(
          () =>
            typeof grecaptcha !== 'undefined' &&
            typeof grecaptcha.enterprise !== 'undefined' &&
            typeof grecaptcha.enterprise.execute === 'function',
          null,
          { timeout: 22000 }
        );
      }

      await page.mouse.move(200 + crypto.randomInt(0, 280), 160 + crypto.randomInt(0, 220), { steps: 6 });

      const result = await page.evaluate(
        ({ siteKey, action }) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ token: null, error: 'Timeout in execute (30s)' }), 30000);
            grecaptcha.enterprise.ready(function () {
              grecaptcha.enterprise
                .execute(siteKey, { action })
                .then((token) => {
                  clearTimeout(timer);
                  resolve({ token, error: null });
                })
                .catch((err) => {
                  clearTimeout(timer);
                  resolve({ token: null, error: err?.message || String(err) });
                });
            });
          }),
        { siteKey: this.siteKey, action: this.action }
      );

      // Let post-execute requests settle (the token XHR triggers follow-ups), otherwise we copy
      // a half-updated jar and the login POST ships with a stale csrf/session pair.
      await networkTracker.waitForQuiet({ quietWindowMs: 400, timeoutMs: 3000 });

      // Sync final reddit.com cookies back into TlsHttpClient and validate the pair Step 4 needs.
      const harvest = await this._harvestBrowserCookies(session);
      this.logger.info(
        'Step2:Browser',
        `Cookie harvest: ${harvest.copied}/${harvest.total} copied · csrf=${harvest.hasCsrf} · ` +
          `session=${harvest.hasSession} · loid=${harvest.hasLoid}`
      );
      if (!harvest.hasCsrf) {
        this.logger.warn(
          'Step2:Browser',
          'Browser context ended without a csrf_token cookie — Step 4 will try a login-page refresh first.'
        );
      }

      if (result.error || !result.token) {
        if (this.logger.dumpOnError) {
          const shot = await page.screenshot({ fullPage: false }).catch(() => null);
          if (shot) this.logger.saveArtifact('step2_browser_error.png', shot);
          const errHtml = await page.content().catch(() => '');
          if (errHtml) this.logger.saveArtifact('step2_browser_error.html', errHtml);
        }
        this.logger.endStep('step2_recaptcha_browser', 'failed', { error: result.error, brand: session.brandId });
        throw new Error(`Hybrid Browser (${session.brandId}) reCAPTCHA failed: ${result.error || 'empty token'}`);
      }

      const durationMs = this.logger.endStep('step2_recaptcha_browser', 'ok', {
        brand: session.brandId,
        engine: session.engine,
        tokenLength: result.token.length,
      });
      this.logger.info(
        'Step2:Browser',
        `reCAPTCHA token acquired via ${session.displayName} [${session.engine}] (${durationMs}ms): ${this.logger.mask(result.token)}`
      );

      return {
        recaptchaToken: result.token,
        method: `browser_${session.engine}_${session.brandId}`,
        brandId: session.brandId,
        engine: session.engine,
        action: this.action,
        durationMs,
      };
    } finally {
      networkTracker?.dispose();
      await session.close();
    }
  }

  async _getRecaptchaTokenPuppeteerFallback() {
    this.logger.startStep('step2_recaptcha_browser_puppeteer');
    this.logger.info('Step2:Browser', `Launching Puppeteer Stealth fallback (action="${this.action}")...`);

    const executablePath = findSystemBrowserExecutable();
    if (!executablePath) {
      this.logger.endStep('step2_recaptcha_browser', 'no_browser_binary');
      throw new Error(
        'No Chrome/Chromium executable found (set CHROME_PATH in .env, run `npx puppeteer browsers install chrome`, or use --mode http)'
      );
    }

    const devices = generateRandomDevice();
    const device = devices[0]; // 1920x1080 desktop matching profile
    const shadowSeed = generateShadow();

    // BUG-07 FIXED: Single clean `args` array WITH `--disable-blink-features=AutomationControlled` and matching UA
    const launchArgs = [
      `--user-agent=${this.profile.userAgent}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${device.width},${device.height}`,
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--no-zygote',
      '--disable-renderer-backgrounding',
      '--disable-default-apps',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
    ];

    let proxyCredentials = null;
    if (this.proxy) {
      try {
        const parsedProxy = new URL(this.proxy);
        launchArgs.push(`--proxy-server=${parsedProxy.protocol}//${parsedProxy.host}`);
        if (parsedProxy.username || parsedProxy.password) {
          proxyCredentials = {
            username: decodeURIComponent(parsedProxy.username),
            password: decodeURIComponent(parsedProxy.password),
          };
        }
      } catch {
        this.logger.warn('Step2:Browser', `Invalid proxy URL for Puppeteer: ${maskProxyUrl(this.proxy)}`);
      }
    }

    this.logger.debug('Step2:Browser', 'Browser launch configuration', {
      executablePath,
      viewport: `${device.width}x${device.height}@${device.dpr}x`,
      userAgent: this.profile.userAgent,
      proxy: maskProxyUrl(this.proxy),
      shadowSeedHash: shadowSeed.slice(0, 12),
    });

    const puppeteer = getPuppeteer();
    const browser = await puppeteer.launch({
      executablePath,
      headless: this.headless ? 'new' : false,
      args: launchArgs,
    });

    try {
      const page = await browser.newPage();
      if (proxyCredentials) {
        await page.authenticate(proxyCredentials);
      }

      await page.setViewport({
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.dpr,
      });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      // Attach browser diagnostic listeners for --debug / --trace
      page.on('pageerror', (err) => {
        this.logger.debug('Browser:PageError', err.message);
      });
      page.on('requestfailed', (req) => {
        const u = req.url();
        if (u.includes('reddit.com') || u.includes('google.com') || u.includes('gstatic.com')) {
          this.logger.debug('Browser:ReqFailed', `${req.method()} ${u} -> ${req.failure()?.errorText || 'failed'}`);
        }
      });
      page.on('response', (res) => {
        const u = res.url();
        if (u.includes('/recaptcha/') || u.includes('/svc/shreddit/')) {
          this.logger.trace('Browser:Net', `HTTP ${res.status()} ${u}`);
        }
      });

      // BUG-12 FIXED: Sync Step 1 cookies from TlsHttpClient into Puppeteer so session/loid/csrf match
      const existingCookies = Object.entries(this.client.cookies).map(([name, value]) => ({
        name,
        value: String(value),
        domain: '.reddit.com',
        path: '/',
        secure: true,
      }));
      if (existingCookies.length > 0) {
        await page.setCookie(...existingCookies);
        this.logger.debug('Step2:Browser', `Injected ${existingCookies.length} session cookies into browser`);
      }

      const targetUrl = this.loginPageUrl || 'https://www.reddit.com/login/';
      this.logger.info('Step2:Browser', `Navigating to ${targetUrl}...`);
      const pupTracker = createNetworkTracker(page);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Same readiness gate as the hybrid path: load + network quiet + a real login form.
      const pupReady = await waitForBrowserReady(page, {
        tracker: pupTracker,
        logger: this.logger,
        label: 'puppeteer:recaptcha',
        isReady: async () => {
          const state = await page
            .evaluate(() => ({
              grecaptcha:
                typeof grecaptcha !== 'undefined' &&
                typeof grecaptcha.enterprise !== 'undefined' &&
                typeof grecaptcha.enterprise.execute === 'function',
              form: Boolean(document.querySelector('faceplate-text-input, input[name="username"]')),
            }))
            .catch(() => ({ grecaptcha: false, form: false }));
          return { ok: state.form || state.grecaptcha, ...state };
        },
      });
      this.logger.info(
        'Step2:Browser',
        `Puppeteer page ready=${pupReady.ready} in ${pupReady.waitedMs}ms ` +
          `(readyState=${pupReady.document?.readyState}, quiet=${pupReady.network?.quiet})` +
          (pupReady.reason ? ` — ${pupReady.reason}` : '')
      );

      await page
        .waitForFunction(
          () =>
            typeof grecaptcha !== 'undefined' &&
            typeof grecaptcha.enterprise !== 'undefined' &&
            typeof grecaptcha.enterprise.execute === 'function',
          { timeout: 20000 }
        )
        .catch(() => null);

      let hasGrecaptcha = await page.evaluate(
        () =>
          typeof grecaptcha !== 'undefined' &&
          typeof grecaptcha.enterprise !== 'undefined' &&
          typeof grecaptcha.enterprise.execute === 'function'
      );

      if (!hasGrecaptcha) {
        this.logger.info('Step2:Browser', 'Waiting for browser JS challenge / lazy reCAPTCHA script...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);

        // Trigger input focus in case Shreddit lazy-loads reCAPTCHA on interaction (`onInputChange -> insertRecaptchaScript`)
        await page
          .evaluate((siteKey) => {
            const input = document.querySelector('faceplate-text-input, input[name="username"]');
            if (input) input.dispatchEvent(new Event('input', { bubbles: true }));
            if (typeof grecaptcha === 'undefined') {
              const s = document.createElement('script');
              s.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
              document.head.appendChild(s);
            }
          }, this.siteKey)
          .catch(() => null);

        await page.waitForFunction(
          () =>
            typeof grecaptcha !== 'undefined' &&
            typeof grecaptcha.enterprise !== 'undefined' &&
            typeof grecaptcha.enterprise.execute === 'function',
          { timeout: 25000 }
        );
      }

      // Small human-like mouse movement before execute()
      await page.mouse.move(220 + crypto.randomInt(0, 300), 180 + crypto.randomInt(0, 240), { steps: 6 });

      this.logger.info('Step2:Browser', `Executing grecaptcha.enterprise.execute(siteKey, { action: "${this.action}" })...`);
      const result = await page.evaluate(
        (siteKey, action) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ token: null, error: 'Timeout in execute (30s)' }), 30000);
            grecaptcha.enterprise.ready(function () {
              grecaptcha.enterprise
                .execute(siteKey, { action })
                .then((token) => {
                  clearTimeout(timer);
                  resolve({ token, error: null });
                })
                .catch((err) => {
                  clearTimeout(timer);
                  resolve({ token: null, error: err?.message || String(err) });
                });
            });
          }),
        this.siteKey,
        this.action
      );

      // Sync any updated reddit.com cookies back to TlsHttpClient
      // Settle post-execute requests, then copy the final jar through the shared harvester so the
      // Puppeteer path and the hybrid path can never drift.
      await pupTracker.waitForQuiet({ quietWindowMs: 400, timeoutMs: 3000 });
      pupTracker.dispose();
      const pupHarvest = await this._harvestBrowserCookies({
        getCookies: async () => page.cookies('https://www.reddit.com', 'https://old.reddit.com'),
      });
      this.logger.debug(
        'Step2:Browser',
        `Puppeteer cookie harvest: ${pupHarvest.copied}/${pupHarvest.total} copied, csrf=${pupHarvest.hasCsrf}`
      );

      if (result.error || !result.token) {
        if (this.logger.dumpOnError) {
          const shot = await page.screenshot({ fullPage: false }).catch(() => null);
          if (shot) this.logger.saveArtifact('step2_browser_error.png', shot);
          const errHtml = await page.content().catch(() => '');
          if (errHtml) this.logger.saveArtifact('step2_browser_error.html', errHtml);
        }
        this.logger.endStep('step2_recaptcha_browser', 'failed', { error: result.error });
        throw new Error(`Browser reCAPTCHA execution failed: ${result.error || 'empty token'}`);
      }

      const durationMs = this.logger.endStep('step2_recaptcha_browser', 'ok', {
        tokenLength: result.token.length,
      });
      this.logger.info(
        'Step2:Browser',
        `reCAPTCHA token acquired via Browser BotGuard (${durationMs}ms): ${this.logger.mask(result.token)}`
      );

      return {
        recaptchaToken: result.token,
        method: 'browser',
        action: this.action,
        durationMs,
      };
    } finally {
      await browser.close().catch(() => {});
      this.logger.debug('Step2:Browser', 'Browser closed cleanly');
    }
  }

  // ----------------------------------------------------------
  // STEP 2+3 (Method B): Direct HTTP Anchor + Protobuf Reload Solver
  // ----------------------------------------------------------
  /**
   * W20: optional proxy-geo -> timezone mapping. If `proxy_geo.json` exists (or PROXY_GEO_FILE is
   * set), entries map a proxy host/substring to `{ tzOffsetMin, timezoneId }` so telemetry matches
   * the egress IP's real location instead of a random preset:
   *   { "gate.example.com": { "tzOffsetMin": 240, "timezoneId": "America/New_York" } }
   */
  _proxyGeoHint() {
    if (this._geoHintCache !== undefined) return this._geoHintCache;
    this._geoHintCache = null;
    try {
      if (!this.proxy) return null;
      const geoFile = process.env.PROXY_GEO_FILE || path.join(__dirname, 'proxy_geo.json');
      if (!fs.existsSync(geoFile)) return null;
      const mapping = JSON.parse(fs.readFileSync(geoFile, 'utf-8').replace(/^﻿/, ''));
      const host = (() => { try { return new URL(this.proxy).hostname; } catch { return String(this.proxy); } })();
      for (const [key, hint] of Object.entries(mapping)) {
        if (host.includes(key) && hint && Number.isFinite(Number(hint.tzOffsetMin))) {
          this._geoHintCache = { tzOffsetMin: Number(hint.tzOffsetMin), timezoneId: hint.timezoneId || null, matched: key };
          break;
        }
      }
    } catch (err) {
      this.logger?.warn('GeoHint', `proxy_geo mapping warning: ${err.message}`);
    }
    return this._geoHintCache;
  }

  async getRecaptchaTokenHttp() {
    await this.ensureProfileLease();
    this.logger.startStep('step2_recaptcha_http');
    await this.fetchLiveRecaptchaVersion();

    // W2: per-session randomized reCAPTCHA timing budget (was hardcoded 20000/30000 for EVERY
    // account = deterministic bot signature). Values stay inside realistic browser ranges.
    const anchorMs = 15000 + crypto.randomInt(0, 20001); // 15s..35s
    const executeMs = 25000 + crypto.randomInt(0, 25001); // 25s..50s

    const anchorUrl = buildAnchorUrl({
      siteKey: this.siteKey,
      version: this.version,
      origin: this.origin,
      anchorMs,
      executeMs,
    });

    this.logger.info('Step2:HTTP', `Fetching reCAPTCHA Enterprise anchor (v=${this.version})...`);
    const anchorRes = await this.client.googleGet(anchorUrl, {
      'Referer': 'https://www.reddit.com/',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
    });

    const anchorToken = extractAnchorToken(anchorRes.text);
    if (!anchorToken) {
      if (this.logger.dumpOnError) {
        this.logger.saveArtifact('step2_anchor_failed.html', anchorRes.text);
      }
      this.logger.endStep('step2_recaptcha_http', 'anchor_failed', { status: anchorRes.status });
      throw new Error(`Failed to extract anchor recaptcha-token (HTTP ${anchorRes.status}, len=${anchorRes.text.length})`);
    }

    const sessionHash = extractSessionHash(anchorRes.text);
    const initParams = extractInitParams(anchorRes.text);

    this.logger.debug('Step2:HTTP', 'Anchor parsed successfully', {
      anchorToken: this.logger.mask(anchorToken),
      sessionHash,
      bgdataLength: initParams.bgdataLength || 0,
      serverTimestamp: initParams.serverTimestamp || null,
    });

    // W3: pull REAL hardware values from the synthesized lease profile (screen/colorDepth/dpr/
    // engine) so telemetry matches the fingerprint instead of fixed 1920x1080/24 defaults.
    const synth = this.profile.synthesized || this.profile._synthesized || null;
    const profScreen = synth?.screen || null;
    const payload = buildReloadPayload({
      version: this.version,
      initialToken: anchorToken,
      sessionHash,
      action: this.action,
      siteKey: this.siteKey,
      userAgent: this.profile.userAgent,
      screenWidth: profScreen?.width || this.profile.screenWidth || 1920,
      screenHeight: profScreen?.height || this.profile.screenHeight || 1080,
      devicePixelRatio: profScreen?.devicePixelRatio || synth?.devicePixelRatio || this.profile.dpr || 1.0,
      colorDepth: profScreen?.colorDepth || 24,
      // W4: timezone must come from the PROFILE's locale preset (America/New_York etc.), NOT the
      // worker PC's local clock — otherwise IP-geo ↔ TZ ↔ locale signals contradict each other.
      // W20: when a proxy is in use and a geo mapping exists, the PROXY's location wins.
      timezoneOffsetMin: (() => {
        const geo = this._proxyGeoHint();
        if (geo) return geo.tzOffsetMin;
        return Number.isFinite(Number(synth?.tzOffsetMin))
          ? Number(synth.tzOffsetMin)
          : new Date().getTimezoneOffset();
      })(),
      engine: this.profile.engine || synth?.engine || 'chromium',
      anchorMs,
      executeMs,
    });

    // W2: human-like pause between anchor load and reload execute (real browsers run the
    // challenge for a non-constant duration before posting).
    await new Promise((r) => setTimeout(r, 600 + crypto.randomInt(0, 1600)));

    const reloadUrl = buildReloadUrl(this.siteKey);
    this.logger.info('Step2:HTTP', `Posting protobuf reload (${payload.length} bytes, action="${this.action}")...`);
    this.logger.trace('Step2:HTTP', `Protobuf payload hex (first 64B): ${payload.subarray(0, 64).toString('hex')}`);

    const viaNative = process.env.GOOGLE_VIA_NATIVE === '1';
    const reloadRes = await this.client.googlePost(
      reloadUrl,
      viaNative ? payload : payload.toString('base64'),
      {
        'Accept': '*/*',
        // Keep the real protobuffer content-type; mark base64 transfer encoding so
        // node-tls-client treats it as a byte request (isByteRequest) and decodes on the wire.
        'Content-Type': 'application/x-protobuffer',
        ...(viaNative ? {} : { 'Content-Transfer-Encoding': 'base64' }),
        'Origin': 'https://www.google.com',
        'Referer': anchorUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      }
    );

    const parsed = parseReloadResponse(reloadRes.text);
    if (parsed.error || !parsed.recaptchaToken) {
      if (this.logger.dumpOnError) {
        this.logger.saveArtifact('step2_reload_failed.txt', reloadRes.text);
      }
      this.logger.endStep('step2_recaptcha_http', 'reload_failed', { error: parsed.error });
      throw new Error(`reCAPTCHA reload failed: ${parsed.error || 'null token'} (HTTP ${reloadRes.status})`);
    }

    const durationMs = this.logger.endStep('step2_recaptcha_http', 'ok', {
      tokenLength: parsed.recaptchaToken.length,
      ttlSeconds: parsed.ttlSeconds,
    });

    this.logger.info(
      'Step2:HTTP',
      `reCAPTCHA token acquired via HTTP Protobuf (${durationMs}ms, ttl=${parsed.ttlSeconds}s): ${this.logger.mask(parsed.recaptchaToken)}`
    );

    return {
      recaptchaToken: parsed.recaptchaToken,
      ttlSeconds: parsed.ttlSeconds,
      method: 'http_protobuf',
      action: this.action,
      durationMs,
    };
  }

  // ----------------------------------------------------------
  // STEP 2+3 Dispatcher (browser | http | auto with fallback)
  // ----------------------------------------------------------
  async acquireRecaptchaToken() {
    if (this.mode === 'http') {
      return this.getRecaptchaTokenHttp();
    }
    if (this.mode === 'browser') {
      return this.getRecaptchaTokenBrowser();
    }

    // W14: single-stack session option — after the W1-W3 TLS-telemetry parity fixes, the full-TLS
    // solver path presents ONE consistent network personality (TLS JA3 + headers + telemetry all
    // from the same synthesized profile). `PREFER_HTTP_SOLVER=1` makes `auto` mode prefer it,
    // eliminating the dual-personality pattern (real browser solves captcha, TLS client posts login).
    if (this.mode === 'auto' && process.env.PREFER_HTTP_SOLVER === '1') {
      try {
        return await this.getRecaptchaTokenHttp();
      } catch (httpErr) {
        this.logger.warn(
          'Step2:AutoFallback',
          `HTTP single-stack solver failed (${httpErr.message}); falling back to Browser BotGuard`
        );
        return await this.getRecaptchaTokenBrowser();
      }
    }

    // `auto` mode: try real BotGuard browser first, fall back to HTTP Anchor+Protobuf if unavailable/fails
    try {
      return await this.getRecaptchaTokenBrowser();
    } catch (browserErr) {
      this.logger.warn(
        'Step2:AutoFallback',
        `Browser solver unavailable (${browserErr.message}); falling back to HTTP Anchor+Protobuf solver`
      );
      const httpResult = await this.getRecaptchaTokenHttp();
      httpResult.fallbackReason = browserErr.message;
      return httpResult;
    }
  }

  // ----------------------------------------------------------
  // STEP 4: Reddit Shreddit Login API + Response Verification
  // ----------------------------------------------------------
  /**
   * Copy the browser's FINAL Reddit cookies into the TLS client jar.
   *
   * Called only after `waitForBrowserReady()` + a network-quiet window, so what we copy is the
   * settled jar rather than whatever existed at DOMContentLoaded. Keeping this in one place means
   * Step 2 (browser) and Step 4 (TLS POST) can never drift apart.
   *
   * @param {object} session EnginePoolManager browser session
   * @returns {Promise<{copied:number,total:number,hasCsrf:boolean,hasSession:boolean,hasLoid:boolean,csrf:string}>}
   */
  async _harvestBrowserCookies(session) {
    const urls = ['https://www.reddit.com', 'https://www.reddit.com/login/', 'https://old.reddit.com'];
    const cookies = await session.getCookies(urls).catch(() => []);
    let copied = 0;
    for (const c of cookies) {
      if (c && c.name && c.value) {
        this.client.cookies[c.name] = c.value;
        copied += 1;
      }
    }
    if (this.client.cookies.csrf_token) {
      this.csrfToken = this.client.cookies.csrf_token;
    }
    return {
      copied,
      total: cookies.length,
      hasCsrf: Boolean(this.client.cookies.csrf_token || this.csrfToken),
      hasSession: Boolean(this.client.cookies.session || this.client.cookies.reddit_session),
      hasLoid: Boolean(this.client.cookies.loid),
      csrf: this.client.cookies.csrf_token || this.csrfToken || '',
    };
  }

  /**
   * Re-fetch the login page over the TLS client to (re)seed `csrf_token` / `loid` / `session`.
   * Used as a last resort when the browser step could not hand over a csrf cookie, so Step 4 does
   * not fire a request that is guaranteed to be rejected.
   */
  async _refreshLoginPageCookies() {
    const url = this.loginPageUrl || 'https://www.reddit.com/login/';
    const res = await this.client.get(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });
    const html = res.text || '';
    const formToken =
      html.match(/name="token"\s+value="([^"]+)"/)?.[1] ||
      html.match(/id="csrf_token"[^>]*value="([^"]+)"/)?.[1] ||
      null;
    if (formToken && !this.client.cookies.csrf_token) {
      this.csrfToken = formToken;
    }
    const inline = html.match(/id="solution"\s+value="([^"]+)"/)?.[1];
    if (inline && !this.loginPageHtml) this.loginPageHtml = html;
    return {
      status: res.status,
      htmlBytes: html.length,
      formToken: Boolean(formToken),
      csrf: this.client.cookies.csrf_token || this.csrfToken || '',
    };
  }

  /**
   * Gate between "browser produced a token" and "Step 4 fires the credential POST".
   *
   * A login POST without csrf/session cannot succeed and burns an account attempt, so: check, and
   * if the jar is incomplete, refresh the login page once over TLS and re-check. Never throws —
   * Step 4 still runs (Reddit sometimes accepts a bare `loid`), but the log says exactly why.
   *
   * @param {{refresh?:boolean}} [options]
   */
  async ensureLoginSessionReady({ refresh = true } = {}) {
    const read = () => ({
      csrf: this.client.cookies.csrf_token || this.csrfToken || '',
      hasCsrf: Boolean(this.client.cookies.csrf_token || this.csrfToken),
      hasSession: Boolean(this.client.cookies.session || this.client.cookies.reddit_session),
      hasLoid: Boolean(this.client.cookies.loid),
    });

    let state = read();
    if (state.hasCsrf && (state.hasSession || state.hasLoid)) {
      this.logger.debug('Step4:Readiness', `session ready (csrf=${this.logger.mask(state.csrf)})`);
      return { ok: true, refreshed: false, ...state };
    }

    this.logger.warn(
      'Step4:Readiness',
      `Login session incomplete before submit (csrf=${state.hasCsrf}, session=${state.hasSession}, loid=${state.hasLoid}) — refreshing login page once`
    );

    let refreshed = false;
    if (refresh) {
      try {
        const r = await this._refreshLoginPageCookies();
        refreshed = true;
        this.logger.info(
          'Step4:Readiness',
          `Login page refresh: HTTP ${r.status}, ${r.htmlBytes}B, formToken=${r.formToken}, csrf=${Boolean(r.csrf)}`
        );
      } catch (err) {
        this.logger.warn('Step4:Readiness', `Login page refresh failed: ${err.message}`);
      }
    }

    state = read();
    const ok = state.hasCsrf && (state.hasSession || state.hasLoid);
    if (!ok) {
      this.logger.warn(
        'Step4:Readiness',
        `Still incomplete (csrf=${state.hasCsrf}, session=${state.hasSession}, loid=${state.hasLoid}); submitting anyway`
      );
    }
    return { ok, refreshed, ...state };
  }

  async login(username, password, recaptchaToken) {
    this.logger.startStep('step4_reddit_login');
    this.logger.info('Step4:Login', `Submitting credentials for user "${username}"...`);

    // Browser finished loading + handed over its cookies before we got here; verify the pair the
    // POST actually depends on and refresh once if the handover was incomplete.
    await this.ensureLoginSessionReady();

    // BUG-11 FIXED: Preserve CSRF from both cookie jar AND HTML fallback
    const csrfToken = this.client.cookies.csrf_token || this.csrfToken || '';
    if (!csrfToken) {
      this.logger.warn('Step4:Login', 'csrf_token is empty! Step 1 JS challenge may not have seeded cookies.');
    }

    const params = new URLSearchParams();
    params.set('username', username);
    params.set('password', password);
    params.set('recaptcha_token', recaptchaToken);
    params.set('recaptcha_use_checkbox', 'false');
    params.set('recaptcha_action', this.action);
    params.set('csrf_token', csrfToken);
    const formBody = params.toString();

    const referer = this.loginPageUrl || this.challengeUrl || 'https://www.reddit.com/login/';
    // BUG-11 FIXED: Use real release string from <shreddit-app release="..."> when available
    const clientVersion =
      this.shredditConfig.release ||
      `${new Date().toISOString().slice(0, 16)}Z~web3x`;
    const loginPath = this.shredditConfig.loginActionPath || '/svc/shreddit/account/login';
    const loginUrl = loginPath.startsWith('http') ? loginPath : `https://www.reddit.com${loginPath}`;

    this.logger.debug('Step4:Login', 'Prepared login request metadata', {
      loginUrl,
      username,
      password: '[REDACTED]',
      csrfToken: this.logger.mask(csrfToken),
      recaptchaToken: this.logger.mask(recaptchaToken),
      recaptchaAction: this.action,
      clientVersion,
      referer,
      payloadBytes: Buffer.byteLength(formBody),
    });

    // BUG-06 FIXED: Properly declared `const res` + HTTP/2-compliant Shreddit Faceplate headers
    const res = await this.client.post(loginUrl, formBody, {
      'Accept': 'text/vnd.reddit.partial+html, text/html;q=0.9, application/json;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.reddit.com',
      'Referer': referer,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Reddit-Retry': 'attempt=0, max=3',
      'x-original-referer': 'https://www.reddit.com/login/',
      'x-reddit-client-version': clientVersion,
      ...(this.client.cookies.loid ? { 'x-reddit-loid': this.client.cookies.loid } : {}),
    });

    const classification = classifyLoginResponse({
      status: res.status,
      headers: res.headers,
      text: res.text,
      cookies: this.client.cookies,
    });

    const durationMs = this.logger.endStep(
      'step4_reddit_login',
      classification.authenticated ? 'authenticated' : classification.category.toLowerCase(),
      {
        httpStatus: res.status,
        category: classification.category,
        hasRedditSession: classification.hasRedditSession,
        jwtSub: classification.jwtInfo.sub,
      }
    );

    this.logger.info(
      'Step4:Login',
      `Response HTTP ${res.status} (${durationMs}ms) -> Verdict: ${classification.category}`
    );

    if (classification.messages.length > 0) {
      this.logger.warn('Step4:Login', `Server messages: ${classification.messages.join(' | ')}`);
    }

    this.logger.debug('Step4:Login', 'Post-login session & response diagnostics', {
      httpStatus: res.status,
      contentType: classification.contentType,
      authenticated: classification.authenticated,
      verdict: classification.category,
      otpRequired: classification.otpRequired,
      redirectTarget: classification.redirectTarget,
      hasRedditSessionCookie: classification.hasRedditSession,
      tokenV2Jwt: classification.jwtInfo,
      cookieKeys: Object.keys(this.client.cookies),
      messages: classification.messages,
    });

    this.logger.trace('Step4:Login', `Response body excerpt (first 1000 chars):\n${res.text.slice(0, 1000)}`);

    if ((!classification.authenticated && this.logger.dumpOnError) || this.logger.dumpAlways) {
      this.logger.saveArtifact('step4_login_response.html', res.text);
    }

    return {
      success: classification.authenticated,
      status: res.status,
      verdict: classification.category,
      otpRequired: classification.otpRequired,
      messages: classification.messages,
      redirectTarget: classification.redirectTarget,
      data: classification.jsonData || {
        verdict: classification.category,
        messages: classification.messages,
        dest: classification.redirectTarget,
      },
      jwtInfo: classification.jwtInfo,
      cookies: { ...this.client.cookies },
    };
  }

  // ----------------------------------------------------------
  // STEP 5: Post-Login Account Health, Ban, Shadowban & Lock Verification
  // ----------------------------------------------------------
  async queryAnonymousPublicProfile(targetUsername, fallbackBearerToken = '') {
    const cleanUser = String(targetUsername || '').trim();
    if (!cleanUser || cleanUser.includes('@')) {
      return { status: 0, json: null };
    }

    const attemptProbe = async (url, headers) => {
      const probeClient = new TlsHttpClient({
        proxy: this.proxy,
        profile: this.profile,
        logger: this.logger,
        enableRateLimit: false,
      });
      try {
        const res = await probeClient.get(url, headers);
        let json = null;
        try {
          json = JSON.parse(res.text);
        } catch {
          json = null;
        }
        return { status: res.status, json };
      } finally {
        await probeClient.close();
      }
    };

    // Strategy 1: oauth.reddit.com with anonymous token (or the account's OWN token_v2 as fallback!)
    const bearer = this.anonymousTokenV2 || fallbackBearerToken || '';
    if (bearer) {
      try {
        return await attemptProbe(`https://oauth.reddit.com/user/${encodeURIComponent(cleanUser)}/about?raw_json=1`, {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/json',
          Origin: 'https://www.reddit.com',
          Referer: 'https://www.reddit.com/',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
        });
      } catch (err) {
        this.logger.warn('Step5:AccountHealth', `OAuth public profile check warning for "${cleanUser}": ${err.message}`);
      }
    }

    // Strategy 2 (FALLBACK): Cookieless www.reddit.com about.json — requires NO token and still
    // exposes `data.is_suspended=true` (banned) and HTTP 404 (shadowbanned/hidden).
    try {
      return await attemptProbe(`https://www.reddit.com/user/${encodeURIComponent(cleanUser)}/about.json?raw_json=1`, {
        Accept: 'application/json',
        Referer: 'https://www.reddit.com/',
      });
    } catch (err) {
      this.logger.warn('Step5:AccountHealth', `www public profile check warning for "${cleanUser}": ${err.message}`);
      return { status: 0, json: null };
    }
  }

  async verifyAccountHealth(loginUsername) {
    this.logger.startStep('step5_account_health');
    const authToken = this.client.cookies.token_v2 || '';

    let meStatus = 0;
    let meJson = null;
    if (authToken) {
      // Retry once: a transient probe failure must NEVER downgrade the health check to "unknown"
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const meRes = await this.client.get('https://oauth.reddit.com/api/v1/me?raw_json=1', {
            Authorization: `Bearer ${authToken}`,
            Accept: 'application/json',
            Origin: 'https://www.reddit.com',
            Referer: 'https://www.reddit.com/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
          });
          meStatus = meRes.status;
          try {
            meJson = JSON.parse(meRes.text);
          } catch {
            meJson = null;
          }
          if (this.logger.dumpAlways) {
            this.logger.saveArtifact('step5_oauth_me.json', meRes.text);
          }
          if (meStatus === 200 && meJson && typeof meJson.name === 'string') break;
        } catch (err) {
          this.logger.warn('Step5:AccountHealth', `oauth /api/v1/me probe warning (attempt ${attempt}/2): ${err.message}`);
        }
      }
    }

    const resolvedUsername =
      (meJson && typeof meJson.name === 'string' && meJson.name) ||
      (!String(loginUsername || '').includes('@') ? String(loginUsername || '').trim() : '');

    // W5: break the identical request-graph — every account used to fire the exact same probe
    // burst (me -> settings+about parallel, zero gap). Now: randomized micro-pauses and a coin-
    // flip between parallel vs sequential probe order (human sessions never repeat one graph).
    const humanPause = (minMs, spreadMs) =>
      new Promise((r) => setTimeout(r, minMs + crypto.randomInt(0, spreadMs)));
    await humanPause(250, 950);

    const fetchSettings = () =>
      this.client
        .get('https://www.reddit.com/settings/account', {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.reddit.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
        })
        .catch((err) => {
          this.logger.warn('Step5:AccountHealth', `settings/account check warning: ${err.message}`);
          return { status: 0, url: '', text: '' };
        });
    const fetchPublicAbout = () =>
      resolvedUsername
        ? this.queryAnonymousPublicProfile(resolvedUsername, authToken)
        : Promise.resolve({ status: 0, json: null });

    let settingsRes;
    let publicAbout;
    // One draw, three equally likely orderings. The previous code re-rolled the
    // dice in the `else if` (randomInt(0,2)===0 again), which produced a 50/25/25
    // split instead of 1/3 each and made the "parallel" branch twice as common.
    switch (crypto.randomInt(0, 3)) {
      case 0:
        [settingsRes, publicAbout] = await Promise.all([fetchSettings(), fetchPublicAbout()]);
        break;
      case 1:
        settingsRes = await fetchSettings();
        await humanPause(180, 700);
        publicAbout = await fetchPublicAbout();
        break;
      default:
        publicAbout = await fetchPublicAbout();
        await humanPause(180, 700);
        settingsRes = await fetchSettings();
        break;
    }

    const health = classifyAccountHealthData({
      fallbackUsername: loginUsername,
      meJson,
      meStatus,
      publicAboutJson: publicAbout.json,
      publicAboutStatus: publicAbout.status,
      settingsHtml: settingsRes.text || '',
      settingsFinalUrl: settingsRes.url || '',
    });

    const elapsedMs = this.logger.endStep(
      'step5_account_health',
      health.healthy ? 'active' : health.verdict.toLowerCase(),
      {
        verdict: health.verdict,
        statusLabel: health.statusLabel,
        username: health.username,
        totalKarma: health.totalKarma,
        publicAboutStatus: publicAbout.status,
      }
    );

    this.logger.info(
      'Step5:AccountHealth',
      `Account "${health.username || loginUsername}" (${elapsedMs}ms) -> ${health.statusLabel} (${health.verdict})${
        health.totalKarma !== null ? ` | karma=${health.totalKarma}, age=${health.accountAge || 'n/a'}` : ''
      }`
    );

    if (!health.healthy && this.logger.dumpOnError) {
      this.logger.saveArtifact('step5_restricted_account.json', JSON.stringify({ health, meStatus, publicAboutStatus: publicAbout.status }, null, 2));
    }

    // DISCRIMINATOR (Step 5b): identity-stripped sessions cover BOTH permanent bans and
    // temp password-reset-flagged bans. Split them via the exact RED-FLAG banner the user sees
    // in a real browser ("For your security, we've locked your account after detecting some
    // unusual activity. To keep using Reddit, reset your password.") on authenticated pages,
    // plus the /appeals accessibility check:
    //   - red reset banner / reset redirect -> PASSWORD_RESET_REQUIRED (temp flagged ban)
    //   - appeals form accessible           -> BANNED_SUSPENDED (permanent)
    if (health.statusLabel === 'IDENTITY_STRIPPED_ME_SESSION') {
      try {
        // W17: human gap before the discriminator probes — a real user never opens /appeals
        // 50ms after loading their settings page.
        await new Promise((r) => setTimeout(r, 400 + crypto.randomInt(0, 1100)));
        const [appRes, homeRes] = await Promise.all([
          this.client.get('https://www.reddit.com/appeals', {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: 'https://www.reddit.com/',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
          }),
          this.client.get('https://www.reddit.com/', {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: 'https://www.reddit.com/',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
          }),
        ]);
        const appUrl = String(appRes.url || '');
        const appHtml = String(appRes.text || '');
        const homeHtml = String(homeRes.text || '');
        if (this.logger.dumpAlways) {
          this.logger.saveArtifact('step5b_appeals_probe.html', appHtml);
          this.logger.saveArtifact('step5b_home_probe.html', homeHtml);
        }
        const resetFlagRegex =
          /locked your account after detecting some unusual activity|to keep using reddit, reset your password|locked your account as a security precaution|reset your password to continue|force[-_]?password[-_]?reset/i;
        if (
          /\/(?:resetpassword|password|account\/lock)/i.test(appUrl) ||
          resetFlagRegex.test(appHtml) ||
          resetFlagRegex.test(homeHtml)
        ) {
          health.verdict = 'PASSWORD_RESET_REQUIRED';
          health.statusLabel = 'RESET_FLAGGED_IDENTITY_STRIPPED';
          health.reason =
            'Account is security-flagged (temp password-reset ban): identity-stripped session + Reddit forces the password reset flow';
        } else if (
          /\/appeals(?:[/?#]|$)/i.test(appUrl) ||
          /appeal-form|name="appeal"|why are you appealing|your account has been (?:permanently )?suspended|shreddit-appeal/i.test(
            appHtml
          )
        ) {
          health.verdict = 'BANNED_SUSPENDED';
          health.statusLabel = 'PERMANENT_BAN_IDENTITY_STRIPPED';
          health.reason =
            'Account is permanently banned/suspended: identity-stripped session with the Reddit appeals page accessible';
        }
      } catch (err) {
        this.logger.warn('Step5:AccountHealth', `appeals discriminator probe warning: ${err.message}`);
      }
    }

    return health;
  }

  // ----------------------------------------------------------
  // TOKEN ONLY MODE
  // ----------------------------------------------------------
  async getRecaptchaTokenOnly({ quiet = false } = {}) {
    await this.ensureProfileLease();
    if (!quiet) {
      console.log('='.repeat(72));
      console.log(
        `Reddit reCAPTCHA Token Solver [Mode: ${this.mode} | Brand: ${this.profile.brandId || this.profile.name} (${this.profile.engine || 'chromium'}/${this.profile.os || 'os'}) | TLS: ${this.profile.tlsClientId}]`
      );
      console.log('='.repeat(72));
    }

    let result = null;
    let error = null;
    try {
      await this.solveJsChallenge();
      result = await this.acquireRecaptchaToken();

      if (!quiet) {
        console.log('\n' + '='.repeat(72));
        if (result && result.recaptchaToken) {
          console.log('SUCCESS — reCAPTCHA Enterprise token obtained');
          console.log(`  Browser : ${this.profile.brandId || this.profile.name} (${this.profile.tlsClientId})`);
          console.log(`  Method  : ${result.method}${result.fallbackReason ? ' (fallback)' : ''}`);
          console.log(`  Action  : ${result.action}`);
          console.log(`  Token   : ${this.logger.mask(result.recaptchaToken, 16, 8)}`);
          if (result.ttlSeconds) console.log(`  TTL     : ${result.ttlSeconds}s`);
        } else {
          console.log('FAILED — no reCAPTCHA token returned');
        }
        console.log('='.repeat(72));
      }
      return result;
    } catch (err) {
      error = err;
      this.logger.error('Solver', `Token acquisition failed: ${err.message}`);
      throw err;
    } finally {
      if ((error && this.logger.dumpOnError) || this.logger.dumpAlways) {
        const reportPath = this.logger.writeDiagnosticReport({
          mode: 'token_only',
          solverMode: this.mode,
          brandId: this.profile.brandId || this.profile.name,
          success: Boolean(result?.recaptchaToken),
          error: error?.message || null,
        });
        if (reportPath && !quiet) console.log(`  Diagnostic report: ${reportPath}`);
      }
      await this.close();
    }
  }

  // ----------------------------------------------------------
  // FULL LOGIN MODE (All 4 Steps)
  // ----------------------------------------------------------
  async fullLogin(username, password, { quiet = false } = {}) {
    await this.ensureProfileLease();
    if (!quiet) {
      console.log('='.repeat(72));
      console.log(
        `Reddit Full Login Flow [Mode: ${this.mode} | Brand: ${this.profile.brandId || this.profile.name} (${this.profile.engine || 'chromium'}/${this.profile.os || 'os'}) | TLS: ${this.profile.tlsClientId}]`
      );
      console.log('='.repeat(72));
    }

    let loginResult = null;
    let fatalErr = null;
    try {
      await this.solveJsChallenge();
      const tokenResult = await this.acquireRecaptchaToken();
      const recaptchaToken = tokenResult?.recaptchaToken;
      if (!recaptchaToken) {
        return { success: false, verdict: 'NO_RECAPTCHA_TOKEN', error: 'No reCAPTCHA token' };
      }

      // W7: typing-time simulation — humans need time to type username+password between the
      // captcha token and the login submit. ~70-170ms per char with jitter, capped at 5s.
      const typedChars = String(username || '').length + String(password || '').length;
      const typingMs = Math.min(
        5000,
        Math.floor(typedChars * (70 + randomFloat() * 100) + 200 + crypto.randomInt(0, 800))
      );
      await new Promise((r) => setTimeout(r, typingMs));

      loginResult = await this.login(username, password, recaptchaToken);
      loginResult.recaptchaMethod = tokenResult.method;
      loginResult.browserBrand = this.profile.brandId || this.profile.name;
      loginResult.browserEngine = this.profile.engine || 'chromium';
      loginResult.tlsClientId = this.profile.tlsClientId;
      loginResult.credentialsValid = Boolean(loginResult.success || loginResult.otpRequired);

      // STEP 5: Mandatory Post-Login Account Health Inspection!
      // Prevents suspended, shadowbanned, or password-reset-locked accounts from EVER being marked as valid hits.
      if (loginResult.success) {
        const health = await this.verifyAccountHealth(username);
        loginResult.accountHealth = health;
        if (!health.healthy) {
          loginResult.success = false;
          loginResult.credentialsValid = true;
          loginResult.verdict = health.verdict;
          loginResult.messages = [health.reason, ...(loginResult.messages || [])];
        }
      } else if (
        loginResult.verdict === 'INVALID_CREDENTIALS' &&
        !String(username || '').includes('@') &&
        this.anonymousTokenV2
      ) {
        // Bonus check: if Reddit suspended an account AND invalidated its password, surface BANNED_SUSPENDED
        const pubCheck = await this.queryAnonymousPublicProfile(username);
        if (pubCheck.json?.data?.is_suspended === true) {
          loginResult.verdict = 'BANNED_SUSPENDED';
          loginResult.accountHealth = {
            healthy: false,
            verdict: 'BANNED_SUSPENDED',
            statusLabel: 'SUSPENDED_AND_PASS_INVALID',
            reason: 'Account is permanently suspended on Reddit (and password rejected/reset)',
            username,
          };
          loginResult.messages = [
            'Account is permanently suspended on Reddit (password also rejected/reset)',
            ...(loginResult.messages || []),
          ];
        }
      }

      if (!quiet) {
        console.log('\n' + '='.repeat(72));
        if (loginResult.success) {
          const h = loginResult.accountHealth || {};
          console.log('LOGIN SUCCESS (Clean Active Account Verified)');
          console.log(`  Browser  : ${loginResult.browserBrand} (${loginResult.browserEngine}, TLS=${loginResult.tlsClientId})`);
          console.log(`  Account  : ${h.username || username} (${loginResult.jwtInfo?.sub || h.userId || 'n/a'})`);
          if (h.totalKarma !== null && h.totalKarma !== undefined) {
            console.log(
              `  Stats    : Karma=${h.totalKarma} (post:${h.linkKarma}, comment:${h.commentKarma}) | Age=${h.accountAge || 'n/a'} | EmailVerified=${h.emailVerified}`
            );
          }
          if (loginResult.redirectTarget) console.log(`  Redirect : ${loginResult.redirectTarget}`);
        } else {
          console.log(`LOGIN RESTRICTED / FAILED — ${loginResult.verdict} (HTTP ${loginResult.status})`);
          console.log(`  Browser  : ${loginResult.browserBrand} (${loginResult.browserEngine}, TLS=${loginResult.tlsClientId})`);
          if (loginResult.credentialsValid && !loginResult.otpRequired) {
            console.log('  Auth     : Password matched, BUT account is BANNED / SHADOWBANNED / PASSWORD-RESET LOCKED');
          }
          if (loginResult.messages?.length) {
            console.log(`  Details  : ${loginResult.messages.join(' | ')}`);
          }
          if (loginResult.otpRequired) {
            console.log('  Note     : Account credentials passed, 2FA/OTP verification is required.');
          }
        }
        console.log('='.repeat(72));
      }

      return loginResult;
    } catch (err) {
      fatalErr = err;
      this.logger.error('FullLogin', `Login flow threw error: ${err.message}`);
      throw err;
    } finally {
      if (((!loginResult?.success || fatalErr) && this.logger.dumpOnError) || this.logger.dumpAlways) {
        const reportPath = this.logger.writeDiagnosticReport({
          mode: 'full_login',
          solverMode: this.mode,
          brandId: this.profile.brandId || this.profile.name,
          username,
          success: Boolean(loginResult?.success),
          verdict: loginResult?.verdict || (fatalErr ? 'EXCEPTION' : 'UNKNOWN'),
          error: fatalErr?.message || null,
        });
        if (reportPath && !quiet) console.log(`  Diagnostic report: ${reportPath}`);
      }
      await this.close();
    }
  }

  // ----------------------------------------------------------
  // NON-DESTRUCTIVE LIVE DIAGNOSTICS MODE (`--diagnose`)
  // ----------------------------------------------------------
  async runLiveDiagnostics() {
    await this.ensureProfileLease();
    console.log('='.repeat(72));
    console.log('Reddit Solver v2.2 — Live Protocol & Hybrid Rotation Diagnostics');
    console.log('='.repeat(72));

    const checks = [];
    const record = (name, ok, detail) => {
      checks.push({ name, ok, detail });
      console.log(`  [${ok ? 'PASS' : 'WARN'}] ${name.padEnd(34, ' ')} : ${detail}`);
    };

    try {
      record(
        '.env Configuration',
        ENV_STATUS.exists,
        ENV_STATUS.exists
          ? `Loaded (${ENV_STATUS.loadedKeys.length} vars from ${path.basename(ENV_STATUS.envPath)})`
          : 'No .env file found, using defaults'
      );

      const discovered = discoverEngineBinaries();
      const installedEngines = Object.entries(discovered.engines)
        .filter(([, v]) => v.available)
        .map(([k]) => k);
      record(
        'Hybrid Rotation Engines',
        installedEngines.length > 0,
        installedEngines.length > 0
          ? `[${installedEngines.join(', ')}] (${Object.keys(BROWSER_CATALOG).length} brands, mode=${this.rotationMode})`
          : 'No Playwright engines installed (HTTP Protobuf fallback active)'
      );

      record(
        'Leased Browser & TLS Parity',
        !this.profile.tlsClientIdFallbackUsed,
        `${this.profile.brandId || this.profile.name} -> TLS ${this.profile.tlsClientId} (${this.profile.os || 'os'})`
      );

      const step1 = await this.solveJsChallenge();
      record(
        'Reddit JS Challenge & Cookies',
        Boolean(step1.csrfToken),
        `csrf_token=${this.logger.mask(step1.csrfToken, 6, 4)}, cookies=${Object.keys(step1.cookies).length}`
      );
      record(
        'Shreddit Login Partial Config',
        Boolean(step1.shredditConfig.release && this.action),
        `release=${step1.shredditConfig.release || 'fallback'}, action=${this.action}`
      );

      const liveVer = await this.fetchLiveRecaptchaVersion();
      record('Google reCAPTCHA SDK Version', Boolean(liveVer), `v=${liveVer}`);

      const tokenRes = await this.acquireRecaptchaToken();
      record(
        `reCAPTCHA Token (${tokenRes.method})`,
        Boolean(tokenRes?.recaptchaToken),
        `${this.logger.mask(tokenRes?.recaptchaToken, 12, 6)} in ${tokenRes.durationMs}ms`
      );

      const allCriticalOk = checks
        .filter((c) => c.name !== 'Hybrid Rotation Engines')
        .every((c) => c.ok);

      console.log('='.repeat(72));
      console.log(
        allCriticalOk
          ? 'DIAGNOSTICS RESULT: HEALTHY — All protocol & rotation handshakes succeeded!'
          : 'DIAGNOSTICS RESULT: PARTIAL WARNINGS — Review details above.'
      );
      console.log('='.repeat(72));

      if (this.logger.dumpAlways) {
        this.logger.writeDiagnosticReport({ mode: 'diagnose', checks });
      }
      return { healthy: allCriticalOk, checks };
    } finally {
      await this.close();
    }
  }
}

// ============================================================
// UNIT & REGRESSION TEST SUITE (`--test`)
// ============================================================

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testProtobufBuilder() {
  console.log('--- [1/8] Protobuf Builder Test ---');
  const payload = buildReloadPayload({
    initialToken: '03AFcWeA_EXAMPLE_TOKEN',
    sessionHash: -328692234,
    anchorMs: 20000,
    executeMs: 30000,
  });
  assert(payload.length > 100, 'Payload should be > 100 bytes');
  assert(payload[0] === 0x0a, `Expected first byte 0x0a, got 0x${payload[0].toString(16)}`);
  assert(
    payload.includes(Buffer.from('v1/web/login_with_password', 'utf-8')),
    'Payload must encode action v1/web/login_with_password'
  );
  console.log(`  Payload size: ${payload.length} bytes, first byte: 0x${payload[0].toString(16)} -> OK\n`);
}

async function testTelemetry() {
  console.log('--- [2/8] Telemetry & Stealth Generators Test ---');
  const f20 = generateField20();
  const f22 = generateField22();
  assert(f20.startsWith('tb'), 'Field 20 must start with "tb"');
  const telemetry = JSON.parse(Buffer.from(f20.slice(2), 'base64').toString('utf-8'));
  assert(Array.isArray(telemetry) && telemetry.length === 5, 'Field 20 must decode to 5-element array');

  const f22buf = Buffer.from(f22, 'base64');
  assert(f22buf.length === 1150, `Expected Field 22 length 1150, got ${f22buf.length}`);

  // Regression test for BUG-04 (previously threw RangeError / BigInt TypeError)
  for (let i = 0; i < 25; i++) {
    const devices = generateRandomDevice();
    assert(devices.length >= 2 && devices[0].width >= 1280 && devices[0].width <= 3840, 'Valid screen width');
    const shadow = generateShadow();
    assert(typeof shadow === 'string' && shadow.length > 40, 'Valid shadow string');
  }
  console.log(`  Field 20 (${f20.length} chars), Field 22 (${f22buf.length}B), Device/Shadow x25 -> OK\n`);
}

async function testResponseParser() {
  console.log('--- [3/8] reCAPTCHA Reload Response Parser Test ---');
  const mockResponse = `)]}'\n["rresp","0cAFcWeA_MOCK_TOKEN_12345",null,120,null,null,null,null,"extra",null,null,null,"cookie_val",null,"tokenA","tokenB",1]`;
  const parsed = parseReloadResponse(mockResponse);
  assert(parsed.recaptchaToken === '0cAFcWeA_MOCK_TOKEN_12345', 'Token mismatch');
  assert(parsed.ttlSeconds === 120, 'TTL mismatch');
  assert(parsed.successFlag === 1, 'Success flag mismatch');
  console.log(`  Token: ${parsed.recaptchaToken}, TTL: ${parsed.ttlSeconds}s -> OK\n`);
}

async function testUrlBuilder() {
  console.log('--- [4/8] URL Builder & Origin Padding Test ---');
  const co = encodeOrigin('https://www.reddit.com:443');
  // Regression test for BUG-10: 26-byte string must retain trailing `.` padding
  assert(co === 'aHR0cHM6Ly93d3cucmVkZGl0LmNvbTo0NDM.', `Expected trailing dot padding, got ${co}`);
  const decoded = Buffer.from(co.replace(/\./g, '='), 'base64').toString('utf-8');
  assert(decoded === 'https://www.reddit.com:443', `Decoded mismatch: ${decoded}`);
  const url = buildAnchorUrl({ cb: 'bngsder83qo5' });
  assert(url.includes('co=aHR0cHM6Ly93d3cucmVkZGl0LmNvbTo0NDM.'), 'Anchor URL missing padded co');

  // Regression test for BUG-16: HTTP/2 headers MUST NOT contain Connection: keep-alive
  const h2Headers = buildBrowserHeaders(BROWSER_PROFILES[0], { http1: false });
  assert(!('Connection' in h2Headers), 'HTTP/2 headers must omit Connection header');
  const h1Headers = buildBrowserHeaders(BROWSER_PROFILES[0], { http1: true });
  assert(h1Headers.Connection === 'keep-alive', 'HTTP/1.1 headers should keep Connection: keep-alive');
  console.log(`  co=${co} -> decoded="${decoded}", HTTP/2 header guard -> OK\n`);
}

async function testJsChallengeParser() {
  console.log('--- [5/8] Reddit JS Challenge Parser (`jsc_token` & `token`) Test ---');
  const modernHtml = `
    <script>document.addEventListener("DOMContentLoaded",async function(){var e=document.forms[0],n=(await(async e=>e+e)("2cd35e1b8be47cad"));e.elements.namedItem("solution").value=n,e.requestSubmit()});</script>
    <form hidden method="GET" action="/login/">
      <input type="hidden" name="solution" />
      <input type="hidden" name="js_challenge" value="1"/>
      <input type="hidden" name="jsc_token" value="abc123def456"/>
      <input type="hidden" name="jsc_orig_r" value=""/>
    </form>`;
  const parsedModern = parseRedditJsChallenge(modernHtml);
  assert(parsedModern.isChallenge === true, 'Should detect modern jsc_token challenge');
  assert(parsedModern.tokenField === 'jsc_token', 'Should identify jsc_token field');
  assert(parsedModern.solution === '2cd35e1b8be47cad2cd35e1b8be47cad', 'Should double inline hex value');
  assert(parsedModern.solutionUrl.includes('jsc_token=abc123def456'), 'Solution URL must include jsc_token');

  const legacyHtml = `
    <script>await(async e=>e+e)("aa11bb22")</script>
    <form action="/login/"><input name="token" value="legacy999"/><input name="js_challenge" value="1"/></form>`;
  const parsedLegacy = parseRedditJsChallenge(legacyHtml);
  assert(parsedLegacy.isChallenge === true && parsedLegacy.tokenField === 'token', 'Should support legacy token');
  console.log(`  Modern jsc_token & legacy token parsing -> OK\n`);
}

async function testShredditConfigExtractor() {
  console.log('--- [6/8] Shreddit Config & Partial Extractor Test ---');
  const sampleHtml = `
    <shreddit-app release="2026-10-28T22:30Z~2c40efc06" correlation-id="corr-1"></shreddit-app>
    <auth-flow-login captcha-site-key="6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ" captcha-action="v1/web/login_with_password">
      <faceplate-form id="login" action="/svc/shreddit/account/login"></faceplate-form>
    </auth-flow-login>`;
  const cfg = extractShredditPageConfig(sampleHtml);
  assert(cfg.release === '2026-10-28T22:30Z~2c40efc06', 'Release mismatch');
  assert(cfg.captchaAction === 'v1/web/login_with_password', 'Captcha action mismatch');
  assert(cfg.siteKey === '6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ', 'Site key mismatch');
  console.log(`  release="${cfg.release}", action="${cfg.captchaAction}" -> OK\n`);
}

async function testLoginResponseClassifier() {
  console.log('--- [7/8] Login Response Classifier & JWT Verifier Test ---');
  const makeJwt = (sub) =>
    [
      Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub, iss: 'https://www.reddit.com' })).toString('base64url'),
      'sig',
    ].join('.');

  // Anonymous HTTP 200 with Faceplate error alert MUST NOT report success!
  const falsePositiveCase = classifyLoginResponse({
    status: 200,
    headers: { 'content-type': 'text/vnd.reddit.partial+html' },
    text: '<faceplate-alert message="Invalid username or password."></faceplate-alert>',
    cookies: { token_v2: makeJwt('loid') },
  });
  assert(falsePositiveCase.authenticated === false, 'HTTP 200 error partial must NOT be marked authenticated');
  assert(falsePositiveCase.category === 'INVALID_CREDENTIALS', `Expected INVALID_CREDENTIALS, got ${falsePositiveCase.category}`);

  // Authenticated user JWT (`sub: "t2_abc123"`) MUST report success
  const authCase = classifyLoginResponse({
    status: 200,
    headers: { 'content-type': 'text/vnd.reddit.partial+html' },
    text: '<faceplate-redirect href="/"></faceplate-redirect>',
    cookies: { token_v2: makeJwt('t2_abc123'), reddit_session: 'sess_xyz' },
  });
  assert(authCase.authenticated === true && authCase.category === 'AUTHENTICATED', 'Valid login should be AUTHENTICATED');

  // 2FA OTP prompt detection
  const otpCase = classifyLoginResponse({
    status: 200,
    headers: { 'content-type': 'text/vnd.reddit.partial+html' },
    text: '<faceplate-tabpanel pageindex="2"></faceplate-tabpanel>',
    cookies: { token_v2: makeJwt('loid') },
  });
  assert(otpCase.authenticated === false && otpCase.category === 'OTP_REQUIRED', 'Should detect OTP_REQUIRED');
  console.log('  False-positive HTTP 200 guard, JWT t2_* check & OTP detection -> OK\n');
}

async function testRateLimiterAndMasking() {
  console.log('--- [8/8] Bounded Rate Limiter & Secret Masking Test ---');
  // Regression test for BUG-05 (previously computed up to 50,000,000,000 ms!)
  const limiter = new JitterRateLimiter({ minMs: 20, maxMs: 50, enabled: true });
  assert(limiter.computeWaitMs() === 0, 'First request should have 0ms wait');
  await limiter.wait();
  for (let i = 0; i < 50; i++) {
    const w = limiter.computeWaitMs(limiter.lastRequestAt);
    assert(w >= 20 && w <= 50, `Wait ${w}ms out of bounds [20, 50]`);
  }

  const masked = maskSecret('03AFcWeA_SUPER_SECRET_TOKEN_VALUE_987654');
  assert(!masked.includes('SUPER_SECRET'), 'Mask must hide interior of secret');
  assert(masked.includes('sha256='), 'Mask should include short sha256 fingerprint');
  console.log(`  Rate limiter strictly bounded [20..50ms], mask="${masked}" -> OK\n`);
}

async function testAccountHealthAndBanClassifier() {
  console.log('--- [9/9] Step 5 Account Health, Ban, Shadowban & Password-Reset Classifier Test ---');

  // 1. Clean Active Account -> healthy: true, verdict: AUTHENTICATED
  const cleanRes = classifyAccountHealthData({
    fallbackUsername: 'clean_user',
    meStatus: 200,
    meJson: {
      name: 'CleanUser99',
      id: 'abc123',
      is_suspended: false,
      force_password_reset: false,
      password_set: true,
      link_karma: 250,
      comment_karma: 1200,
      total_karma: 1450,
      created_utc: Math.floor(Date.now() / 1000) - 86400 * 800,
      has_verified_email: true,
    },
    publicAboutStatus: 200,
    publicAboutJson: { kind: 't2', data: { name: 'CleanUser99', id: 'abc123' } },
    settingsHtml: '<shreddit-app user-logged-in="true"></shreddit-app>',
    settingsFinalUrl: 'https://www.reddit.com/settings/account',
  });
  assert(cleanRes.healthy === true && cleanRes.verdict === 'AUTHENTICATED', 'Clean active account must be healthy');
  assert(cleanRes.totalKarma === 1450 && cleanRes.username === 'CleanUser99', 'Should extract karma and canonical username');

  // 2. Permanently Banned / Suspended Account (`me.is_suspended === true`) -> BANNED_SUSPENDED
  const permBan = classifyAccountHealthData({
    fallbackUsername: 'banned_acc',
    meStatus: 200,
    meJson: { name: 'BannedAcc', id: 'ban01', is_suspended: true, suspension_expiration_utc: null, password_set: true },
    publicAboutStatus: 200,
    publicAboutJson: { kind: 't2', data: { name: 'BannedAcc', is_suspended: true } },
  });
  assert(permBan.healthy === false && permBan.verdict === 'BANNED_SUSPENDED', 'Permanent ban must NOT pass as healthy');

  // 3. Temporarily Banned Account (`suspension_expiration_utc` in future) -> BANNED_TEMP
  const futureUtc = Math.floor(Date.now() / 1000) + 86400 * 5;
  const tempBan = classifyAccountHealthData({
    fallbackUsername: 'temp_ban',
    meStatus: 200,
    meJson: { name: 'TempBanUser', id: 'tmp01', is_suspended: true, suspension_expiration_utc: futureUtc, password_set: true },
  });
  assert(tempBan.healthy === false && tempBan.verdict === 'BANNED_TEMP', 'Temporary ban must return BANNED_TEMP');

  // 4. Shadowbanned Account (logged in OK, `is_suspended: false`, BUT public `/about` returns HTTP 404!) -> SHADOWBANNED
  const shadowBan = classifyAccountHealthData({
    fallbackUsername: 'shadow_acc',
    meStatus: 200,
    meJson: { name: 'ShadowAcc', id: 'shd01', is_suspended: false, force_password_reset: false, password_set: true },
    publicAboutStatus: 404,
    publicAboutJson: { error: 404, message: 'Not Found' },
  });
  assert(shadowBan.healthy === false && shadowBan.verdict === 'SHADOWBANNED', 'Shadowban 404 must return SHADOWBANNED');

  // 5. Password Reset Required via `me.force_password_reset === true` -> PASSWORD_RESET_REQUIRED
  const forceReset = classifyAccountHealthData({
    fallbackUsername: 'locked_acc',
    meStatus: 200,
    meJson: { name: 'LockedAcc', id: 'lck01', is_suspended: false, force_password_reset: true, password_set: true },
    publicAboutStatus: 200,
  });
  assert(forceReset.healthy === false && forceReset.verdict === 'PASSWORD_RESET_REQUIRED', 'force_password_reset must return PASSWORD_RESET_REQUIRED');

  // 6. Password Reset / Security Lock Banner on `/settings/account` -> PASSWORD_RESET_REQUIRED
  const bannerLock = classifyAccountHealthData({
    fallbackUsername: 'banner_lock',
    meStatus: 200,
    meJson: { name: 'BannerLock', id: 'lck02', is_suspended: false, force_password_reset: false, password_set: true },
    publicAboutStatus: 200,
    settingsHtml: "<div>We've locked your account as a security precaution. Please reset your password to continue.</div>",
    settingsFinalUrl: 'https://www.reddit.com/settings/account',
  });
  assert(bannerLock.healthy === false && bannerLock.verdict === 'PASSWORD_RESET_REQUIRED', 'Security lock banner must return PASSWORD_RESET_REQUIRED');

  // 7. Step 4 `classifyLoginResponse`: HTTP 202 OTP + `/resetpassword` redirect guard
  const otp202 = classifyLoginResponse({ status: 202, headers: {}, text: '{}', cookies: {} });
  assert(otp202.authenticated === false && otp202.category === 'OTP_REQUIRED', 'HTTP 202 must be OTP_REQUIRED');
  const resetRedir = classifyLoginResponse({
    status: 200,
    headers: {},
    text: '<faceplate-redirect href="/resetpassword"></faceplate-redirect>',
    cookies: {},
  });
  assert(resetRedir.authenticated === false && resetRedir.category === 'PASSWORD_RESET_REQUIRED', '/resetpassword redirect must NOT be AUTHENTICATED');

  console.log('  Clean Active vs Permanent Ban / Temp Ban / Shadowban / Password Reset Lock -> OK\n');
}

async function runAllUnitTests() {
  console.log('='.repeat(68));
  console.log('Running Reddit Solver Unit & Regression Test Suite...');
  console.log('='.repeat(68) + '\n');

  await testProtobufBuilder();
  await testTelemetry();
  await testResponseParser();
  await testUrlBuilder();
  await testJsChallengeParser();
  await testShredditConfigExtractor();
  await testLoginResponseClassifier();
  await testRateLimiterAndMasking();
  await testAccountHealthAndBanClassifier();

  console.log('='.repeat(68));
  console.log('ALL 9 TEST SUITES PASSED!');
  console.log('='.repeat(68));
}

// ============================================================
// CLI ARGUMENT PARSER & ENTRYPOINT
// ============================================================

function parseCliArgs(argv) {
  const opts = {
    test: false,
    diagnose: false,
    verifyRotation: null,
    help: false,
    login: null,
    mode: process.env.SOLVER_MODE || 'auto',
    rotationMode: process.env.ROTATION_MODE || 'hybrid',
    brand: process.env.PREFERRED_BRAND || null,
    headless: undefined,
    proxy: process.env.PROXY_URL || null,
    level: null,
    unmasked: false,
    dumpAlways: false,
    dumpDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--test') opts.test = true;
    else if (arg === '--diagnose') opts.diagnose = true;
    else if (arg === '--headed' || arg === '--show-browser') opts.headless = false;
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--verify-rotation') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        opts.verifyRotation = Math.max(1, Number(next) || 6);
        i += 1;
      } else {
        opts.verifyRotation = 6;
      }
    } else if (arg === '--rotation-mode' && argv[i + 1]) opts.rotationMode = argv[++i];
    else if (arg === '--brand' && argv[i + 1]) opts.brand = argv[++i];
    else if (arg === '--debug') opts.level = opts.level || 'debug';
    else if (arg === '--trace') opts.level = 'trace';
    else if (arg === '--quiet') opts.level = 'error';
    else if (arg === '--debug-unmasked') opts.unmasked = true;
    else if (arg === '--dump') opts.dumpAlways = true;
    else if (arg === '--dump-dir' && argv[i + 1]) opts.dumpDir = argv[++i];
    else if (arg === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (arg === '--proxy' && argv[i + 1]) opts.proxy = argv[++i];
    else if (arg === '--login') {
      opts.login = {
        username: argv[i + 1] || '',
        password: argv[i + 2] || '',
      };
      i += 2;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Reddit Solver v2.2 — Hybrid Multi-Browser Rotation CLI Reference
================================================================
Commands:
  node reddit_solver.js --test                          Run unit & regression tests
  node reddit_solver.js --diagnose [--debug]            Run live Reddit + Hybrid Pool health check
  node reddit_solver.js --verify-rotation [N]           Verify N concurrent live browsers + Reddit WAF (default N=6)
  node reddit_solver.js [--mode auto|browser|http]      Acquire reCAPTCHA Enterprise token only
  node reddit_solver.js --login <user> <pass> [flags]   Execute full 4-step Reddit login flow

Rotation & Solver Flags:
  --rotation-mode <mode>       hybrid (default) | single-engine | multi-engine
  --brand <brandId>            Force brand: chrome | edge | opera | brave | vivaldi |
                               ungoogled_chromium | firefox | camoufox | safari
  --mode <auto|browser|http>   Token solver mode (default: auto)
  --proxy <url>                Proxy URL, e.g. http://user:pass@host:port

Debug Flags:
  --debug                      Structured debug logging + HTTP trace + failure artifacts
  --trace                      Full trace logging (headers, body excerpts, browser events)
  --debug-unmasked             Print full tokens/cookies in debug logs (passwords stay redacted)
  --dump                       Always write HTML/JSON artifacts to ./debug_artifacts/<run_id>
  --dump-dir <dir>             Custom output directory for debug artifacts
  --help, -h                   Show this help text
`);
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.test) {
    await runAllUnitTests();
    return;
  }

  const logger = new DebugLogger({
    level: cli.level,
    unmasked: cli.unmasked,
    dumpAlways: cli.dumpAlways,
    dumpDir: cli.dumpDir,
  });

  logger.debug('Bootstrap', 'Environment & CLI initialized', {
    envFile: ENV_STATUS.exists ? ENV_STATUS.envPath : 'none',
    envLoadedKeys: ENV_STATUS.loadedKeys,
    siteKeyPrefix: SITE_KEY.slice(0, 16) + '...',
    mode: cli.mode,
    rotationMode: cli.rotationMode,
    preferredBrand: cli.brand || 'auto-rotate',
    proxy: maskProxyUrl(cli.proxy),
    logLevel: logger.levelName,
  });

  // BUG-13 FIXED: Always pair initTLS() with destroyTLS() in finally so worker threads exit cleanly
  ensureWindowsTlsDllReady();
  const tlsAsset = getTlsClientAssetInfo();
  if (!tlsAsset.ok) {
    logger.warn(
      'TLS',
      `node-tls-client binary missing (${tlsAsset.tempPath}). The first run downloads ~15MB from GitHub; ` +
        'without network access it exits silently. Use --mode browser, or copy the file from another machine.'
    );
  }
  await initTLS();
  try {
    if (cli.verifyRotation !== null) {
      const workerPool = new RotationWorkerPool({
        rotationMode: cli.rotationMode,
        solverMode: cli.mode,
        concurrency: cli.verifyRotation,
        headless: cli.headless,
        proxies: cli.proxy ? [cli.proxy] : [],
        isRotatingGatewayProxy: Boolean(cli.proxy),
        logger,
      });
      try {
        const report = await workerPool.verifyLiveRotation({
          count: cli.verifyRotation,
          checkRedditLive: true,
          printTable: true,
        });
        if (!report.ok) process.exitCode = 1;
      } finally {
        await workerPool.shutdown();
      }
      return;
    }

    const solver = new RedditSolver({
      proxy: cli.proxy,
      mode: cli.mode,
      rotationMode: cli.rotationMode,
      preferredBrand: cli.brand,
      headless: cli.headless,
      logger,
    });

    if (cli.diagnose) {
      const diag = await solver.runLiveDiagnostics();
      if (!diag.healthy) process.exitCode = 1;
      return;
    }

    if (cli.login) {
      if (!cli.login.username || !cli.login.password) {
        throw new Error('Usage: node reddit_solver.js --login <username> <password> [--debug]');
      }
      const res = await solver.fullLogin(cli.login.username, cli.login.password);
      if (!res.success) process.exitCode = 1;
      return;
    }

    await solver.getRecaptchaTokenOnly();
  } finally {
    await destroyTLS().catch(() => {});
  }
}

module.exports = {
  RedditSolver,
  ensureWindowsTlsDllReady,
  getTlsClientAssetInfo,
  RotationWorkerPool,
  EnginePoolManager,
  ProfileLeaseManager,
  selectBrowserProfile,
  TlsHttpClient,
  NativeHttpClient,
  ProtobufWriter,
  DebugLogger,
  JitterRateLimiter,
  loadDotEnv,
  maskSecret,
  generateRandomDevice,
  generateShadow,
  generateField20,
  generateField22,
  buildReloadPayload,
  buildAnchorUrl,
  buildReloadUrl,
  encodeOrigin,
  extractAnchorToken,
  parseAnchorInit,
  extractSessionHash,
  extractInitParams,
  parseReloadResponse,
  parseRedditJsChallenge,
  isHumanityBlockPage,
  buildBrowserHeaders,
  extractShredditPageConfig,
  inspectRedditJwt,
  classifyLoginResponse,
  classifyAccountHealthData,
  formatAccountAge,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n[FATAL] ${err.message}`);
    if (process.env.DEBUG === '1' || process.argv.includes('--debug') || process.argv.includes('--trace')) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}
