#!/usr/bin/env node
'use strict';

/**
 * browser_smoke.js — "why won't the browser start?" in one command.
 *
 *   node scripts/browser_smoke.js                 # what is on disk, and what to do next
 *   node scripts/browser_smoke.js --launch        # + launch each engine headless and probe it
 *   node scripts/browser_smoke.js --launch --headed --engine chromium
 *   node scripts/browser_smoke.js --json          # machine-readable
 *
 * Exit codes: 0 = discovery ok (launch optional/skipped), 1 = a requested launch failed.
 *
 * This never touches reddit.com, accounts or proxies — it opens about:blank and reads the
 * fingerprint the browser would present, so you can tell "browser broken" apart from
 * "Reddit/DNS/proxy broken".
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  discoverEngineBinaries,
  resolveEffectiveHeadless,
} = require(path.join(ROOT, 'src/rotation/EnginePoolManager.js'));

let playwright = null;
try {
  playwright = require('rebrowser-playwright-core');
} catch {
  try {
    playwright = require('playwright-core');
  } catch {
    playwright = null;
  }
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};
const noColor = process.env.NO_COLOR === '1' || process.argv.includes('--no-color');
const paint = (c, s) => (noColor ? s : `${c}${s}${C.reset}`);

function parseArgs(argv) {
  const opts = { launch: false, headed: false, engine: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--launch') opts.launch = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--engine') opts.engine = (argv[i + 1] || '').toLowerCase();
  }
  return opts;
}

/** Playwright's bundled download cache paths, for the "install it like this" hint. */
function cachePaths() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return [process.env.PLAYWRIGHT_BROWSERS_PATH];
  }
  if (process.platform === 'win32') {
    const bases = [process.env.LOCALAPPDATA, process.env.ORIG_LOCALAPPDATA].filter(Boolean);
    return bases.map((b) => path.join(b, 'ms-playwright'));
  }
  if (process.platform === 'darwin') {
    return [path.join(process.env.HOME || '~', 'Library', 'Caches', 'ms-playwright')];
  }
  return [path.join(process.env.HOME || '~', '.cache', 'ms-playwright')];
}

function dirSummary() {
  return cachePaths().map((root) => {
    let entries = [];
    try {
      entries = fs.readdirSync(root).filter((d) => !d.startsWith('.'));
    } catch {
      /* missing cache dir is a normal first-run state */
    }
    return { root, exists: fs.existsSync(root), entries };
  });
}

