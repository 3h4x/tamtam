#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Single PM2 entrypoint for every TamTam one-shot job (review, fix, fix-push,
// mark-dod, agent run, rerun). Replaces the per-job bash wrapper that
// lib/pm2-jobs.ts used to write to disk.
//
// Why: PM2 spawning a bash wrapper tracks the bash PID, not the actual
// claude/git child. On `pm2 stop`/`pm2 delete`/`pm2 restart`, PM2 signals
// bash; bash exits; the grandchild becomes a detached orphan. That's the
// orphan-creation mechanism we want to kill — same shape as the fix already
// applied to the long-lived tamtam server (`scripts/pm2-start.sh`).
//
// PM2 invokes us with `--interpreter node` so PM2 tracks THIS process; we
// spawn the real command ourselves and forward signals so a kill actually
// kills the work.
//
// Argv: <jobId> <logPath> <promptPath> <cmd> [...cmdArgs]
//   logPath/promptPath are passed in (rather than re-derived) so the runner
//   doesn't have to know about LOG_DIR resolution. PM2 also redirects its
//   own stdout/stderr to logPath via --output --error --merge-logs; we point
//   the child's fds at the same file so output isn't double-buffered.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { redactSecrets } = require('./log-redaction');

const [, , jobId, logPath, promptPath, cmd, ...cmdArgs] = process.argv;

if (!jobId || !logPath || !promptPath || !cmd) {
  console.error('[tamtam] job-runner: usage: <jobId> <logPath> <promptPath> <cmd> [...args]');
  process.exit(2);
}

let logFd;
try {
  logFd = fs.openSync(logPath, 'a');
} catch (err) {
  console.error(`[tamtam] job-runner: cannot open log ${logPath}: ${err.message}`);
  process.exit(2);
}

function logChunk(chunk) {
  try { fs.writeSync(logFd, redactSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))); } catch { /* noop */ }
}

function logLine(line) {
  logChunk(line.endsWith('\n') ? line : `${line}\n`);
}

function isJobsPaused() {
  try {
    const root = process.env.TAMTAM_ROOT || path.resolve(__dirname, '..');
    const dbPath = process.env.TAMTAM_DB_PATH || path.join(root, 'data', 'db', 'tamtam.db');
    if (!fs.existsSync(dbPath)) return false;

    // Loaded lazily so the runner still fail-opens if native bindings are not
    // available in a test or recovery environment.
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'jobs_paused'").get();
      return row && row.value === 'true';
    } finally {
      db.close();
    }
  } catch (err) {
    logLine(`[tamtam] pause check unavailable; continuing: ${err.message}`);
    return false;
  }
}

if (isJobsPaused()) {
  logLine('[tamtam] jobs are paused globally; refusing to launch child command');
  try { fs.closeSync(logFd); } catch { /* noop */ }
  process.exit(75);
}

const launchedSummary = [cmd, ...cmdArgs]
  .map(a => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  .join(' ');
logLine(`[tamtam] launching: ${launchedSummary}`);

// Install signal handlers BEFORE spawning the child. If we register them
// after, there's a race: the child can be running (and visible to the test
// or to PM2) before our handler is installed, so a SIGTERM during that
// window kills the runner via default action — orphaning the child, which
// is the exact bug this wrapper exists to prevent.
let child;
let signalled = false;
function forward(sig) {
  if (signalled) return;
  signalled = true;
  // PM2 sends SIGINT first, then SIGKILL after a grace period. Forward to
  // the actual child so the work dies — that's the whole point of this
  // wrapper, otherwise PM2 kills us and the child outlives us as an orphan.
  try { if (child) child.kill(sig); } catch { /* child may have already exited */ }
}
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGHUP', () => forward('SIGHUP'));

try {
  // Strip PORT/HOSTNAME inherited from tamtam's own next-server process —
  // otherwise any child Next dev server we launch tries to bind to 1337.
  const childEnv = { ...process.env };
  delete childEnv.PORT;
  delete childEnv.HOSTNAME;
  child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });
} catch (err) {
  logLine(`[tamtam] spawn failed: ${err.message}`);
  try { fs.closeSync(logFd); } catch { /* noop */ }
  process.exit(127);
}

child.stdout.on('data', logChunk);
child.stderr.on('data', logChunk);

child.on('error', err => {
  // Fires for ENOENT etc. when the binary can't be located.
  logLine(`[tamtam] spawn error: ${err.message}`);
  try { fs.closeSync(logFd); } catch { /* noop */ }
  process.exit(127);
});

// Pipe the prompt file into the child's stdin (today's bash wrapper does
// `cat "$PROMPT" | <cmd>`).
try {
  const promptStream = fs.createReadStream(promptPath);
  promptStream.on('error', err => {
    logLine(`[tamtam] prompt read error: ${err.message}`);
    try { child.stdin.end(); } catch { /* noop */ }
  });
  promptStream.pipe(child.stdin).on('error', () => { /* child closed stdin early — ignore */ });
} catch (err) {
  logLine(`[tamtam] prompt open error: ${err.message}`);
  try { child.stdin.end(); } catch { /* noop */ }
}

child.on('exit', (code, signal) => {
  const rc = code ?? (signal ? 128 + (require('os').constants.signals[signal] ?? 0) : 1);
  logLine(`[tamtam] exited with code ${rc}${signal ? ` (signal ${signal})` : ''}`);
  try { fs.closeSync(logFd); } catch { /* noop */ }
  // Use the child's exit code as our own — pm2_env.exit_code reads this and
  // lib/pm2-jobs.ts:84 getJobStatus surfaces it back to TamTam.
  process.exit(rc);
});
