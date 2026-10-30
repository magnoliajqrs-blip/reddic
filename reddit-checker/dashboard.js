'use strict';
/**
 * 🎛️ Reddit Checker Live Dashboard (`dashboard.js`)
 * Zero-dependency local web UI: threads / proxy / worker-delay controls, live log boxes,
 * real-time CPM. Spawns `reddit_checker.js` as a child process (core untouched).
 *   Run:  node dashboard.js   then open  http://127.0.0.1:8787
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.DASH_PORT || 8787);

let child = null;
let runState = { running: false, startedAt: 0, total: 0, done: 0, results: [] };
const sseClients = new Set();

function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function classifyLine(line) {
  // Strip ANSI
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  const m = clean.match(/\[(\d+)\/(\d+)\]\s*\[([^\]]+)\]/);
  if (!m) return { type: 'log', text: clean };
  const tag = m[3].trim().toUpperCase();
  let bucket = 'errors';
  if (tag.includes('HIT')) bucket = 'hits';
  else if (tag.includes('BANNED') || tag.includes('SHADOW')) bucket = 'banned';
  else if (tag.includes('PASS RESET')) bucket = 'reset';
  else if (tag.includes('2FA')) bucket = 'twofa';
  else if (tag.includes('INVALID')) bucket = 'invalid';
  return { type: 'result', index: Number(m[1]), total: Number(m[2]), bucket, text: clean };
}

function handleLine(line) {
  if (!line.trim()) return;
  const parsed = classifyLine(line);
  if (parsed.type === 'result') {
    runState.done = parsed.index;
    runState.total = parsed.total;
    runState.results.push({ t: Date.now(), bucket: parsed.bucket });
    sseSend('result', parsed);
    sseSend('stats', statsSnapshot());
  } else {
    sseSend('log', { text: parsed.text });
  }
}

function statsSnapshot() {
  const now = Date.now();
  const oneMinAgo = now - 60000;
  const cpm = runState.results.filter((r) => r.t >= oneMinAgo).length;
  const elapsed = runState.startedAt ? (now - runState.startedAt) / 1000 : 0;
  const rate = runState.done > 0 && elapsed > 0 ? runState.done / (elapsed / 60) : 0;
  const remaining = runState.total - runState.done;
  const etaSec = rate > 0 ? Math.round((remaining / rate) * 60) : null;
  const counts = { hits: 0, banned: 0, reset: 0, twofa: 0, invalid: 0, errors: 0 };
  for (const r of runState.results) counts[r.bucket] = (counts[r.bucket] || 0) + 1;
  return {
    running: runState.running,
    done: runState.done,
    total: runState.total,
    cpm,
    etaSec,
    elapsedSec: Math.round(elapsed),
    counts,
  };
}

function startRun(opts) {
  if (child) return { ok: false, error: 'Already running' };
  const threads = Math.min(9, Math.max(1, Number(opts.threads) || 2));
  const delaySec = Math.max(0, Number(opts.delaySec) || 0);
  const useProxy = Boolean(opts.proxy);
  const headed = Boolean(opts.headed);

  // Proxy OFF: point checker at a comments-only proxies file (core untouched)
  let proxyFile = path.join(ROOT, 'proxies.txt');
  if (!useProxy) {
    proxyFile = path.join(ROOT, 'results', 'proxies_disabled.txt');
    fs.mkdirSync(path.dirname(proxyFile), { recursive: true });
    fs.writeFileSync(proxyFile, '# proxy disabled via dashboard\n', 'utf-8');
  }

  const env = { ...process.env };
  if (delaySec > 0) {
    // Worker delay: pace account starts at delaySec ±30% jitter (W10 pacer env hooks)
    const minMs = Math.round(delaySec * 1000 * 0.7);
    const maxMs = Math.round(delaySec * 1000 * 1.3);
    env.LOGIN_PACE_MIN_MS = String(minMs);
    env.LOGIN_PACE_MAX_MS = String(maxMs);
    env.LOGIN_PACE_PROXY_MIN_MS = String(minMs);
    env.LOGIN_PACE_PROXY_MAX_MS = String(maxMs);
  }

  const args = ['reddit_checker.js', headed ? '--headed' : '--headless', '-t', String(threads), '-p', proxyFile];
  child = spawn(process.execPath, args, { cwd: ROOT, env });
  runState = { running: true, startedAt: Date.now(), total: 0, done: 0, results: [] };
  sseSend('status', { running: true, args: args.join(' ') });

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (d) => sseSend('log', { text: '[stderr] ' + d.toString().trim() }));
  child.on('exit', (code) => {
    runState.running = false;
    child = null;
    sseSend('status', { running: false, exitCode: code });
    sseSend('stats', statsSnapshot());
  });
  return { ok: true, args: args.join(' ') };
}

function stopRun() {
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { if (child) { try { child.kill('SIGKILL'); } catch {} } }, 3000);
  }
  return { ok: true };
}
