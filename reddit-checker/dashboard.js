'use strict';

/**
 * Reddit Checker Live Dashboard (`dashboard.js`)
 *
 * Zero-dependency local web UI for the bulk checker:
 *   - start / stop a run (threads, pacing delay, proxy on/off, headed or headless)
 *   - live log stream (SSE) with per-result classification
 *   - live counters: clean hits, banned, password-reset, 2FA, invalid, errors, CPM, ETA
 *
 * Run:  node dashboard.js            (or `npm run dashboard`)
 * Open: http://127.0.0.1:8787
 *
 * NOTE (v2.5.0): the previous version of this file only contained the state helpers — the HTTP
 * server, the SSE endpoint and the UI were missing, so `node dashboard.js` exited immediately.
 * This is the complete implementation. It binds to loopback by default because it can start a
 * credential-checking run; set DASH_HOST=0.0.0.0 only on a trusted machine/LAN.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Read the version straight from package.json: the dashboard must not pull in the whole solver
// (TLS native lib, Playwright discovery) just to print a number.
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
})();

const ROOT = __dirname;
const PORT = (() => {
  const raw = process.env.DASH_PORT;
  if (raw === undefined || String(raw).trim() === '') return 8787;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8787;
})();
const HOST = process.env.DASH_HOST || '127.0.0.1';

// ── state ────────────────────────────────────────────────────────────────────
const MAX_LOG_LINES = 600;
const RESULT_WINDOW_MS = 10 * 60 * 1000;

let child = null;
let runState = freshRunState();
const logRing = [];
const resultTimes = []; // timestamps only (CPM/ETA) — no unbounded object growth
const counts = { hits: 0, banned: 0, reset: 0, twofa: 0, invalid: 0, errors: 0 };
const sseClients = new Set();

function freshRunState() {
  return {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    done: 0,
    total: 0,
    exitCode: null,
    args: '',
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Parse one checker output line into either a log line or a classified result. */
function classifyLine(line) {
  const clean = String(line).replace(ANSI_RE, '').replace(/\r$/, '');
  const m = clean.match(/\[(\d+)\/(\d+)\]\s*\[([^\]]+)\]/);
  if (!m) return { type: 'log', text: clean };

  const tag = m[3].trim().toUpperCase();
  let bucket = 'errors';
  if (tag.includes('HIT')) bucket = 'hits';
  else if (tag.includes('BANNED') || tag.includes('SHADOW')) bucket = 'banned';
  else if (tag.includes('RESET') || tag.includes('LOCK')) bucket = 'reset';
  else if (tag.includes('2FA')) bucket = 'twofa';
  else if (tag.includes('INVALID')) bucket = 'invalid';
  else if (tag.includes('WAF') || tag.includes('GATE')) bucket = 'errors';

  return {
    type: 'result',
    index: Number(m[1]),
    total: Number(m[2]),
    bucket,
    text: clean,
  };
}

function pushLog(text) {
  logRing.push({ t: Date.now(), text });
  if (logRing.length > MAX_LOG_LINES) logRing.splice(0, logRing.length - MAX_LOG_LINES);
}

function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function statsSnapshot() {
  const now = Date.now();
  const cutoff = now - 60000;
  while (resultTimes.length && resultTimes[0] < now - RESULT_WINDOW_MS) resultTimes.shift();
  const cpm = resultTimes.filter((t) => t >= cutoff).length;
  const elapsed = runState.startedAt ? (now - runState.startedAt) / 1000 : 0;
  const rate = runState.done > 0 && elapsed > 0 ? runState.done / (elapsed / 60) : 0;
  const remaining = Math.max(0, runState.total - runState.done);
  return {
    version: VERSION,
    running: runState.running,
    done: runState.done,
    total: runState.total,
    cpm,
    ratePerMin: Number(rate.toFixed(2)),
    etaSec: rate > 0 && remaining > 0 ? Math.round((remaining / rate) * 60) : null,
    elapsedSec: Math.round(elapsed),
    exitCode: runState.exitCode,
    counts: { ...counts },
    host: HOST,
    port: PORT,
  };
}

