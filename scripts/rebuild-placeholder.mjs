#!/usr/bin/env node
// Tiny placeholder HTTP server shown on the TamTam port WHILE `rebuild-safe.sh`
// has stopped the real PM2 server to build. Without it, a refresh during the
// build window hits a dead port (connection refused) and looks like a crash.
// This serves a 503 "rebuilding" page that auto-refreshes, so the operator can
// see it's mid-rebuild, when it started, and a rough ETA from past build times.
//
// Best-effort and must NEVER block the rebuild: if the port can't be bound
// (e.g. the real server hasn't released it yet), it retries briefly then exits
// 0 quietly. rebuild-safe.sh kills it right before bringing the real server up.
//
// Env:
//   PLACEHOLDER_PORT   port to bind (required)
//   REBUILD_STARTED_MS epoch ms when the rebuild started (default: now)
//   REBUILD_AVG_MS     typical build duration in ms (0/absent = unknown)

import http from 'node:http';

const port = Number(process.env.PLACEHOLDER_PORT || 0);
const startedMs = Number(process.env.REBUILD_STARTED_MS) || Date.now();
const avgMs = Number(process.env.REBUILD_AVG_MS) || 0;

if (!port) {
  console.error('[rebuild-placeholder] no PLACEHOLDER_PORT — exiting');
  process.exit(0);
}

function fmtClock(ms) {
  // Local HH:MM:SS without pulling in any dep.
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function page() {
  const now = Date.now();
  const elapsed = now - startedMs;
  let eta = '';
  if (avgMs > 0) {
    const remaining = avgMs - elapsed;
    eta = remaining > 0
      ? `~${fmtDur(remaining)} left · ETA ${fmtClock(now + remaining)}`
      : `over typical by ${fmtDur(-remaining)} — finishing up…`;
  } else {
    eta = 'estimating…';
  }
  const typical = avgMs > 0 ? `~${fmtDur(avgMs)}` : 'unknown';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>TamTam — rebuilding…</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0b0d10; color:#e6e8eb; font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card { text-align:center; padding:2.5rem 3rem; border:1px solid #1e2430; border-radius:14px;
    background:#11151b; box-shadow:0 8px 40px rgba(0,0,0,.4); max-width:34rem; }
  .spin { width:34px; height:34px; margin:0 auto 1.25rem; border:3px solid #1e2430;
    border-top-color:#5b9dff; border-radius:50%; animation:r 1s linear infinite; }
  @keyframes r { to { transform:rotate(360deg); } }
  h1 { margin:0 0 .25rem; font-size:1.15rem; font-weight:600; }
  .sub { color:#8b94a3; margin-bottom:1.5rem; }
  table { margin:0 auto; border-collapse:collapse; }
  td { padding:.18rem .9rem; }
  td.k { color:#8b94a3; text-align:right; }
  td.v { text-align:left; color:#e6e8eb; }
  .foot { margin-top:1.5rem; color:#5c6573; font-size:12px; }
</style></head>
<body><div class="card">
  <div class="spin"></div>
  <h1>TamTam is rebuilding</h1>
  <div class="sub">The server is down on purpose while a new build is produced.</div>
  <table>
    <tr><td class="k">started</td><td class="v">${fmtClock(startedMs)}</td></tr>
    <tr><td class="k">elapsed</td><td class="v">${fmtDur(elapsed)}</td></tr>
    <tr><td class="k">typical build</td><td class="v">${typical}</td></tr>
    <tr><td class="k">estimate</td><td class="v">${eta}</td></tr>
  </table>
  <div class="foot">auto-refreshing every 5s · this page disappears when the server is back</div>
</div></body></html>`;
}

const server = http.createServer((req, res) => {
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'retry-after': '5',
    'cache-control': 'no-store',
  });
  res.end(page());
});

// Port may still be in TIME_WAIT from the just-stopped server. Retry a few
// times, then give up quietly — the placeholder is a nicety, not load-bearing.
let attempts = 0;
function listen() {
  server.listen(port, () => {
    console.log(`[rebuild-placeholder] serving rebuild page on :${port}`);
  });
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && attempts < 10) {
    attempts += 1;
    setTimeout(listen, 500);
    return;
  }
  console.error(`[rebuild-placeholder] could not bind :${port} (${err.code}) — exiting`);
  process.exit(0);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

listen();
