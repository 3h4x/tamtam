/* eslint-env node */

/**
 * Shared helpers for the TamTam CLI shims (claude/codex/gemini/lmstudio).
 *
 * Inactivity watchdog: TamTam invokes a shim, which spawns the underlying
 * vendor CLI. If the vendor CLI silently hangs (network stall, stuck tool
 * call, deadlocked subprocess), the shim — and TamTam's job-runner above
 * it — wait forever for `child.close` to fire. The job stays in `running`
 * status indefinitely because the probe sweep only checks process liveness,
 * and the shim *is* alive (just idle).
 *
 * `installInactivityWatchdog(child, opts)` arms a periodic check that kills
 * the child if no stdout/stderr data has arrived in `timeoutMs`. Callers
 * should:
 *   1. call this after `spawn(...)` returns the child handle
 *   2. invoke `markActivity()` on every chunk received from the child
 *      (stdout / stderr) so the timer is rearmed by real progress
 *   3. call `dispose()` from the `child.close` handler so the timer doesn't
 *      hold the event loop open after the run finishes
 *
 * Default timeout: 10 minutes. Override via SHIM_INACTIVITY_TIMEOUT_MS env
 * var (set to 0 to disable entirely — useful for long-running interactive
 * sessions).
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

function readTimeoutMs() {
  const raw = process.env.SHIM_INACTIVITY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_TIMEOUT_MS;
  return n;
}

/**
 * Arm an inactivity watchdog around `child`.
 * @param {import('child_process').ChildProcess} child
 * @param {{ shimName: string, onTimeout?: (info: { timeoutMs: number, sinceLastActivityMs: number }) => void, timeoutMs?: number }} opts
 * @returns {{ markActivity: () => void, dispose: () => void, timedOut: () => boolean }}
 */
function installInactivityWatchdog(child, opts) {
  const shimName = opts && opts.shimName ? opts.shimName : 'shim';
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : readTimeoutMs();
  const state = { lastActivityAt: Date.now(), timedOut: false, killedAt: 0 };

  if (timeoutMs <= 0) {
    return {
      markActivity() {},
      dispose() {},
      timedOut: () => false,
    };
  }

  // Check 6× per timeout window so we're never more than ~timeout/6 late.
  const tickMs = Math.max(1_000, Math.floor(timeoutMs / 6));
  const timer = setInterval(() => {
    const idleMs = Date.now() - state.lastActivityAt;
    if (idleMs < timeoutMs) return;
    if (state.timedOut) {
      // Already SIGTERMed; if it's still alive after the grace window, escalate.
      if (Date.now() - state.killedAt >= KILL_GRACE_MS) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      return;
    }
    state.timedOut = true;
    state.killedAt = Date.now();
    if (opts?.onTimeout) {
      try { opts.onTimeout({ timeoutMs, sinceLastActivityMs: idleMs }); } catch { /* swallow */ }
    }
    process.stderr.write(
      `[${shimName}] inactivity watchdog: no output from child for ${Math.round(idleMs / 1000)}s ` +
      `(>= ${Math.round(timeoutMs / 1000)}s) — sending SIGTERM\n`
    );
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }, tickMs);
  // Don't let the timer keep the event loop alive past child exit.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    markActivity() { state.lastActivityAt = Date.now(); },
    dispose() { clearInterval(timer); },
    timedOut: () => state.timedOut,
  };
}

/**
 * Variant for shims that don't spawn a child process — e.g. lmstudio-shim
 * talks to a local HTTP server via fetch. Caller passes an abort function
 * (typically `controller.abort`) instead of a child handle. Same lifecycle:
 * markActivity() on each meaningful chunk, dispose() on completion.
 *
 * @param {() => void} abort
 * @param {{ shimName: string, onTimeout?: (info: { timeoutMs: number, sinceLastActivityMs: number }) => void, timeoutMs?: number }} opts
 * @returns {{ markActivity: () => void, dispose: () => void, timedOut: () => boolean }}
 */
function installFetchInactivityWatchdog(abort, opts) {
  const shimName = opts && opts.shimName ? opts.shimName : 'shim';
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : readTimeoutMs();
  const state = { lastActivityAt: Date.now(), timedOut: false };

  if (timeoutMs <= 0) {
    return { markActivity() {}, dispose() {}, timedOut: () => false };
  }

  const tickMs = Math.max(1_000, Math.floor(timeoutMs / 6));
  const timer = setInterval(() => {
    const idleMs = Date.now() - state.lastActivityAt;
    if (idleMs < timeoutMs) return;
    if (state.timedOut) return;
    state.timedOut = true;
    if (opts?.onTimeout) {
      try { opts.onTimeout({ timeoutMs, sinceLastActivityMs: idleMs }); } catch { /* swallow */ }
    }
    process.stderr.write(
      `[${shimName}] inactivity watchdog: no fetch activity for ${Math.round(idleMs / 1000)}s ` +
      `(>= ${Math.round(timeoutMs / 1000)}s) — aborting\n`
    );
    try { abort(); } catch { /* already aborted */ }
  }, tickMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    markActivity() { state.lastActivityAt = Date.now(); },
    dispose() { clearInterval(timer); },
    timedOut: () => state.timedOut,
  };
}

module.exports = { installInactivityWatchdog, installFetchInactivityWatchdog };