function handleLine(line) {
  if (!line.trim()) return;
  const parsed = classifyLine(line);
  if (parsed.type === 'result') {
    runState.done = Math.max(runState.done, parsed.index);
    runState.total = Math.max(runState.total, parsed.total);
    counts[parsed.bucket] = (counts[parsed.bucket] || 0) + 1;
    resultTimes.push(Date.now());
    sseSend('result', parsed);
    sseSend('stats', statsSnapshot());
    pushLog(parsed.text);
    return;
  }
  pushLog(parsed.text);
  sseSend('log', { text: parsed.text, t: Date.now() });
}

// ── run control ──────────────────────────────────────────────────────────────
function startRun(opts = {}) {
  if (child) return { ok: false, error: 'A run is already in progress.' };

  const threads = Math.min(12, Math.max(1, Number(opts.threads) || 2));
  const delaySec = Math.max(0, Number(opts.delaySec) || 0);
  const useProxy = Boolean(opts.proxy);
  const headed = Boolean(opts.headed);
  const mode = ['auto', 'browser', 'http'].includes(opts.mode) ? opts.mode : null;

  let proxyFile = path.join(ROOT, 'proxies.txt');
  if (!useProxy) {
    proxyFile = path.join(ROOT, 'results', 'proxies_disabled.txt');
    fs.mkdirSync(path.dirname(proxyFile), { recursive: true });
    fs.writeFileSync(proxyFile, '# proxy disabled via dashboard\n', 'utf-8');
  }

  const env = { ...process.env };
  if (delaySec > 0) {
    const minMs = Math.round(delaySec * 1000 * 0.7);
    const maxMs = Math.round(delaySec * 1000 * 1.3);
    env.LOGIN_PACE_MIN_MS = String(minMs);
    env.LOGIN_PACE_MAX_MS = String(maxMs);
    env.LOGIN_PACE_PROXY_MIN_MS = String(minMs);
    env.LOGIN_PACE_PROXY_MAX_MS = String(maxMs);
  }

  // Basename only: the dashboard must not be able to point the checker at an arbitrary path
  // (path traversal in a local API is still a bug).
  const accountsFile = path.join(ROOT, path.basename(String(opts.accounts || 'accounts.txt')));
  if (!fs.existsSync(accountsFile)) {
    return { ok: false, error: `accounts file not found: ${path.basename(accountsFile)}` };
  }

  const args = [
    'reddit_checker.js',
    headed ? '--headed' : '--headless',
    '-t',
    String(threads),
    '-p',
    proxyFile,
    '-a',
    accountsFile,
  ];
  if (mode) args.push('--mode', mode);

  runState = { ...freshRunState(), running: true, startedAt: Date.now(), args: args.join(' ') };
  for (const k of Object.keys(counts)) counts[k] = 0;
  resultTimes.length = 0;
  logRing.length = 0;

  try {
    child = spawn(process.execPath, args, { cwd: ROOT, env });
  } catch (err) {
    runState.running = false;
    child = null;
    return { ok: false, error: `spawn failed: ${err.message}` };
  }

  child.on('error', (err) => {
    handleLine(`[dashboard] child process error: ${err.message}`);
    runState.running = false;
    child = null;
    sseSend('status', { running: false, error: err.message });
  });

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (d) => {
    // Split chunks: the TLS library and the help banners write several lines per chunk and the
    // UI must keep them readable.
    for (const line of d.toString().split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      pushLog(`[stderr] ${text}`);
      sseSend('log', { text: `[stderr] ${text}`, t: Date.now() });
    }
  });
  child.on('exit', (code) => {
    if (buf.trim()) handleLine(buf);
    buf = '';
    runState.running = false;
    runState.finishedAt = Date.now();
    runState.exitCode = code;
    child = null;
    sseSend('status', { running: false, exitCode: code });
    sseSend('stats', statsSnapshot());
  });

  sseSend('status', { running: true, args: runState.args });
  sseSend('stats', statsSnapshot());
  return { ok: true, args: runState.args };
}

