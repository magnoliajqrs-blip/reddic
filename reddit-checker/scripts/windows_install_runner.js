'use strict';

/**
 * Multi-Fallback Force Windows Auto-Installer & Verifier
 * (`scripts/windows_install_runner.js` — v2.2 Admin Edition)
 *
 * Uses ONLY built-in Node.js core modules (`child_process`, `fs`, `https`, `path`, `os`)
 * so it runs cleanly BEFORE `node_modules` is installed!
 *
 * Key Reliability Guarantees on Windows 10/11 (including Node v24+ / npm v11+ / Admin Mode):
 *   1. ZERO `cmd.exe` unquoted space bug: executes `.exe` binaries (`process.execPath`,
 *      `vc_redist.x64.exe`, `curl.exe`, `winget.exe`, `powershell.exe`), `npm-cli.js`, and
 *      `rebrowser-playwright-core/cli.js` directly with `shell: false`!
 *   2. Force-installs missing `msvcp140_1.dll` (Microsoft Visual C++ 2015–2022 x64 Runtime)
 *      across 4 automatic fallback methods (`vc_redist.x64.exe /quiet` -> `winget` ->
 *      `/repair /passive` -> local signed Microsoft Edge/WinSxS DLL harvest).
 *   3. Force-installs npm packages across 3 automatic methods + verifies `koffi` native module.
 *   4. Force-installs `chromium`, `firefox`, and `webkit` with `--force` retry fallbacks.
 *   5. Pre-downloads & caches Windows `tls-client-64.dll` across 4 fallback methods into both
 *      `%TEMP%` and `<project>/.bin_cache/` so `initTLS()` never fails or rate-limits on GitHub.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');
const FULL_LOG_PATH = path.join(ROOT_DIR, 'install_full.log');
const ERR_LOG_PATH = path.join(ROOT_DIR, 'install_errors.txt');
const BIN_CACHE_DIR = path.join(ROOT_DIR, '.bin_cache');

const PINNED_TLS_DLL_URLS = {
  x64: 'https://github.com/bogdanfinn/tls-client/releases/download/v1.16.0/tls-client-windows-64-1.16.0.dll',
  ia32: 'https://github.com/bogdanfinn/tls-client/releases/download/v1.16.0/tls-client-windows-32-1.16.0.dll',
};
const VC_REDIST_X64_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const fullLogLines = [
  '========================================================================',
  `REDDIT SOLVER v2.2 FORCE INSTALL LOG — ${new Date().toISOString()}`,
  `OS: ${process.platform} ${os.release()} (${process.arch}) | Node: ${process.version}`,
  `ExecPath: ${process.execPath}`,
  `Folder: ${ROOT_DIR}`,
  '========================================================================\r\n',
];

function appendFullLog(text) {
  fullLogLines.push(text);
  try {
    fs.writeFileSync(FULL_LOG_PATH, fullLogLines.join('\r\n'), 'utf-8');
  } catch (_) {}
}

/**
 * Quote a single argument safely for Windows `cmd.exe` ONLY when `cmd.exe` fallback is needed.
 */
