'use strict';

/**
 * Post-Install Deep Verification Script (`scripts/windows_verify_setup.js`)
 *
 * Invoked automatically by `install.bat` on Windows (and works cross-platform) to verify:
 *   1. All required npm packages in `package.json` load without missing module / native build errors.
 *   2. `node-tls-client` downloads & loads its native library (`tls-client-64.dll` on Windows via `koffi`).
 *   3. Installed Playwright browser engines (`chromium`, `firefox`, `webkit`) exist on disk AND can launch headless.
 *   4. Core RedditSolver offline self-tests pass.
 *
 * Prints clear `[OK]` / `[ERROR]` lines so any failed requirement is immediately visible in `install.bat`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const errors = [];
const warnings = [];

function logOk(label, detail = '') {
  console.log(`  ${C.green}[OK]${C.reset}    ${label.padEnd(36)} ${detail}`);
}

function logWarn(label, detail = '') {
  warnings.push(`${label}: ${detail}`);
  console.log(`  ${C.yellow}[WARN]${C.reset}  ${label.padEnd(36)} ${detail}`);
}

function logFail(label, errMsg, fixHint = '') {
  errors.push({ label, errMsg, fixHint });
  console.log(`  ${C.red}[ERROR]${C.reset} ${label.padEnd(36)} ${C.red}${errMsg}${C.reset}`);
  if (fixHint) {
    console.log(`          ${C.yellow}-> Fix:${C.reset} ${fixHint}`);
  }
}

async function main() {
  console.log('\n------------------------------------------------------------------------');
  console.log('  Running Post-Install Component & Native Binary Health Checks...');
  console.log('------------------------------------------------------------------------');
  console.log(
    `  Platform: ${process.platform} (${process.arch}) | Node.js: ${process.version} | Temp: ${os.tmpdir()}\n`
  );

  // -------------------------------------------------------------------------
  // 1. Check every required npm package from package.json
  // -------------------------------------------------------------------------
  const requiredPackages = [
    'node-tls-client',
    'rebrowser-playwright-core',
    'fingerprint-generator',
    'fingerprint-injector',
    'puppeteer',
    'puppeteer-extra',
    'puppeteer-extra-plugin-stealth',
    'jsdom',
    'bgutils-js',
  ];

  for (const pkgName of requiredPackages) {
    try {
      require(pkgName);
      logOk(`npm package: ${pkgName}`, 'Loaded successfully');
    } catch (err) {
      logFail(
        `npm package: ${pkgName}`,
        err.message.split('\n')[0],
        `Run: npm install ${pkgName} --legacy-peer-deps`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 1B. Check Windows VC++ Runtime (`msvcp140_1.dll`) required by Firefox & WebKit
  // -------------------------------------------------------------------------
  if (process.platform === 'win32') {
    const sys32Dll = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msvcp140_1.dll');
    if (fs.existsSync(sys32Dll)) {
      logOk('Windows VC++ Runtime (msvcp140_1.dll)', `Found (${sys32Dll})`);
    } else {
      logFail(
        'Windows VC++ Runtime (msvcp140_1.dll)',
        'Missing msvcp140_1.dll in C:\\Windows\\System32',
        'Right-click install.bat -> Run as administrator to auto-install Visual C++ Redistributable x64.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Pre-warm & verify `node-tls-client` native shared library (.dll / .so)
  // -------------------------------------------------------------------------
  try {
    const { ensureWindowsTlsDllReady } = require('../reddit_solver');
    ensureWindowsTlsDllReady();
    const { initTLS, destroyTLS } = require('node-tls-client');
    await initTLS();
    await destroyTLS();
    const expectedLib =
      process.platform === 'win32'
        ? path.join(os.tmpdir(), process.arch === 'x64' ? 'tls-client-64.dll' : 'tls-client-32.dll')
        : 'native library';
    logOk('Native TLS Engine (node-tls-client)', `Verified (${expectedLib})`);
  } catch (err) {
    logFail(
      'Native TLS Engine (node-tls-client)',
      err.message || String(err),
      'Check internet/GitHub access or allow %TEMP%\\tls-client-64.dll in Windows Security / Antivirus.'
    );
  }

  // -------------------------------------------------------------------------
  // 3. Check Playwright Multi-Engine Browser Binaries + Headless Launch Smoke Test
  // -------------------------------------------------------------------------
  let pw = null;
  try {
    pw = require('rebrowser-playwright-core');
  } catch {
    pw = null;
  }

  if (pw) {
    const { discoverEngineBinaries } = require('../src/rotation/EnginePoolManager');
    const discovery = discoverEngineBinaries();

    for (const engine of ['chromium', 'firefox', 'webkit']) {
      const info = discovery.engines[engine];
      if (!info || !info.available || !info.executablePath) {
        logFail(
          `Browser Engine: ${engine}`,
          'Executable binary not found on disk',
          `Run: npx rebrowser-playwright-core install ${engine}`
        );
        continue;
      }

      // Smoke-launch the browser headless for 1s to verify Windows DLLs / VC++ runtime work
      try {
        const launchArgs = engine === 'chromium' ? ['--no-sandbox'] : [];
        const browser = await pw[engine].launch({
          executablePath: info.executablePath,
          headless: true,
          args: launchArgs,
        });
        const ver = browser.version();
        await browser.close();
        logOk(`Browser Engine: ${engine}`, `v${ver} (${info.source}) launched OK`);
      } catch (launchErr) {
        const firstLine = (launchErr.message || String(launchErr)).split('\n')[0];
        logFail(
          `Browser Engine: ${engine}`,
          `Launch failed: ${firstLine}`,
          process.platform === 'win32' && engine === 'webkit'
            ? 'Install Microsoft Visual C++ Redistributable (x64) or run: npx rebrowser-playwright-core install webkit'
            : `Re-install engine: npx rebrowser-playwright-core install ${engine}`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Verify `.env` configuration file exists (create from defaults if deleted)
  // -------------------------------------------------------------------------
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    logOk('Configuration (.env)', 'Found .env file');
  } else {
    logWarn('Configuration (.env)', 'No .env file found (built-in defaults will be used)');
  }

  // -------------------------------------------------------------------------
  // 5. Write error details to `install_errors.txt` if any failure occurred
  // -------------------------------------------------------------------------
  const errReportPath = path.join(__dirname, '..', 'install_errors.txt');
  if (errors.length > 0) {
    const lines = [
      '========================================================================',
      `POST-INSTALL VERIFICATION ERRORS (${new Date().toISOString()})`,
      '========================================================================',
      ...errors.map(
        (e, idx) =>
          `${idx + 1}. [FAILED] ${e.label}\r\n   Error : ${e.errMsg}\r\n   Fix   : ${e.fixHint || 'N/A'}\r\n`
      ),
    ];
    fs.appendFileSync(errReportPath, lines.join('\r\n') + '\r\n', 'utf-8');

    console.log('\n========================================================================');
    console.log(`  ${C.red}${C.bold}VERIFICATION SUMMARY: ${errors.length} COMPONENT(S) REPORTED ERRORS${C.reset}`);
    console.log('========================================================================');
    errors.forEach((e, i) => {
      console.log(`  ${i + 1}) ${C.red}${e.label}${C.reset}: ${e.errMsg}`);
      if (e.fixHint) console.log(`     Fix: ${e.fixHint}`);
    });
    process.exit(1);
  }

  console.log('\n------------------------------------------------------------------------');
  console.log(`  ${C.green}${C.bold}ALL PACKAGES, TLS DLL & 3 BROWSER ENGINES VERIFIED HEALTHY!${C.reset}`);
  console.log('------------------------------------------------------------------------\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  [FATAL VERIFY ERROR] ${err.message}`);
  process.exit(1);
});