/** Read the fingerprint the launched browser actually presents. */
async function probePage(page) {
  return page.evaluate(() => {
    const gl = (() => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!ctx) return { vendor: null, renderer: null };
        const ext = ctx.getExtension('WEBGL_debug_renderer_info');
        return {
          vendor: ext ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) : ctx.getParameter(ctx.VENDOR),
          renderer: ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER),
        };
      } catch {
        return { vendor: null, renderer: null };
      }
    })();
    const canvasHash = (() => {
      try {
        const c = document.createElement('canvas');
        c.width = 220;
        c.height = 40;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#123456';
        ctx.fillRect(0, 0, 220, 40);
        ctx.fillStyle = '#fedcba';
        ctx.fillText('browser-smoke-🦊', 2, 4);
        const data = c.toDataURL();
        let h = 0x811c9dc5;
        for (let i = 0; i < data.length; i += 1) {
          h ^= data.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      } catch {
        return null;
      }
    })();
    return {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      platform: navigator.platform,
      languages: (navigator.languages || []).join(','),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      plugins: navigator.plugins ? navigator.plugins.length : null,
      chromeObject: typeof window.chrome,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${screen.width}x${screen.height} @${window.devicePixelRatio}x`,
      viewport: `${innerWidth}x${innerHeight}`,
      webgl: gl,
      canvasHash,
    };
  });
}

async function launchProbe(engine, info, { headed }) {
  const headless = resolveEffectiveHeadless(headed ? false : true);
  const t0 = Date.now();
  const browser = await playwright[engine].launch({
    headless,
    executablePath: info.executablePath,
    args:
      engine === 'chromium'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
        : [],
  });
  const launchMs = Date.now() - t0;
  try {
    const version = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('about:blank');
    const probe = await probePage(page);
    await context.close();
    return { ok: true, engine, version, launchMs, headless, probe };
  } finally {
    await browser.close().catch(() => {});
  }
}

function printDiscovery(discovery, opts) {
  console.log(paint(C.bold, '\nBrowser discovery'));
  console.log(paint(C.dim, '─'.repeat(78)));
  console.log(
    `${'engine'.padEnd(10)}${'status'.padEnd(12)}${'source'.padEnd(30)}path`
  );
  for (const [engine, info] of Object.entries(discovery.engines)) {
    const status = info.available ? paint(C.green, 'found'.padEnd(12)) : paint(C.red, 'missing'.padEnd(12));
    const src = (info.source || '-').padEnd(30);
    console.log(`${engine.padEnd(10)}${status}${src}${info.executablePath || paint(C.dim, '-')}`);
  }

  const anti = discovery.antiDetectBinaries || {};
  console.log(
    paint(C.dim, `\nanti-detect binaries: fingerprint-chromium=${anti.fingerprintChromium ? 'yes' : 'no'}  camoufox=${anti.camoufox ? 'yes' : 'no'}`)
  );
  console.log(paint(C.dim, `effective headless: ${resolveEffectiveHeadless(opts.headed ? false : undefined)}  (platform=${process.platform}, DISPLAY=${process.env.DISPLAY || '-'})`));

  // The http/BotGuard-free path needs a native TLS library in the OS temp dir; when it is
  // missing, node-tls-client downloads it and hard-exits the process on failure. Report it here
  // so "browser is fine but the checker dies instantly" has an obvious cause.
  try {
    const { getTlsClientAssetInfo } = require(path.join(ROOT, 'reddit_solver.js'));
    const tls = getTlsClientAssetInfo();
    console.log(paint(C.bold, '\nTLS client (http path)'));
    console.log(paint(C.dim, '─'.repeat(78)));
    if (tls.ok) {
      console.log(`${paint(C.green, 'present')}  ${tls.tempPath}`);
    } else {
      console.log(`${paint(C.yellow, 'missing')}  ${tls.tempPath}`);
      console.log(paint(C.dim, '         first `node reddit_solver.js --diagnose` downloads ~15MB; offline hosts must copy it in,'));
      console.log(paint(C.dim, '         and `--mode browser` works without it entirely.'));
    }
  } catch {
    console.log(paint(C.dim, '\nTLS client: reddit_solver.js could not be loaded (npm ci first)'));
  }

  console.log(paint(C.bold, '\nPlaywright cache'));
  console.log(paint(C.dim, '─'.repeat(78)));
  for (const c of dirSummary()) {
    if (!c.exists) {
      console.log(`${paint(C.red, 'missing')}  ${c.root}`);
      continue;
    }
    console.log(`${paint(C.green, 'present')}  ${c.root}  ${paint(C.dim, `(${c.entries.length} entries)`)}`);
    if (c.entries.length) console.log(paint(C.dim, `         ${c.entries.slice(0, 8).join(', ')}${c.entries.length > 8 ? ', …' : ''}`));
  }
}

function printNextSteps(discovery) {
  const missing = Object.entries(discovery.engines)
    .filter(([, info]) => !info.available)
    .map(([e]) => e);
  if (missing.length === 0) {
    console.log(paint(C.green, '\nAll three engines are on disk. Run with --launch to prove they start.\n'));
    return;
  }
  console.log(paint(C.bold, `\nNext step — ${missing.join(', ')} not installed`));
  console.log(paint(C.dim, '─'.repeat(78)));
  console.log('  npm run setup:browsers');
  console.log('    # equivalent to: npx rebrowser-playwright-core install chromium firefox webkit');
  console.log('  # fresh Linux VPS also needs the shared libraries (GTK, fonts, ...):');
  console.log('    sudo npx rebrowser-playwright-core install-deps chromium firefox webkit\n');
  console.log(
    paint(C.dim, '  Behind a proxy / offline? Set PLAYWRIGHT_BROWSERS_PATH to a folder that already')
  );
  console.log(paint(C.dim, '  contains the ms-playwright cache, or point CHROMIUM_EXECUTABLE_PATH at a system'));
  console.log(paint(C.dim, '  Chrome/Edge/Chromium — discovery accepts both.\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const discovery = discoverEngineBinaries();

  if (opts.json) {
    const out = { platform: process.platform, node: process.version, playwright: Boolean(playwright), discovery };
    if (opts.launch) {
      out.launches = [];
      for (const [engine, info] of Object.entries(discovery.engines)) {
        if (!info.available || (opts.engine && opts.engine !== engine)) continue;
        out.launches.push(await launchProbe(engine, info, opts).catch((e) => ({ ok: false, engine, error: e.message })));
      }
    }
    console.log(JSON.stringify(out, null, 2));
    return opts.launch && out.launches?.some((l) => !l.ok) ? 1 : 0;
  }

  printDiscovery(discovery, opts);
  console.log(paint(C.dim, `\nnode ${process.version} · playwright ${playwright ? 'loaded' : paint(C.red, 'NOT loaded')} · ${process.platform}`));

  if (!playwright) {
    console.log(paint(C.red, '\nrebrowser-playwright-core could not be required. Run `npm ci` first.\n'));
    return 1;
  }

  printNextSteps(discovery);

  if (!opts.launch) {
    console.log(paint(C.dim, 'Discovery only. Add --launch to start each engine and read its fingerprint.\n'));
    return 0;
  }

  console.log(paint(C.bold, '\nLaunch probe'));
  console.log(paint(C.dim, '─'.repeat(78)));
  let failures = 0;
  for (const [engine, info] of Object.entries(discovery.engines)) {
    if (!info.available) {
      console.log(`${engine.padEnd(10)}${paint(C.yellow, 'skip')}  not installed`);
      continue;
    }
    if (opts.engine && opts.engine !== engine) continue;
    try {
      const r = await launchProbe(engine, info, opts);
      console.log(`${engine.padEnd(10)}${paint(C.green, 'ok')}    v${r.version} · launched in ${r.launchMs}ms · headless=${r.headless}`);
      console.log(paint(C.dim, `           UA: ${r.probe.userAgent}`));
      console.log(paint(C.dim, `           webdriver=${r.probe.webdriver} · chrome=${r.probe.chromeObject} · tz=${r.probe.timezone} · langs=${r.probe.languages}`));
      console.log(paint(C.dim, `           screen=${r.probe.screen} · viewport=${r.probe.viewport} · cores=${r.probe.hardwareConcurrency} · mem=${r.probe.deviceMemory}`));
      console.log(paint(C.dim, `           webgl=${r.probe.webgl.vendor} / ${r.probe.webgl.renderer}`));
      console.log(paint(C.dim, `           canvas=${r.probe.canvasHash} · plugins=${r.probe.plugins}`));
      if (r.probe.webdriver === true) {
        console.log(paint(C.yellow, '           ⚠ navigator.webdriver is true — stealth init script did not apply (expected for plain smoke launch)'));
      }
    } catch (err) {
      failures += 1;
      console.log(`${engine.padEnd(10)}${paint(C.red, 'FAIL')}  ${err.message.split('\n')[0]}`);
      if (/Executable doesn't exist|ENOENT/i.test(err.message)) {
        console.log(paint(C.dim, '           → binary path is stale; re-run `npm run setup:browsers`'));
      }
      if (/Missing X server|X11|DISPLAY/i.test(err.message)) {
        console.log(paint(C.dim, '           → no display for a headed launch; use headless (omit --headed) or set FORCE_HEADED=1 on a real desktop'));
      }
      if (/lib\w+\.so|error while loading shared libraries/i.test(err.message)) {
        console.log(paint(C.dim, '           → missing system libraries; run `sudo npx rebrowser-playwright-core install-deps`'));
      }
    }
  }
  console.log('');
  return failures ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(paint(C.red, `browser_smoke crashed: ${err.stack || err.message}`));
    process.exit(1);
  });
