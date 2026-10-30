'use strict';

/**
 * Phase 3 — Hybrid Multi-Engine & Shared Multi-Context Browser Pool (`EnginePoolManager.js`)
 *
 * Unifies BOTH rotation architectures in a single production pool:
 *
 *   [Architecture A — Method 1: Shared Engine + Isolated Incognito Contexts]
 *     1 shared OS browser process per engine (`chromium`, `firefox`, `webkit`) serves
 *     multiple concurrent workers via completely isolated `BrowserContext`s, each injected
 *     with its own unique brand identity (`Chrome`, `Edge`, `Opera`, `Brave`, `Vivaldi`,
 *     `Ungoogled-Chromium`, `Firefox`, `Camoufox`, `Safari`), OS-matched GPU/Screen,
 *     per-worker Proxy, Cookie jar, LocalStorage, and 64-bit cryptographic Canvas seed.
 *     -> Saves ~65-75% RAM at high concurrency (e.g. 9 browsers across only 3 OS processes).
 *
 *   [Architecture B — Method 2: Multi-Engine Native + Dedicated Open-Source Anti-Detect Binaries]
 *     Simultaneously runs genuine Chromium (Blink/V8), Mozilla Firefox / Camoufox (Gecko/SpiderMonkey),
 *     and Safari / WebKit (WebKit/JavaScriptCore) via `rebrowser-playwright-core`.
 *     When C++ open-source anti-detect binaries (`FINGERPRINT_CHROMIUM_PATH` or `CAMOUFOX_EXECUTABLE_PATH`)
 *     are configured, automatically passes native C++ CLI flags (`--fingerprint=<seed>`,
 *     `--fingerprint-brand=<Brand>`, `--fingerprint-platform=<os>`) per dedicated process.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ENGINE_TYPES } = require('./ProfileCatalog');
const { AsyncMutex, ProfileLeaseManager } = require('./ProfileLeaseManager');

let playwrightCore = null;
try {
  playwrightCore = require('rebrowser-playwright-core');
} catch {
  try {
    playwrightCore = require('playwright-core');
  } catch {
    playwrightCore = null;
  }
}

/**
 * Convert a standard proxy URL (`http://user:pass@host:port` or `socks5://host:port`)
 * into Playwright's `{ server, username, password }` object safely.
 */
function parsePlaywrightProxy(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return undefined;
  const trimmed = proxyUrl.trim();
  if (!trimmed) return undefined;

  const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const u = new URL(normalized);
    const proxyConfig = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) {
      proxyConfig.username = decodeURIComponent(u.username);
    }
    if (u.password) {
      proxyConfig.password = decodeURIComponent(u.password);
    }
    return proxyConfig;
  } catch {
    return { server: trimmed };
  }
}

/**
 * Resolve effective `headless` boolean across Windows/macOS/Linux:
 *   - Explicit boolean (`true` or `false`) is respected, EXCEPT on headless Linux servers
 *     without `$DISPLAY` / `$WAYLAND_DISPLAY` (where launching headed would crash X11 unless `FORCE_HEADED=1`).
 *   - On Windows (`win32`) and macOS (`darwin`), `HEADLESS=false` opens real visible background browser windows!
 */
function resolveEffectiveHeadless(requestedHeadless, env = process.env) {
  let wantHeadless;
  if (typeof requestedHeadless === 'boolean') {
    wantHeadless = requestedHeadless;
  } else if (typeof env.HEADLESS === 'string' && env.HEADLESS.trim() !== '') {
    wantHeadless = !['false', '0', 'no', 'off'].includes(env.HEADLESS.trim().toLowerCase());
  } else {
    // Default on Windows desktop: visible browser window (`false`); headless elsewhere unless configured
    wantHeadless = process.platform !== 'win32';
  }

  if (
    !wantHeadless &&
    process.platform === 'linux' &&
    !env.DISPLAY &&
    !env.WAYLAND_DISPLAY &&
    env.FORCE_HEADED !== '1'
  ) {
    return true;
  }
  return wantHeadless;
}

/**
 * Check whether an executable file path exists on disk.
 */