function stopRun() {
  if (!child) return { ok: true, note: 'nothing running' };
  const proc = child;
  try {
    proc.kill('SIGTERM'); // the checker closes browsers on SIGTERM (v2.5.0)
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 5000).unref?.();
  return { ok: true };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) data = data.slice(0, limit);
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reddit Checker Dashboard</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;
        --green:#3fb950;--red:#f85149;--amber:#d29922;--cyan:#58a6ff;--mag:#bc8cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
  header{display:flex;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
  header h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
  .pill.on{color:var(--green);border-color:#238636}
  main{display:grid;grid-template-columns:300px 1fr;gap:14px;padding:14px 18px}
  @media(max-width:820px){main{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
  label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
  input[type=number],select{width:100%;padding:7px 9px;background:#0d1117;color:var(--txt);
    border:1px solid var(--line);border-radius:7px;font:inherit}
  .row{display:flex;gap:8px;align-items:center}
  button{flex:1;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:#21262d;
    color:var(--txt);font:inherit;font-weight:600;cursor:pointer}
  button.primary{background:#238636;border-color:#2ea043}
  button.danger{background:#b62324;border-color:#da3633}
  button:disabled{opacity:.45;cursor:not-allowed}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .stat{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px}
  .stat b{display:block;font-size:19px;line-height:1.2}
  .stat span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
  #log{height:56vh;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;
    white-space:pre-wrap;word-break:break-word;padding:8px;background:#010409;border-radius:8px;border:1px solid var(--line)}
  .hit{color:var(--green)}.ban{color:var(--red)}.rst{color:var(--amber)}
  .tfa{color:var(--cyan)}.inv{color:var(--red)}.err{color:var(--dim)}.waf{color:var(--amber)}
  .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .hdr h2{font-size:13px;margin:0;color:var(--dim);text-transform:uppercase;letter-spacing:.6px}
  small{color:var(--dim)}
  .btns{display:flex;gap:8px;margin-top:12px}
</style></head>
<body>
<header>
  <h1>Reddit Checker</h1><span class="pill" id="ver">—</span>
  <span class="pill" id="status">idle</span><span class="pill" id="url">—</span>
  <span style="flex:1"></span>
  <span class="pill" id="eta">—</span>
</header>
<main>
  <section>
    <div class="card">
      <label>Threads (1–12)</label>
      <input id="threads" type="number" min="1" max="12" value="4">
      <label>Delay between accounts (seconds)</label>
      <input id="delay" type="number" min="0" max="120" value="3">
      <label>Proxies</label>
      <select id="proxy"><option value="0">Direct local IP (recommended for home)</option><option value="1">Use proxies.txt</option></select>
      <label>Solver mode</label>
      <select id="mode"><option value="auto">auto (browser + TLS fallback)</option><option value="browser">browser only</option><option value="http">http only</option></select>
      <label>Browser window</label>
      <select id="headed"><option value="1">Visible (best for the bot gate)</option><option value="0">Hidden / headless</option></select>
      <div class="btns">
        <button class="primary" id="start">Start</button>
        <button class="danger" id="stop" disabled>Stop</button>
      </div>
      <p><small>Reads accounts.txt / proxies.txt from the project folder. Results are written to hits.txt, banned.txt, … as usual.</small></p>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="stats">
        <div class="stat"><b id="c-hits" class="hit">0</b><span>hits</span></div>
        <div class="stat"><b id="c-banned" class="ban">0</b><span>banned</span></div>
        <div class="stat"><b id="c-reset" class="rst">0</b><span>reset/lock</span></div>
        <div class="stat"><b id="c-twofa" class="tfa">0</b><span>2fa</span></div>
        <div class="stat"><b id="c-invalid" class="inv">0</b><span>invalid</span></div>
        <div class="stat"><b id="c-errors" class="waf">0</b><span>errors/waf</span></div>
      </div>
      <div class="stats" style="margin-top:8px">
        <div class="stat"><b id="c-done">0</b><span>checked</span></div>
        <div class="stat"><b id="c-cpm">0</b><span>per min</span></div>
        <div class="stat"><b id="c-elapsed">0s</b><span>elapsed</span></div>
      </div>
    </div>
  </section>
  <section class="card">
    <div class="hdr"><h2>Live log</h2><small id="conn">connecting…</small></div>
    <div id="log"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const log = $('log');
const colors = {hits:'hit',banned:'ban',reset:'rst',twofa:'tfa',invalid:'inv',errors:'err'};
function addLine(text, bucket) {
  const div = document.createElement('div');
  div.textContent = text;
  if (bucket) div.className = colors[bucket] || '';
  if (/WAF\\/GATE|Prove your humanity/i.test(text)) div.className = 'waf';
  log.appendChild(div);
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (nearBottom) log.scrollTop = log.scrollHeight;
  while (log.childElementCount > 800) log.removeChild(log.firstChild);
}
function fmtSec(s){ if(s==null) return '—'; if(s<60) return s+'s'; const m=Math.floor(s/60); return m+'m '+(s%60)+'s'; }
function applyStats(s) {
  $('ver').textContent = 'v' + s.version;
  $('url').textContent = s.host + ':' + s.port;
  $('status').textContent = s.running ? 'running' : (s.exitCode === null ? 'idle' : 'finished (' + s.exitCode + ')');
  $('status').className = 'pill' + (s.running ? ' on' : '');
  $('c-hits').textContent = s.counts.hits;
  $('c-banned').textContent = s.counts.banned;
  $('c-reset').textContent = s.counts.reset;
  $('c-twofa').textContent = s.counts.twofa;
  $('c-invalid').textContent = s.counts.invalid;
  $('c-errors').textContent = s.counts.errors;
  $('c-done').textContent = s.done + (s.total ? '/' + s.total : '');
  $('c-cpm').textContent = s.cpm;
  $('c-elapsed').textContent = fmtSec(s.elapsedSec);
  $('eta').textContent = s.etaSec != null ? 'ETA ' + fmtSec(s.etaSec) : '—';
  $('start').disabled = s.running;
  $('stop').disabled = !s.running;
}
async function post(path, body) {
  const res = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
  return res.json().catch(() => ({}));
}
$('start').onclick = async () => {
  const r = await post('/api/start', {
    threads: Number($('threads').value), delaySec: Number($('delay').value),
    proxy: $('proxy').value === '1', headed: $('headed').value === '1', mode: $('mode').value,
  });
  if (r.error) addLine('[dashboard] ' + r.error);
};
$('stop').onclick = () => post('/api/stop', {});
const es = new EventSource('/api/events');
es.addEventListener('open', () => { $('conn').textContent = 'connected'; });
es.addEventListener('error', () => { $('conn').textContent = 'reconnecting…'; });
es.addEventListener('log', (e) => addLine(JSON.parse(e.data).text));
es.addEventListener('result', (e) => { const d = JSON.parse(e.data); addLine(d.text, d.bucket); });
es.addEventListener('stats', (e) => applyStats(JSON.parse(e.data)));
es.addEventListener('status', () => {});
fetch('/api/state').then(r => r.json()).then(d => {
  (d.log || []).forEach(l => addLine(l.text));
  applyStats(d.stats);
});
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, { stats: statsSnapshot(), log: logRing.slice(-300), args: runState.args });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    sseClients.add(res);
    try {
      res.write(`event: stats\ndata: ${JSON.stringify(statsSnapshot())}\n\n`);
    } catch {
      /* client vanished */
    }
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    const body = await readBody(req);
    const out = startRun(body);
    return json(res, out.ok ? 200 : 409, out);
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    return json(res, 200, stopRun());
  }

  json(res, 404, { error: 'not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[dashboard] port ${PORT} is already in use. Set DASH_PORT to a free port (e.g. DASH_PORT=8788).`
    );
  } else {
    console.error(`[dashboard] server error: ${err.message}`);
  }
  process.exitCode = 1;
});

function startDashboard({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const actual = server.address();
      const actualPort = actual && typeof actual === 'object' ? actual.port : port;
      const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
      console.log(`\n  Reddit Checker Dashboard v${VERSION}`);
      console.log(`  → http://${shown}:${actualPort}   (host=${host}, port=${actualPort})`);
      console.log('  Ctrl+C stops the dashboard and any running checker.\n');
      resolve({ port: actualPort, host });
      });
  });
}

function shutdown() {
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = {
  classifyLine,
  statsSnapshot,
  startRun,
  stopRun,
  server,
  startDashboard,
  shutdown,
};

// Only bind the port when this file is the entrypoint — `require('./dashboard')` in a test must
// not hijack a port.
if (require.main === module) {
  startDashboard().catch((err) => {
    console.error(`[dashboard] failed to start: ${err.message}`);
    process.exitCode = 1;
  });
}