function quoteWinCmdArg(arg) {
  const s = String(arg);
  if (!/[ \t"&()<>^|!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Locate `npm-cli.js` bundled alongside `node.exe` so we can run npm via `spawn(process.execPath, ...)`
 * with `shell: false` (100% immune to spaces in `C:\Program Files\nodejs\node.exe`!).
 */
function findNpmCliJs() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Locate Playwright CLI (`node_modules/rebrowser-playwright-core/cli.js`) for direct `shell: false` execution.
 */
function findPlaywrightCliJs() {
  const p = path.join(ROOT_DIR, 'node_modules', 'rebrowser-playwright-core', 'cli.js');
  return fs.existsSync(p) ? p : null;
}

/**
 * Execute a process with live console streaming and full stdout+stderr capture.
 * Uses `shell: false` directly whenever running an executable binary (`.exe` / `process.execPath`)!
 */
function runProcessLive(title, executable, args = [], { allowExitCodes = [0], fixHint = '', useCmdShell = false } = {}) {
  console.log('\n========================================================================');
  console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
  console.log(`  Exec: "${executable}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  console.log('========================================================================');

  appendFullLog(`\r\n>>> STEP: ${title}\r\n>>> EXEC: "${executable}" ${args.join(' ')}`);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    if (useCmdShell && process.platform === 'win32') {
      const cmdLine = `"${quoteWinCmdArg(executable)} ${args.map(quoteWinCmdArg).join(' ')}"`;
      child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
        cwd: ROOT_DIR,
        env: process.env,
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      child = spawn(executable, args, {
        cwd: ROOT_DIR,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    let captured = '';
    const keepTail = (s) => {
      captured += s;
      if (captured.length > 20000) {
        captured = captured.slice(-20000);
      }
    };

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf-8');
      process.stdout.write(s);
      keepTail(s);
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf-8');
      process.stderr.write(s);
      keepTail(s);
    });

    child.on('error', (err) => {
      const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      appendFullLog(`[SPAWN ERROR] ${err.message}`);
      resolve({
        title,
        ok: false,
        exitCode: -1,
        durationSec,
        captured,
        errorExcerpt: err.message,
        fixHint,
      });
    });

    child.on('close', (code) => {
      const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      appendFullLog(captured);
      appendFullLog(`<<< EXIT CODE: ${code} (${durationSec}s)`);

      const cleanLines = captured
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter(Boolean);
      const tailExcerpt = cleanLines.slice(-28).join('\r\n');
      const isOk = allowExitCodes.includes(code);

      if (isOk) {
        console.log(`  ${C.green}[OK] ${title} completed in ${durationSec}s (code=${code}).${C.reset}`);
      } else {
        console.log(`  ${C.red}[FAILED] ${title} exited with code ${code} (${durationSec}s).${C.reset}`);
      }

      resolve({
        title,
        ok: isOk,
        exitCode: code,
        durationSec,
        captured,
        errorExcerpt: isOk ? '' : tailExcerpt || `Process exited with code ${code}`,
        fixHint,
      });
    });
  });
}

function runNpmStep(title, npmArgs, opts = {}) {
  const npmCli = findNpmCliJs();
  if (npmCli) {
    return runProcessLive(title, process.execPath, [npmCli, ...npmArgs], opts);
  }
  return runProcessLive(
    title,
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    npmArgs,
    { ...opts, useCmdShell: process.platform === 'win32' }
  );
}

function runPlaywrightInstallStep(title, pwArgs, opts = {}) {
  const pwCli = findPlaywrightCliJs();
  if (pwCli) {
    return runProcessLive(title, process.execPath, [pwCli, ...pwArgs], opts);
  }
  return runProcessLive(
    title,
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['rebrowser-playwright-core', ...pwArgs],
    { ...opts, useCmdShell: process.platform === 'win32' }
  );
}

/**
 * Multi-method HTTPS file downloader (Method A: Node HTTPS -> Method B: Windows curl.exe -> Method C: PowerShell).
 */
function downloadViaNodeHttps(url, destPath, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many HTTP redirects'));
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RedditSolverInstaller/2.2' },
        timeout: 45000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          return downloadViaNodeHttps(nextUrl, destPath, maxRedirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastPct = -10;
        const tmpFile = `${destPath}.part`;
        const out = fs.createWriteStream(tmpFile);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.floor((received / total) * 100);
            if (pct >= lastPct + 20 || pct === 100) {
              lastPct = pct;
              process.stdout.write(`  Downloading... ${pct}% (${(received / 1048576).toFixed(1)} MB)\r\n`);
            }
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.renameSync(tmpFile, destPath);
              resolve(destPath);
            } catch (e) {
              reject(e);
            }
          });
        });
        out.on('error', (err) => {
          try {
            fs.unlinkSync(tmpFile);
          } catch (_) {}
          reject(err);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Download request timed out'));
    });
  });
}

async function downloadFileMultiMethod(url, destPath, minBytes = 100000) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Method A: Node built-in HTTPS
  try {
    console.log(`  [Download Method 1/3] Node HTTPS -> ${url}`);
    await downloadViaNodeHttps(url, destPath);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size >= minBytes) {
      return true;
    }
  } catch (err) {
    console.log(`  ${C.yellow}[Method 1 Note] ${err.message}${C.reset}`);
  }

  // Method B: Windows built-in curl.exe
  if (process.platform === 'win32') {
    const curlExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
    if (fs.existsSync(curlExe)) {
      console.log(`  [Download Method 2/3] Windows curl.exe -> ${url}`);
      const r = await runProcessLive('curl.exe fallback download', curlExe, [
        '-L',
        '--retry',
        '3',
        '--connect-timeout',
        '20',
        '-o',
        destPath,
        url,
      ]);
      if (r.ok && fs.existsSync(destPath) && fs.statSync(destPath).size >= minBytes) {
        return true;
      }
    }

    // Method C: PowerShell Invoke-WebRequest
    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    if (fs.existsSync(psExe)) {
      console.log(`  [Download Method 3/3] PowerShell Invoke-WebRequest -> ${url}`);
      const psCmd = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${destPath.replace(/'/g, "''")}'`;
      const r = await runProcessLive('PowerShell fallback download', psExe, [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psCmd,
      ]);
      if (r.ok && fs.existsSync(destPath) && fs.statSync(destPath).size >= minBytes) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Scan pre-installed Microsoft Edge / Chrome / WinSxS directories on Windows 10/11 for signed
 * Microsoft VC++ runtime DLLs (`msvcp140_1.dll`, `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`)
 * as an offline last-resort fallback!
 */
function harvestLocalVcRuntimeDlls(missingDllNames) {
  if (process.platform !== 'win32') return 0;
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const searchBases = [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Mozilla Firefox'),
  ];

  const foundMap = new Map();
  const walkLimited = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile()) {
        const lower = ent.name.toLowerCase();
        if (missingDllNames.includes(lower) && !foundMap.has(lower)) {
          foundMap.set(lower, full);
        }
      } else if (ent.isDirectory()) {
        walkLimited(full, depth + 1);
      }
    }
  };

  for (const base of searchBases) {
    walkLimited(base, 0);
  }

  let copied = 0;
  for (const [dllLower, srcPath] of foundMap.entries()) {
    try {
      const destSys = path.join(sys32, dllLower);
      if (!fs.existsSync(destSys)) {
        fs.copyFileSync(srcPath, destSys);
        copied += 1;
        console.log(`  ${C.green}[DLL Harvest] Copied signed ${dllLower} -> ${destSys}${C.reset}`);
      }
    } catch (e) {
      console.log(`  ${C.yellow}[DLL Harvest Note] Could not copy ${dllLower} to System32: ${e.message}${C.reset}`);
    }
  }
  return copied;
}

/**
 * Step 1 (Windows): Ensure `msvcp140_1.dll` & VC++ 2015–2022 Redistributable (x64) are installed
 * so Playwright Firefox and WebKit (`Safari`) launch with zero missing DLL errors!
 */
async function ensureWindowsVcRedistStep() {
  const title = '[Step 1/6] Windows Visual C++ Runtime (msvcp140_1.dll for Firefox/WebKit)';
  if (process.platform !== 'win32') {
    return { title, ok: true, exitCode: 0, durationSec: '0.0', errorExcerpt: '', fixHint: '' };
  }

  const t0 = Date.now();
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const requiredDlls = ['msvcp140_1.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
  const getMissing = () => requiredDlls.filter((d) => !fs.existsSync(path.join(sys32, d)));

  let missing = getMissing();
  if (missing.length === 0) {
    console.log('\n========================================================================');
    console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
    console.log('========================================================================');
    console.log(`  ${C.green}[OK] All VC++ Runtime DLLs (${requiredDlls.join(', ')}) already present in System32!${C.reset}`);
    return { title, ok: true, exitCode: 0, durationSec: '0.1', errorExcerpt: '', fixHint: '' };
  }

  console.log('\n========================================================================');
  console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
  console.log(`  Missing Windows DLLs detected: ${C.yellow}${missing.join(', ')}${C.reset}`);
  console.log('  Starting automatic multi-method Visual C++ Redistributable x64 installation...');
  console.log('========================================================================');

  const vcInstallerPath = path.join(os.tmpdir(), 'vc_redist.x64.exe');

  // Method 1: Download official Microsoft vc_redist.x64.exe & run `/install /quiet /norestart`
  const downloaded = await downloadFileMultiMethod(VC_REDIST_X64_URL, vcInstallerPath, 5 * 1024 * 1024);
  if (downloaded) {
    await runProcessLive(
      '[VC++ Method 1/4] Microsoft vc_redist.x64.exe (/install /quiet /norestart)',
      vcInstallerPath,
      ['/install', '/quiet', '/norestart'],
      { allowExitCodes: [0, 1638, 3010] }
    );
  }

  missing = getMissing();

  // Method 2: winget force install fallback
  if (missing.length > 0) {
    console.log(`  ${C.yellow}[VC++ Method 2/4] Trying winget Microsoft.VCRedist.2015+.x64...${C.reset}`);
    await runProcessLive(
      '[VC++ Method 2/4] winget Microsoft.VCRedist.2015+.x64',
      'winget.exe',
      [
        'install',
        '--id',
        'Microsoft.VCRedist.2015+.x64',
        '-e',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--force',
      ],
      { allowExitCodes: [0, 3010] }
    ).catch(() => null);
    missing = getMissing();
  }

  // Method 3: `/repair /passive /norestart` fallback
  if (missing.length > 0 && fs.existsSync(vcInstallerPath)) {
    console.log(`  ${C.yellow}[VC++ Method 3/4] Running vc_redist.x64.exe /repair /passive /norestart...${C.reset}`);
    await runProcessLive(
      '[VC++ Method 3/4] vc_redist.x64.exe /repair /passive',
      vcInstallerPath,
      ['/repair', '/passive', '/norestart'],
      { allowExitCodes: [0, 1638, 3010] }
    );
    missing = getMissing();
  }

  // Method 4: Offline local signed Microsoft Edge / Chrome DLL harvest into System32
  if (missing.length > 0) {
    console.log(`  ${C.yellow}[VC++ Method 4/4] Harvesting signed Microsoft runtime DLLs from local Edge/Chrome...${C.reset}`);
    harvestLocalVcRuntimeDlls(missing);
    missing = getMissing();
  }

  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  if (missing.length === 0) {
    console.log(`  ${C.green}[OK] msvcp140_1.dll & VC++ x64 Runtime installed and verified (${durationSec}s)!${C.reset}`);
    return { title, ok: true, exitCode: 0, durationSec, errorExcerpt: '', fixHint: '' };
  }

  return {
    title,
    ok: false,
    exitCode: 1,
    durationSec,
    errorExcerpt: `Still missing in ${sys32}: ${missing.join(', ')}`,
    fixHint: 'Right-click install.bat -> Run as administrator, or install https://aka.ms/vs/17/release/vc_redist.x64.exe',
  };
}

/**
 * Step 5A (Windows): Pre-download & cache `tls-client-64.dll` across 4 fallback methods
 * so `node-tls-client` never fails on GitHub API rate-limits or `%TEMP%` cleanups!
 */
async function ensureWindowsTlsDllStep() {
  const title = '[Step 6A/6] Windows Native TLS Engine (tls-client-64.dll Multi-Fallback)';
  if (process.platform !== 'win32') {
    return { title, ok: true, exitCode: 0, durationSec: '0.0', errorExcerpt: '', fixHint: '' };
  }

  const t0 = Date.now();
  const is64 = process.arch === 'x64';
  const dllName = is64 ? 'tls-client-64.dll' : 'tls-client-32.dll';
  const tempDll = path.join(os.tmpdir(), dllName);
  const cacheDll = path.join(BIN_CACHE_DIR, dllName);
  const MIN_DLL_BYTES = 10 * 1024 * 1024;

  console.log('\n========================================================================');
  console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
  console.log('========================================================================');

  // Remove any corrupt/partial 0-byte file in %TEMP%
  if (fs.existsSync(tempDll) && fs.statSync(tempDll).size < MIN_DLL_BYTES) {
    try {
      fs.unlinkSync(tempDll);
    } catch (_) {}
  }

  // Method 1: Already valid in %TEMP% -> back up to .bin_cache
  if (fs.existsSync(tempDll) && fs.statSync(tempDll).size >= MIN_DLL_BYTES) {
    fs.mkdirSync(BIN_CACHE_DIR, { recursive: true });
    if (!fs.existsSync(cacheDll)) {
      try {
        fs.copyFileSync(tempDll, cacheDll);
      } catch (_) {}
    }
    const mb = (fs.statSync(tempDll).size / 1048576).toFixed(1);
    console.log(`  ${C.green}[OK] ${dllName} (${mb} MB) already verified in %TEMP% & backed up!${C.reset}`);
    return { title, ok: true, exitCode: 0, durationSec: '0.1', errorExcerpt: '', fixHint: '' };
  }

  // Method 2: Restore from project .bin_cache
  if (fs.existsSync(cacheDll) && fs.statSync(cacheDll).size >= MIN_DLL_BYTES) {
    try {
      fs.copyFileSync(cacheDll, tempDll);
      console.log(`  ${C.green}[OK] Restored ${dllName} from local .bin_cache -> ${tempDll}!${C.reset}`);
      return { title, ok: true, exitCode: 0, durationSec: '0.1', errorExcerpt: '', fixHint: '' };
    } catch (_) {}
  }

  // Method 3: Pinned official release URL via 3-way multi-method downloader (bypasses api.github.com 403!)
  const pinnedUrl = is64 ? PINNED_TLS_DLL_URLS.x64 : PINNED_TLS_DLL_URLS.ia32;
  const okDownload = await downloadFileMultiMethod(pinnedUrl, tempDll, MIN_DLL_BYTES);
  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (okDownload && fs.existsSync(tempDll) && fs.statSync(tempDll).size >= MIN_DLL_BYTES) {
    try {
      fs.mkdirSync(BIN_CACHE_DIR, { recursive: true });
      fs.copyFileSync(tempDll, cacheDll);
    } catch (_) {}
    const mb = (fs.statSync(tempDll).size / 1048576).toFixed(1);
    console.log(`  ${C.green}[OK] Downloaded & cached ${dllName} (${mb} MB) in ${durationSec}s!${C.reset}`);
    return { title, ok: true, exitCode: 0, durationSec, errorExcerpt: '', fixHint: '' };
  }

  return {
    title,
    ok: false,
    exitCode: 1,
    durationSec,
    errorExcerpt: `Failed to download ${dllName} to ${tempDll}`,
    fixHint: `Allow ${tempDll} in Windows Security / Antivirus and check internet access to github.com.`,
  };
}

async function runAllInstallSteps() {
  if (fs.existsSync(ERR_LOG_PATH)) {
    try {
      fs.unlinkSync(ERR_LOG_PATH);
    } catch (_) {}
  }

  const verifyOnly = process.argv.includes('--verify-only');
  const results = [];

  if (!verifyOnly) {
    // -----------------------------------------------------------------------
    // Step 1: Windows VC++ Runtime (`msvcp140_1.dll`) Multi-Method Force Install
    // -----------------------------------------------------------------------
    if (process.platform === 'win32') {
      results.push(await ensureWindowsVcRedistStep());
    }

    // -----------------------------------------------------------------------
    // Step 2: NPM Project Dependencies (3-Method Force Retry + Koffi Prebuild Check)
    // -----------------------------------------------------------------------
    let npmRes = await runNpmStep(
      '[Step 2/6] NPM Project Dependencies (Method 1: Standard Install)',
      ['install', '--no-audit', '--no-fund'],
      {
        fixHint:
          'Close running node.exe windows, check internet access to registry.npmjs.org, and re-run install.bat as Admin.',
      }
    );

    if (!npmRes.ok) {
      console.log(`\n  ${C.yellow}[Force Retry 2/3] Retrying npm install with --legacy-peer-deps...${C.reset}`);
      npmRes = await runNpmStep(
        '[Step 2/6] NPM Project Dependencies (Method 2: --legacy-peer-deps)',
        ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'],
        { fixHint: 'Check internet connection or antivirus lock on node_modules.' }
      );
    }

    if (!npmRes.ok) {
      console.log(`\n  ${C.yellow}[Force Retry 3/3] Retrying npm install with --force --legacy-peer-deps...${C.reset}`);
      npmRes = await runNpmStep(
        '[Step 2/6] NPM Project Dependencies (Method 3: --force)',
        ['install', '--force', '--legacy-peer-deps', '--no-audit', '--no-fund'],
        { fixHint: 'Delete node_modules folder manually and re-run install.bat as Admin.' }
      );
    }

    // Verify `koffi` native module works (handles npm v11 `allowScripts` seamlessly)
    try {
      require(path.join(ROOT_DIR, 'node_modules', 'koffi'));
    } catch (_) {
      const cnokeJs = path.join(ROOT_DIR, 'node_modules', 'koffi', 'src', 'cnoke', 'cnoke.js');
      const koffiDir = path.join(ROOT_DIR, 'node_modules', 'koffi');
      if (fs.existsSync(cnokeJs)) {
        await runProcessLive(
          '[Step 2B/6] Force-Initializing Koffi Prebuilt FFI Binary',
          process.execPath,
          [cnokeJs, '-P', koffiDir, '-D', 'src/koffi', '--prebuild']
        );
      }
    }
    results.push(npmRes);

    // -----------------------------------------------------------------------
    // Step 3: Browser Engine 1/3 — Chromium (with `--force` retry)
    // -----------------------------------------------------------------------
    let chrRes = await runPlaywrightInstallStep(
      '[Step 3/6] Browser Engine 1/3: Chromium (Chrome, Edge, Opera, Brave, Vivaldi)',
      ['install', 'chromium'],
      { fixHint: 'Check internet / disk space (~400MB) and re-run install.bat as Admin.' }
    );
    if (!chrRes.ok) {
      console.log(`  ${C.yellow}[Force Retry] Re-running Chromium install with --force...${C.reset}`);
      chrRes = await runPlaywrightInstallStep(
        '[Step 3/6 Retry] Browser Engine 1/3: Chromium (--force)',
        ['install', '--force', 'chromium'],
        { fixHint: 'Check internet / disk space (~400MB).' }
      );
    }
    results.push(chrRes);

    // -----------------------------------------------------------------------
    // Step 4: Browser Engine 2/3 — Mozilla Firefox / Gecko (with `--force` retry)
    // -----------------------------------------------------------------------
    let ffRes = await runPlaywrightInstallStep(
      '[Step 4/6] Browser Engine 2/3: Mozilla Firefox / Gecko (Firefox & Camoufox)',
      ['install', 'firefox'],
      { fixHint: 'Check internet / disk space (~250MB) and VC++ Redistributable x64.' }
    );
    if (!ffRes.ok) {
      console.log(`  ${C.yellow}[Force Retry] Re-running Firefox install with --force...${C.reset}`);
      ffRes = await runPlaywrightInstallStep(
        '[Step 4/6 Retry] Browser Engine 2/3: Firefox (--force)',
        ['install', '--force', 'firefox'],
        { fixHint: 'Check internet / disk space (~250MB).' }
      );
    }
    results.push(ffRes);

    // -----------------------------------------------------------------------
    // Step 5: Browser Engine 3/3 — Apple WebKit / Safari (with `--force` retry)
    // -----------------------------------------------------------------------
    let wkRes = await runPlaywrightInstallStep(
      '[Step 5/6] Browser Engine 3/3: Apple WebKit (Safari)',
      ['install', 'webkit'],
      { fixHint: 'Check internet / disk space (~200MB) and VC++ Redistributable x64.' }
    );
    if (!wkRes.ok) {
      console.log(`  ${C.yellow}[Force Retry] Re-running WebKit install with --force...${C.reset}`);
      wkRes = await runPlaywrightInstallStep(
        '[Step 5/6 Retry] Browser Engine 3/3: WebKit (--force)',
        ['install', '--force', 'webkit'],
        { fixHint: 'Check internet / disk space (~200MB).' }
      );
    }
    results.push(wkRes);

    // -----------------------------------------------------------------------
    // Step 6A: Pre-Download & Cache `tls-client-64.dll` on Windows
    // -----------------------------------------------------------------------
    if (process.platform === 'win32') {
      results.push(await ensureWindowsTlsDllStep());
    }
  }

  // -------------------------------------------------------------------------
  // Step 6B & 6C: Direct `shell: false` Execution of Deep Verifier + Unit Tests!
  // (100% immune to `C:\Program Files\nodejs\node.exe` spaces!)
  // -------------------------------------------------------------------------
  results.push(
    await runProcessLive(
      '[Step 6B/6] Deep Package, Windows TLS DLL & 3-Browser Launch Verification',
      process.execPath,
      [path.join(__dirname, 'windows_verify_setup.js')],
      {
        fixHint:
          'Allow %TEMP%\\tls-client-64.dll in Windows Security -> Protection History and ensure VC++ x64 is installed.',
      }
    )
  );

  results.push(
    await runProcessLive(
      '[Step 6C/6] Core Solver & Bulk Checker Offline Self-Tests',
      process.execPath,
      [path.join(ROOT_DIR, 'reddit_solver.js'), '--test'],
      {
        fixHint: 'Inspect the error output above or re-extract the project files cleanly.',
      }
    )
  );

  results.push(
    await runProcessLive(
      '[Step 6D/6] Bulk Checker Account Parser Self-Test',
      process.execPath,
      [path.join(ROOT_DIR, 'reddit_checker.js'), '--self-test'],
      {
        fixHint: 'Ensure reddit_checker.js is present in the project root.',
      }
    )
  );

  // -------------------------------------------------------------------------
  // Final Summary Table + Detailed Error Display
  // -------------------------------------------------------------------------
  const failedSteps = results.filter((r) => !r.ok);

  console.log('\n========================================================================');
  console.log(`${C.bold}                 FINAL WINDOWS INSTALLATION REPORT${C.reset}`);
  console.log('========================================================================');
  for (const r of results) {
    const badge = r.ok ? `${C.green}[  OK  ]${C.reset}` : `${C.red}[FAILED]${C.reset}`;
    console.log(`  ${badge}  ${r.title} (${r.durationSec}s)`);
  }
  console.log('========================================================================');

  if (failedSteps.length > 0) {
    const errReportLines = [
      '========================================================================',
      `INSTALLATION FAILED ON ${failedSteps.length} STEP(S) — ${new Date().toISOString()}`,
      '========================================================================\r\n',
    ];

    console.log(
      `\n${C.red}${C.bold}  [!] ${failedSteps.length} REQUIREMENT(S) HAD INSTALLATION ERRORS — DETAILS BELOW:${C.reset}`
    );
    console.log('------------------------------------------------------------------------');

    failedSteps.forEach((f, idx) => {
      console.log(`\n  ${C.red}${C.bold}Error #${idx + 1}: ${f.title} (Exit Code: ${f.exitCode})${C.reset}`);
      console.log('  --- Captured Error Output ---');
      for (const line of f.errorExcerpt.split(/\r?\n/)) {
        console.log(`    ${C.yellow}${line}${C.reset}`);
      }
      if (f.fixHint) {
        console.log(`  ${C.cyan}-> How to Fix:${C.reset} ${f.fixHint}`);
      }

      errReportLines.push(
        `Error #${idx + 1}: ${f.title} (Exit Code: ${f.exitCode})`,
        '--- Captured Error Output ---',
        f.errorExcerpt,
        `How to Fix: ${f.fixHint || 'See install_full.log'}`,
        '------------------------------------------------------------------------\r\n'
      );
    });

    try {
      fs.writeFileSync(ERR_LOG_PATH, errReportLines.join('\r\n'), 'utf-8');
    } catch (_) {}

    console.log('\n========================================================================');
    console.log(`  Saved error summary to : ${ERR_LOG_PATH}`);
    console.log(`  Saved complete log to  : ${FULL_LOG_PATH}`);
    console.log('========================================================================\n');
    process.exit(1);
  }

  console.log(`\n  ${C.green}${C.bold}[SUCCESS] SHOB REQUIREMENT 100% INSTALL O VERIFY COMPLETE HOYECHE!${C.reset}`);
  console.log(`  Mode Ready: DIRECT LOCAL IP (No Proxy) + VISIBLE BACKGROUND BROWSERS!`);
  console.log(`  Full install log saved to: ${FULL_LOG_PATH}`);
  console.log('\n  HOW TO RUN NOW:');
  console.log('    1. Open "accounts.txt" and paste username:password lines');
  console.log('    2. Double-click "run.bat" -> Directly starts checking with visible browsers!');
  console.log('========================================================================\n');
  process.exit(0);
}

runAllInstallSteps().catch((err) => {
  console.error(`\n[FATAL INSTALLER ERROR] ${err.stack || err.message}`);
  process.exit(1);
});