function executableExists(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * On Windows, if `install.bat` was run as `Administrator` while `run.bat` is run as a standard
 * user (or vice-versa), `%LOCALAPPDATA%\ms-playwright` may live under another `C:\Users\<Name>` profile.
 * Scan `C:\Users\*\AppData\Local\ms-playwright` as a fallback so browsers are always found!
 */
function findWindowsMsPlaywrightFallback(engine) {
  if (process.platform !== 'win32') return null;
  const subPatterns = {
    chromium: { prefix: 'chromium-', rel: path.join('chrome-win', 'chrome.exe'), altRel: path.join('chrome-win64', 'chrome.exe') },
    firefox: { prefix: 'firefox-', rel: path.join('firefox', 'firefox.exe') },
    webkit: { prefix: 'webkit-', rel: 'Playwright.exe' },
  };
  const spec = subPatterns[engine];
  if (!spec) return null;

  const candidateRoots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    candidateRoots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.env.ORIG_LOCALAPPDATA) {
    candidateRoots.push(path.join(process.env.ORIG_LOCALAPPDATA, 'ms-playwright'));
  }
  if (process.env.LOCALAPPDATA) {
    candidateRoots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  }
  try {
    const usersDir = 'C:\\Users';
    if (fs.existsSync(usersDir)) {
      for (const u of fs.readdirSync(usersDir)) {
        candidateRoots.push(path.join(usersDir, u, 'AppData', 'Local', 'ms-playwright'));
      }
    }
  } catch {}

  for (const root of candidateRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const dirs = fs
        .readdirSync(root)
        .filter((d) => d.startsWith(spec.prefix))
        .sort()
        .reverse();
      for (const d of dirs) {
        const p1 = path.join(root, d, spec.rel);
        if (executableExists(p1)) return p1;
        if (spec.altRel) {
          const p2 = path.join(root, d, spec.altRel);
          if (executableExists(p2)) return p2;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Discover installed browser engine binaries & optional open-source anti-detect executables.
 */
function discoverEngineBinaries(overrides = {}) {
  const env = process.env;
  const discovered = {
    playwrightAvailable: Boolean(playwrightCore),
    engines: {
      chromium: { available: false, executablePath: null, source: null },
      firefox: { available: false, executablePath: null, source: null },
      webkit: { available: false, executablePath: null, source: null },
    },
    antiDetectBinaries: {
      fingerprintChromium: null,
      camoufox: null,
    },
  };

  if (!playwrightCore) {
    return discovered;
  }

  // 1. Optional open-source C++ anti-detect binaries (`adryfish/fingerprint-chromium` & `camoufox`)
  const fpChromiumCandidate =
    overrides.fingerprintChromiumPath || env.FINGERPRINT_CHROMIUM_PATH || null;
  if (executableExists(fpChromiumCandidate)) {
    discovered.antiDetectBinaries.fingerprintChromium = fpChromiumCandidate;
  }

  const camoufoxDefault =
    process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || 'C:\\', 'camoufox', 'camoufox.exe')
      : '/usr/bin/camoufox';
  const camoufoxCandidate =
    overrides.camoufoxPath || env.CAMOUFOX_EXECUTABLE_PATH || camoufoxDefault;
  if (executableExists(camoufoxCandidate)) {
    discovered.antiDetectBinaries.camoufox = camoufoxCandidate;
  }

  const winProgFiles = env.PROGRAMFILES || 'C:\\Program Files';
  const winProgFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const winLocalApp = env.LOCALAPPDATA || '';

  // 2. Standard Chromium engine resolution
  const chromiumCandidates = [
    { path: overrides.chromiumPath, source: 'override' },
    { path: env.CHROMIUM_EXECUTABLE_PATH, source: 'env:CHROMIUM_EXECUTABLE_PATH' },
    { path: fpChromiumCandidate, source: 'fingerprint-chromium' },
    {
      path: (() => {
        try {
          return playwrightCore.chromium.executablePath();
        } catch {
          return null;
        }
      })(),
      source: 'rebrowser-playwright-core',
    },
    { path: findWindowsMsPlaywrightFallback('chromium'), source: 'windows-ms-playwright-scan' },
    {
      path: (() => {
        try {
          return require('puppeteer').executablePath();
        } catch {
          return null;
        }
      })(),
      source: 'puppeteer-bundled',
    },
    ...(process.platform === 'win32'
      ? [
          { path: path.join(winProgFiles, 'Google\\Chrome\\Application\\chrome.exe'), source: 'windows-chrome' },
          { path: path.join(winProgFilesX86, 'Google\\Chrome\\Application\\chrome.exe'), source: 'windows-chrome-x86' },
          { path: path.join(winLocalApp, 'Google\\Chrome\\Application\\chrome.exe'), source: 'windows-local-chrome' },
          { path: path.join(winProgFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'), source: 'windows-brave' },
          { path: path.join(winProgFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'), source: 'windows-edge' },
          { path: path.join(winProgFiles, 'Microsoft\\Edge\\Application\\msedge.exe'), source: 'windows-edge' },
        ]
      : [
          { path: '/usr/bin/google-chrome-stable', source: 'system-chrome' },
          { path: '/usr/bin/google-chrome', source: 'system-chrome' },
          { path: '/usr/bin/chromium', source: 'system-chromium' },
          { path: '/usr/bin/chromium-browser', source: 'system-chromium' },
        ]),
  ];

  for (const c of chromiumCandidates) {
    if (executableExists(c.path)) {
      discovered.engines.chromium = {
        available: true,
        executablePath: c.path,
        source: c.source,
      };
      break;
    }
  }

  // 3. Mozilla Firefox / Gecko engine resolution
  const firefoxCandidates = [
    { path: overrides.firefoxPath, source: 'override' },
    { path: env.FIREFOX_EXECUTABLE_PATH, source: 'env:FIREFOX_EXECUTABLE_PATH' },
    {
      path: (() => {
        try {
          return playwrightCore.firefox.executablePath();
        } catch {
          return null;
        }
      })(),
      source: 'rebrowser-playwright-core',
    },
    { path: findWindowsMsPlaywrightFallback('firefox'), source: 'windows-ms-playwright-scan' },
    { path: camoufoxCandidate, source: 'camoufox' },
    ...(process.platform === 'win32'
      ? [
          { path: path.join(winProgFiles, 'Mozilla Firefox\\firefox.exe'), source: 'windows-firefox' },
          { path: path.join(winProgFilesX86, 'Mozilla Firefox\\firefox.exe'), source: 'windows-firefox-x86' },
        ]
      : []),
  ];

  for (const c of firefoxCandidates) {
    if (executableExists(c.path)) {
      discovered.engines.firefox = {
        available: true,
        executablePath: c.path,
        source: c.source,
      };
      break;
    }
  }

  // 4. Apple WebKit / Safari engine resolution
  const webkitCandidates = [
    { path: overrides.webkitPath, source: 'override' },
    { path: env.WEBKIT_EXECUTABLE_PATH, source: 'env:WEBKIT_EXECUTABLE_PATH' },
    {
      path: (() => {
        try {
          return playwrightCore.webkit.executablePath();
        } catch {
          return null;
        }
      })(),
      source: 'rebrowser-playwright-core',
    },
    { path: findWindowsMsPlaywrightFallback('webkit'), source: 'windows-ms-playwright-scan' },
  ];

  for (const c of webkitCandidates) {
    if (executableExists(c.path)) {
      discovered.engines.webkit = {
        available: true,
        executablePath: c.path,
        source: c.source,
      };
      break;
    }
  }

  return discovered;
}

/**
 * Build safe context-level HTTP headers (strictly avoiding navigation-only headers on XHR/fetch).
 */
function buildSafeContextExtraHeaders(profile, http2Headers = {}) {
  const extra = {};

  if (http2Headers['Accept-Language']) {
    extra['Accept-Language'] = http2Headers['Accept-Language'];
  }

  // Only Chromium derivatives send Client-Hints (`sec-ch-ua*`); never attach on Firefox/Safari
  if (profile.engine === ENGINE_TYPES.CHROMIUM && profile.sendsClientHints) {
    if (http2Headers['sec-ch-ua']) extra['sec-ch-ua'] = http2Headers['sec-ch-ua'];
    if (http2Headers['sec-ch-ua-mobile']) extra['sec-ch-ua-mobile'] = http2Headers['sec-ch-ua-mobile'];
    if (http2Headers['sec-ch-ua-platform']) {
      extra['sec-ch-ua-platform'] = http2Headers['sec-ch-ua-platform'];
    }
  }

  return extra;
}

class EnginePoolManager {
  /**
   * @param {object} [options]
   * @param {'single-engine'|'multi-engine'|'hybrid'} [options.mode='hybrid']
   * @param {boolean} [options.headless=true]
   * @param {number} [options.maxContextsPerEngine=50] - Recycle shared browser after N contexts
   * @param {ProfileLeaseManager} [options.leaseManager] - Existing lease manager (or auto-created)
   * @param {string[]} [options.proxies=[]]
   * @param {boolean} [options.isRotatingGatewayProxy=false]
   * @param {object} [options.binaryOverrides={}]
   * @param {object} [options.logger=null]
   */
  constructor({
    mode = process.env.ROTATION_MODE || 'hybrid',
    headless = undefined,
    minimizeWindow = process.env.BROWSER_MINIMIZED === 'true',
    maxContextsPerEngine = Number(process.env.MAX_CONTEXTS_PER_ENGINE || 50),
    leaseManager = null,
    proxies = [],
    isRotatingGatewayProxy = false,
    binaryOverrides = {},
    logger = null,
  } = {}) {
    if (!playwrightCore) {
      throw new Error(
        'rebrowser-playwright-core is required for EnginePoolManager. Run `npm install` first.'
      );
    }

    this.mode = ['single-engine', 'multi-engine', 'hybrid'].includes(mode) ? mode : 'hybrid';
    this.headless = resolveEffectiveHeadless(headless);
    this.minimizeWindow = Boolean(minimizeWindow);
    this.maxContextsPerEngine = Math.max(5, maxContextsPerEngine);
    this.logger = logger;
    this.discovery = discoverEngineBinaries(binaryOverrides);

    // Filter enabled engines to those physically installed on this machine (graceful fallback!)
    const installedEngines = Object.entries(this.discovery.engines)
      .filter(([, info]) => info.available)
      .map(([eng]) => eng);

    if (installedEngines.length === 0) {
      throw new Error(
        'No Playwright/Chromium/Firefox/WebKit browser binaries found on disk. Run `npx rebrowser-playwright-core install`.'
      );
    }

    this.enabledEngines =
      this.mode === 'single-engine'
        ? installedEngines.includes('chromium')
          ? ['chromium']
          : [installedEngines[0]]
        : installedEngines;

    this.leaseManager =
      leaseManager ||
      new ProfileLeaseManager({
        mode: this.mode,
        enabledEngines: this.enabledEngines,
        proxies,
        isRotatingGatewayProxy,
        logger,
      });

    // Synchronize LeaseManager's engine list with discovered binaries
    this.leaseManager.enabledEngines = [...this.enabledEngines];

    // Shared browser instances: engine -> { browser, launchedAt, totalContexts, activeContextIds, executablePath }
    this._sharedEngines = new Map();
    this._engineLocks = {
      chromium: new AsyncMutex(),
      firefox: new AsyncMutex(),
      webkit: new AsyncMutex(),
    };

    // Track active sessions for clean shutdown & telemetry
    this._activeSessions = new Map(); // sessionId -> BrowserSession
    this._dedicatedBrowsers = new Set();

    this._metrics = {
      sharedEngineLaunches: 0,
      dedicatedProcessLaunches: 0,
      sharedEngineRecycles: 0,
      totalSessionsCreated: 0,
      totalSessionsClosed: 0,
      byEngine: { chromium: 0, firefox: 0, webkit: 0 },
      byArchitecture: {
        'shared-engine-context': 0,
        'dedicated-antidetect-process': 0,
      },
    };
  }

  /**
   * Build engine-specific launch options for Playwright (`chromium`, `firefox`, `webkit`).
   */
  _buildLaunchOptions(engine, { executablePath = null, extraArgs = [], proxy = null } = {}) {
    const opts = {
      headless: this.headless,
    };

    if (executablePath) {
      opts.executablePath = executablePath;
    }

    if (proxy) {
      opts.proxy = parsePlaywrightProxy(proxy);
    }

    if (engine === ENGINE_TYPES.CHROMIUM) {
      const visibleWindowArgs = !this.headless
        ? [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--window-position=50,50',
            '--window-size=1120,760',
          ]
        : [];
      // Reddit's edge fingerprints the HTTP/2 connection layer itself (SETTINGS frame order +
      // pseudo-header order), which Chromium's H2 stack never matches a real Chrome build.
      // Forcing HTTP/1.1 removes that signal entirely — documented fix for Reddit's gate.
      const disableHttp2 = process.env.DISABLE_HTTP2 !== '0' ? ['--disable-http2'] : [];
      opts.args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--no-default-browser-check',
        ...disableHttp2,
        ...visibleWindowArgs,
        ...extraArgs,
      ];
    } else if (engine === ENGINE_TYPES.FIREFOX) {
      opts.args = [...extraArgs];
      opts.firefoxUserPrefs = {
        'dom.webdriver.enabled': false,
        'media.peerconnection.enabled': false, // Prevent WebRTC local IP leak
        'privacy.resistFingerprinting': false, // Use our synthesized OS-matched profile instead of Tor generic bucket
        'network.http.spdy.enabled.http2': true,
        // Keep Firefox/Camoufox running at full speed when visible behind CMD / in background on Windows:
        'dom.min_background_timeout_value': 4,
        'dom.timeout.throttling_delay': 0,
        'widget.windows.window_occlusion_tracking.enabled': false,
      };
    } else if (engine === ENGINE_TYPES.WEBKIT) {
      opts.args = [...extraArgs];
    }

    return opts;
  }


  /**
   * Best-effort OS-window minimisation.
   *
   * Chromium has no `--start-minimized` switch (only `--start-maximized`), so the previous
   * flag was a silent no-op and `BROWSER_MINIMIZED=true` never actually minimised anything.
   * We minimise the real window through CDP the moment a page exists; Firefox/WebKit have no
   * CDP endpoint, so for those engines we simply leave the window alone.
   */
  async _minimizeWindowForTargets(browser, engine) {
    if (this.headless || !this.minimizeWindow || engine !== ENGINE_TYPES.CHROMIUM) return;
    if (!browser || typeof browser.newBrowserCDPSession !== 'function') return;
    let cdp = null;
    try {
      cdp = await browser.newBrowserCDPSession();
      const { targetInfos = [] } = await cdp.send('Target.getTargets');
      for (const target of targetInfos) {
        if (target.type !== 'page') continue;
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', {
            targetId: target.targetId,
          });
          await cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'minimized' },
          });
        } catch {
          // The window can disappear between the two calls - nothing to do.
        }
      }
    } catch {
      // CDP window control is Chromium-only and version dependent; never fail a session for it.
    } finally {
      if (cdp) await cdp.detach().catch(() => {});
    }
  }

  /**
   * Determine if this specific lease should launch a dedicated anti-detect process (Method 2 C++ flags)
   * or allocate an isolated context inside a shared engine process (Method 1 + Method 2 pooled).
   */
  _shouldUseDedicatedProcess(profile, forceDedicatedProcess = false) {
    // Strict one-identity-per-browser: every account attempt gets its own OS browser process
    // (own GPU process, own cookie jar, own profile dir), so two accounts can never share a
    // canvas/WebGL/process-level fingerprint. `DEDICATED_BROWSER_PROCESS=0` reverts to the
    // old shared-process pooling on low-RAM machines at the cost of that isolation.
    if (forceDedicatedProcess || process.env.DEDICATED_BROWSER_PROCESS !== '0') return true;

    // If `adryfish/fingerprint-chromium` C++ binary is installed, launch dedicated process
    // so per-lease `--fingerprint=<seed>` and `--fingerprint-brand=<Brand>` C++ flags apply!
    if (
      profile.engine === ENGINE_TYPES.CHROMIUM &&
      this.discovery.antiDetectBinaries.fingerprintChromium
    ) {
      return true;
    }

    // If standalone `camoufox` binary is installed separately from standard Firefox
    if (
      profile.brandId === 'camoufox' &&
      this.discovery.antiDetectBinaries.camoufox &&
      this.discovery.antiDetectBinaries.camoufox !==
        this.discovery.engines.firefox.executablePath
    ) {
      return true;
    }

    return false;
  }

  /**
   * Ensure a shared browser engine (`chromium`, `firefox`, or `webkit`) is running and healthy.
   */
  async _ensureSharedEngine(engine) {
    const mutex = this._engineLocks[engine];
    if (!mutex) {
      throw new Error(`Unsupported browser engine: "${engine}"`);
    }

    return mutex.runExclusive(async () => {
      const existing = this._sharedEngines.get(engine);
      if (existing && existing.browser.isConnected()) {
        // Recycle idle shared engine if it has served >= maxContextsPerEngine
        if (
          existing.totalContexts >= this.maxContextsPerEngine &&
          existing.activeContextIds.size === 0
        ) {
          this.logger?.info(
            'EnginePool',
            `Recycling shared ${engine} process after ${existing.totalContexts} contexts`
          );
          this._sharedEngines.delete(engine);
          this._metrics.sharedEngineRecycles += 1;
          await existing.browser.close().catch(() => {});
        } else {
          return existing;
        }
      }

      const engineInfo = this.discovery.engines[engine];
      if (!engineInfo || !engineInfo.available) {
        throw new Error(`Browser engine "${engine}" is not available on this host`);
      }

      const launchOpts = this._buildLaunchOptions(engine, {
        executablePath: engineInfo.executablePath,
      });

      const t0 = Date.now();
      const browser = await playwrightCore[engine].launch(launchOpts);
      const launchMs = Date.now() - t0;

      const entry = {
        engine,
        browser,
        version: browser.version(),
        executablePath: engineInfo.executablePath,
        source: engineInfo.source,
        launchedAt: Date.now(),
        launchMs,
        totalContexts: 0,
        activeContextIds: new Set(),
      };

      browser.on('disconnected', () => {
        const cur = this._sharedEngines.get(engine);
        if (cur === entry) {
          this._sharedEngines.delete(engine);
        }
      });

      this._sharedEngines.set(engine, entry);
      this._metrics.sharedEngineLaunches += 1;

      this.logger?.info(
        'EnginePool',
        `Launched shared [${engine}] v${entry.version} (${engineInfo.source}) in ${launchMs}ms`
      );

      return entry;
    });
  }

  /**
   * Launch a dedicated browser process for a single worker session (used for C++ anti-detect CLI flags
   * or when `forceDedicatedProcess: true` is passed).
   */
  async _launchDedicatedEngine(lease) {
    const { profile, proxy } = lease;
    const engine = profile.engine;

    let executablePath = this.discovery.engines[engine]?.executablePath || null;
    let extraArgs = [];

    if (
      engine === ENGINE_TYPES.CHROMIUM &&
      this.discovery.antiDetectBinaries.fingerprintChromium
    ) {
      executablePath = this.discovery.antiDetectBinaries.fingerprintChromium;
      extraArgs = [...(profile.fingerprintChromiumArgs || [])];
    } else if (
      profile.brandId === 'camoufox' &&
      this.discovery.antiDetectBinaries.camoufox
    ) {
      executablePath = this.discovery.antiDetectBinaries.camoufox;
    }

    const launchOpts = this._buildLaunchOptions(engine, {
      executablePath,
      extraArgs,
      proxy,
    });

    const browser = await playwrightCore[engine].launch(launchOpts);
    this._dedicatedBrowsers.add(browser);
    this._metrics.dedicatedProcessLaunches += 1;

    browser.on('disconnected', () => {
      this._dedicatedBrowsers.delete(browser);
    });

    return browser;
  }

  /**
   * Acquire a fully configured, zero-collision Browser Session (Lease + Isolated Context + Page + Stealth Init).
   *
   * @param {object} [options]
   * @param {string} [options.workerId='worker-0']
   * @param {string} [options.preferredEngine]
   * @param {string} [options.preferredOs]
   * @param {string} [options.preferredBrand]
   * @param {string} [options.proxyOverride]
   * @param {boolean} [options.forceDedicatedProcess=false]
   * @param {boolean} [options.createPage=true]
   */
  async acquireBrowserSession({
    workerId = 'worker-0',
    preferredEngine = null,
    preferredOs = null,
    preferredBrand = null,
    proxyOverride = null,
    existingLease = null,
    forceDedicatedProcess = false,
    createPage = true,
  } = {}) {
    // Ensure LeaseManager stays synced with currently available engines
    await this.leaseManager.setEnabledEngines(this.enabledEngines);

    const ownsLease = !existingLease;
    const lease =
      existingLease ||
      (await this.leaseManager.acquireLease({
        workerId,
        preferredEngine,
        preferredOs,
        preferredBrand,
        proxyOverride,
      }));

    const { profile, http2Headers, initScript, proxy } = lease;
    const sessionId = `sess_${crypto.randomBytes(6).toString('hex')}`;
    const useDedicated = this._shouldUseDedicatedProcess(profile, forceDedicatedProcess);

    let sharedEntry = null;
    let dedicatedBrowser = null;
    let context = null;

    try {
      let browser;
      if (useDedicated) {
        dedicatedBrowser = await this._launchDedicatedEngine(lease);
        browser = dedicatedBrowser;
      } else {
        sharedEntry = await this._ensureSharedEngine(profile.engine);
        browser = sharedEntry.browser;
      }

      const contextOptions = {
        userAgent: profile.navigator.userAgent,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        viewport: {
          width: profile.screen.width,
          height: profile.screen.availHeight || profile.screen.height,
        },
        screen: {
          width: profile.screen.width,
          height: profile.screen.height,
        },
        deviceScaleFactor: profile.screen.devicePixelRatio || 1,
        colorScheme: 'light',
        extraHTTPHeaders: buildSafeContextExtraHeaders(profile, http2Headers),
      };

      if (proxy && !useDedicated) {
        contextOptions.proxy = parsePlaywrightProxy(proxy);
      }

      context = await browser.newContext(contextOptions);

      // Inject engine-aware brand identity, OS-locked WebGL GPU, oscpu/userAgentData & Canvas seed
      await context.addInitScript(initScript);

      if (sharedEntry) {
        sharedEntry.totalContexts += 1;
        sharedEntry.activeContextIds.add(sessionId);
      }

      const page = createPage ? await context.newPage() : null;
      if (page) {
        await this._minimizeWindowForTargets(browser, profile.engine);
      }
      const architecture = useDedicated
        ? 'dedicated-antidetect-process'
        : 'shared-engine-context';

      this._metrics.totalSessionsCreated += 1;
      this._metrics.byEngine[profile.engine] =
        (this._metrics.byEngine[profile.engine] || 0) + 1;
      this._metrics.byArchitecture[architecture] += 1;

      let closed = false;
      let burned = false;

      const session = {
        sessionId,
        workerId: String(workerId),
        architecture,
        engine: profile.engine,
        brandId: profile.brandId,
        displayName: profile.displayName,
        os: profile.os,
        lease,
        profile,
        tlsSessionOptions: lease.tlsSessionOptions,
        http2Headers: lease.http2Headers,
        solverProfile: lease.solverProfile,
        browser,
        context,
        page,

        /**
         * Retrieve cookies from the isolated BrowserContext (compatible with TlsHttpClient cookie jar).
         */
        async getCookies(urls) {
          return context.cookies(urls);
        },

        /**
         * Seed cookies (e.g. from TlsHttpClient JS challenge) into this isolated BrowserContext.
         */
        async setCookies(cookies) {
          if (!Array.isArray(cookies) || cookies.length === 0) return;
          await context.addCookies(cookies);
        },

        /**
         * Flag this profile's variant for WAF cooldown when closing.
         */
        async markBurned(reason = 'waf_flag') {
          burned = true;
          await this.close({ burnReason: reason });
        },

        /**
         * Idempotent cleanup: closes Page, isolated BrowserContext, dedicated Browser (if any),
         * and releases the ProfileLeaseManager lock so another worker can use the brand.
         */
        close: async ({ burnReason = null } = {}) => {
          if (closed) return;
          closed = true;
          this._activeSessions.delete(sessionId);

          try {
            if (page && !page.isClosed()) {
              await page.close().catch(() => {});
            }
          } finally {
            try {
              if (context) {
                await context.close().catch(() => {});
              }
            } finally {
              if (sharedEntry) {
                sharedEntry.activeContextIds.delete(sessionId);
              }
              if (dedicatedBrowser) {
                this._dedicatedBrowsers.delete(dedicatedBrowser);
                await dedicatedBrowser.close().catch(() => {});
              }
              if (ownsLease) {
                if (burned || burnReason) {
                  await this.leaseManager
                    .markBurned(lease.leaseId, { reason: burnReason || 'waf_flag' })
                    .catch(() => {});
                } else {
                  await this.leaseManager.releaseLease(lease.leaseId).catch(() => {});
                }
              }
              this._metrics.totalSessionsClosed += 1;
            }
          }
        },
      };

      this._activeSessions.set(sessionId, session);
      return session;
    } catch (err) {
      // Rollback any partially allocated resources + release lease lock so pool never deadlocks!
      if (context) {
        await context.close().catch(() => {});
      }
      if (sharedEntry) {
        sharedEntry.activeContextIds.delete(sessionId);
      }
      if (dedicatedBrowser) {
        this._dedicatedBrowsers.delete(dedicatedBrowser);
        await dedicatedBrowser.close().catch(() => {});
      }
      if (ownsLease) {
        await this.leaseManager.releaseLease(lease.leaseId).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Execute `fn(session)` inside an isolated, leased browser session and guarantee `session.close()`.
   */
  async withBrowserSession(options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }
    const session = await this.acquireBrowserSession(options);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  /**
   * Return live diagnostic status of all pooled browser processes, contexts, and leases.
   */
  async getPoolStatus() {
    const leaseStats = await this.leaseManager.getStats();
    const sharedEngines = {};
    for (const [eng, entry] of this._sharedEngines.entries()) {
      sharedEngines[eng] = {
        connected: entry.browser.isConnected(),
        version: entry.version,
        source: entry.source,
        launchMs: entry.launchMs,
        totalContextsServed: entry.totalContexts,
        activeContexts: entry.activeContextIds.size,
      };
    }

    return {
      mode: this.mode,
      headless: this.headless,
      enabledEngines: [...this.enabledEngines],
      antiDetectBinaries: { ...this.discovery.antiDetectBinaries },
      activeSessionCount: this._activeSessions.size,
      sharedEngineProcessCount: this._sharedEngines.size,
      dedicatedProcessCount: this._dedicatedBrowsers.size,
      sharedEngines,
      metrics: {
        ...this._metrics,
        byEngine: { ...this._metrics.byEngine },
        byArchitecture: { ...this._metrics.byArchitecture },
      },
      leaseStats,
    };
  }

  /**
   * Gracefully close all active worker sessions and all pooled browser engine processes.
   */
  async shutdown() {
    const activeSessions = Array.from(this._activeSessions.values());
    await Promise.all(activeSessions.map((s) => s.close().catch(() => {})));

    const sharedEntries = Array.from(this._sharedEngines.values());
    this._sharedEngines.clear();
    await Promise.all(sharedEntries.map((e) => e.browser.close().catch(() => {})));

    const dedicated = Array.from(this._dedicatedBrowsers);
    this._dedicatedBrowsers.clear();
    await Promise.all(dedicated.map((b) => b.close().catch(() => {})));
  }
}

module.exports = {
  parsePlaywrightProxy,
  resolveEffectiveHeadless,
  discoverEngineBinaries,
  buildSafeContextExtraHeaders,
  EnginePoolManager,
};
