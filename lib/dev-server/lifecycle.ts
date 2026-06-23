// Per-project dev server lifecycle.
//
// Each tracked project can declare three settings on its `projects` row:
//
//   dev_server_start_command  — bash that launches the dev server (e.g. "pnpm dev")
//   dev_server_stop_command   — optional bash to stop it cleanly. When null we
//                               send SIGTERM to the spawned process group.
//   dev_server_ready_url      — optional URL. When set, `ensureDevServerRunning`
//                               polls it until a non-5xx response (or timeout).
//                               When null we wait a short grace period and return.
//
// The lifecycle ties to the **outermost scope of an agent run**: agent kickoff
// calls `ensureDevServerRunning`; the caller is responsible for stopping at
// the end of work. The two terminal stop points are:
//   - agent completion hook (only when no active release follows)
//   - release finalize (always)
//
// State lives in `data/dev-servers/<project>.pid` (gitignored). The pidfile is
// the source of truth — if it's gone, no server is owned by TamTam. A pidfile
// is trusted only when the live PID still has the same OS process-start
// identity TamTam recorded when it spawned the server, or when this same
// TamTam process still has the child handle it just spawned; legacy/mismatched
// pidfiles are removed without signaling so PID reuse cannot kill an unrelated
// process group.
//
// Direct `child_process.spawn` is used here (rather than `lib/shared/shell.ts`)
// because dev servers are long-lived background processes: we must keep the
// child detached, capture its PGID for clean teardown, and return before the
// child exits. This is one of the documented runner/streaming exceptions to
// the "go through shared shell" convention.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { buildChildEnv } from '@/lib/shared/child-env';
import { checkPrBranchExecutionGate } from '@/lib/security/pr-branch-execution';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_PROBE_INTERVAL_MS = 500;
const POST_SPAWN_GRACE_MS = 1_500;
const spawnedThisProcess = new Map<number, { pgid: number; child: ReturnType<typeof spawn> }>();

export interface DevServerConfig {
  startCommand: string | null;
  stopCommand: string | null;
  readyUrl: string | null;
  cwd: string;
}

export interface DevServerPidFile {
  project?: string | null;
  pid: number;
  pgid: number;
  processStart?: string | null;
  startedAt: number;
  startedByJobId: string | null;
  command: string;
  readyUrl: string | null;
  cwd: string;
  logPath: string;
}

export type EnsureResult =
  | { status: 'already_running'; pidfile: DevServerPidFile }
  | { status: 'started'; pidfile: DevServerPidFile }
  | { status: 'no_config' }
  | { status: 'ready_timeout'; pidfile: DevServerPidFile }
  | { status: 'spawn_failed'; error: string };

export type StopResult =
  | { status: 'stopped'; pid: number }
  | { status: 'not_running' }
  | { status: 'error'; error: string };

function devServersDir(): string {
  return process.env.TAMTAM_DEV_SERVERS_DIR || join(process.cwd(), 'data', 'dev-servers');
}

function pidfilePathFor(project: string): string {
  // Project names are constrained slugs in the projects table; still sanitize
  // defensively so a malicious name can't traverse out of the data dir.
  const safe = project.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(devServersDir(), `${safe}.pid`);
}

function logFilePathFor(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(devServersDir(), `${safe}.log`);
}

function ensureDir(): void {
  // mkdirSync with `recursive: true` is idempotent when the dir already
  // exists — no need for an existsSync precheck.
  mkdirSync(/*turbopackIgnore: true*/ devServersDir(), { recursive: true });
}

export function readPidfile(project: string): DevServerPidFile | null {
  return readPidfileAtPath(pidfilePathFor(project));
}

function readPidfileAtPath(path: string): DevServerPidFile | null {
  // Skip the existsSync precheck — readFileSync throws ENOENT and the catch
  // handles it the same way. One fewer syscall, no TOCTOU.
  try {
    const raw = readFileSync(/*turbopackIgnore: true*/ path, 'utf8');
    const parsed = JSON.parse(raw) as DevServerPidFile;
    if (typeof parsed.pid !== 'number' || typeof parsed.pgid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePidfile(project: string, data: DevServerPidFile): void {
  ensureDir();
  writeFileSync(/*turbopackIgnore: true*/ pidfilePathFor(project), JSON.stringify(data, null, 2));
}

function removePidfile(project: string): void {
  removePidfileAtPath(pidfilePathFor(project));
}

function removePidfileAtPath(path: string): void {
  try {
    unlinkSync(/*turbopackIgnore: true*/ path);
  } catch {
    // best-effort — ENOENT is already what we wanted (file gone).
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 doesn't deliver — just checks for permission/existence.
    process.kill(pid, 0);
    if (readProcessState(pid)?.startsWith('Z')) return false;
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // EPERM means the process exists but we can't signal it; treat as alive
    // (someone else's pid; we shouldn't claim it).
    return err.code === 'EPERM';
  }
}

function readProcessState(pid: number): string | null {
  if (pid <= 0) return null;
  try {
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function readProcessStart(pid: number): string | null {
  if (pid <= 0) return null;
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function ownsLivePidfile(pidfile: DevServerPidFile): boolean {
  if (pidfile.pid <= 0) return false;
  if (!isProcessAlive(pidfile.pid)) return false;
  const startedHere = spawnedThisProcess.get(pidfile.pid);
  if (startedHere?.pgid === pidfile.pgid) {
    return true;
  }
  if (!pidfile.processStart) return false;
  return readProcessStart(pidfile.pid) === pidfile.processStart;
}

async function fetchReadyOnce(url: string, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  t.unref?.();
  try {
    const resp = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    // Any response (including 3xx/4xx) means the server bound the port and
    // is responsive enough to refuse — that's "ready enough" for our
    // purposes. Only 5xx and network errors keep us waiting.
    return resp.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function probeReady(
  url: string,
  timeoutMs: number,
  shouldStop: () => boolean = () => false,
): Promise<'ready' | 'timeout' | 'stopped'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) return 'stopped';
    if (await fetchReadyOnce(url, 2_000)) return 'ready';
    if (shouldStop()) return 'stopped';
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(READY_PROBE_INTERVAL_MS, remainingMs)));
  }
  return shouldStop() ? 'stopped' : 'timeout';
}

async function gracePeriod(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function yieldToIoEvents(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

function childHasStopped(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid) return true;
  return child.exitCode !== null || child.signalCode !== null || !isProcessAlive(child.pid);
}

async function waitForTrackedChildExit(pid: number, timeoutMs: number): Promise<void> {
  const tracked = spawnedThisProcess.get(pid);
  if (!tracked) return;
  const { child } = tracked;
  if (child.exitCode !== null || child.signalCode !== null) return;

  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  await yieldToIoEvents();
}

export interface EnsureOptions {
  readyTimeoutMs?: number;
  startedByJobId?: string | null;
}

export async function ensureDevServerRunning(
  project: string,
  config: DevServerConfig,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  if (!config.startCommand || !config.startCommand.trim()) {
    return { status: 'no_config' };
  }

  // 1. Already running? Either a TamTam-spawned one (trusted pidfile + alive
  //    PID) or the user's own (readiness URL responds). Either way: don't
  //    double-spawn.
  const existing = readPidfile(project);
  if (existing && ownsLivePidfile(existing)) {
    return { status: 'already_running', pidfile: existing };
  }
  // Stale/untrusted pidfile cleanup. If the PID is alive but its recorded
  // process identity doesn't match, this is likely PID reuse or a legacy
  // pidfile; remove the file but never signal that process.
  if (existing) {
    removePidfile(project);
    spawnedThisProcess.delete(existing.pid);
  }
  // User-started dev server (no pidfile, readiness URL responds)
  if (config.readyUrl) {
    if (await fetchReadyOnce(config.readyUrl, 1_500)) {
      // Someone else owns this; we don't write a pidfile, so we won't stop it.
      // Return a synthetic "already_running" marker so the caller knows
      // there's a server up to talk to.
      return {
        status: 'already_running',
        pidfile: {
          project,
          pid: -1,
          pgid: -1,
          processStart: null,
          startedAt: Date.now(),
          startedByJobId: null,
          command: '(external)',
          readyUrl: config.readyUrl,
          cwd: config.cwd,
          logPath: '',
        },
      };
    }
  }

  // 2. Spawn detached so we can kill the whole tree later via PGID.
  const executionGate = checkPrBranchExecutionGate(config.cwd, 'start dev server');
  if (!executionGate.ok) {
    return { status: 'spawn_failed', error: executionGate.detail };
  }

  ensureDir();
  const logPath = logFilePathFor(project);
  let logFd: number;
  try {
    logFd = openSync(/*turbopackIgnore: true*/ logPath, 'a');
  } catch (e) {
    return { status: 'spawn_failed', error: `cannot open log: ${(e as Error).message}` };
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('bash', ['-c', config.startCommand], {
      cwd: config.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: buildChildEnv(undefined, { scrubSecrets: true }),
    });
    child.once('error', (e) => console.error(`[dev-server] spawn error for ${project}:`, e));
  } catch (e) {
    try { closeSync(logFd); } catch {}
    return { status: 'spawn_failed', error: (e as Error).message };
  }

  // Close the parent's copy of the log fd — the child holds its own.
  try { closeSync(logFd); } catch {}

  if (!child.pid) {
    return { status: 'spawn_failed', error: 'spawn returned no pid' };
  }

  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      spawnedThisProcess.delete(child.pid!);
      resolve();
    });
  });

  // Detach from parent — child must survive a Next.js / PM2 restart.
  child.unref();

  const processStart = readProcessStart(child.pid);
  spawnedThisProcess.set(child.pid, { pgid: child.pid, child });

  const pidfile: DevServerPidFile = {
    project,
    pid: child.pid,
    pgid: child.pid, // PGID == PID for a detached leader spawned with detached:true
    processStart,
    startedAt: Date.now(),
    startedByJobId: options.startedByJobId ?? null,
    command: config.startCommand,
    readyUrl: config.readyUrl,
    cwd: config.cwd,
    logPath,
  };
  writePidfile(project, pidfile);

  // 3. Wait for readiness.
  if (config.readyUrl) {
    const readiness = await probeReady(
      config.readyUrl,
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      () => exited || childHasStopped(child),
    );
    if (readiness === 'stopped') {
      removePidfile(project);
      spawnedThisProcess.delete(pidfile.pid);
      return { status: 'spawn_failed', error: 'process exited immediately; see log' };
    }
    if (readiness === 'timeout') return { status: 'ready_timeout', pidfile };
  } else {
    await Promise.race([gracePeriod(POST_SPAWN_GRACE_MS), exitPromise]);
    await yieldToIoEvents();
    // Also verify the process didn't immediately exit (bad command, missing
    // binary, etc.). Without a readiness URL this is the only signal we have.
    if (exited || childHasStopped(child)) {
      removePidfile(project);
      spawnedThisProcess.delete(pidfile.pid);
      return { status: 'spawn_failed', error: 'process exited immediately; see log' };
    }
  }

  return { status: 'started', pidfile };
}

export async function stopDevServer(
  project: string,
  config: Pick<DevServerConfig, 'stopCommand' | 'cwd'>,
): Promise<StopResult> {
  const pidPath = pidfilePathFor(project);
  const pidfile = readPidfileAtPath(pidPath);
  if (!pidfile) return { status: 'not_running' };

  return stopDevServerPidfile(project, pidPath, pidfile, config);
}

async function stopDevServerPidfile(
  project: string,
  pidPath: string,
  pidfile: DevServerPidFile,
  config: Pick<DevServerConfig, 'stopCommand' | 'cwd'>,
): Promise<StopResult> {
  // External dev servers (pid: -1) — we never owned them, never stop them.
  if (pidfile.pid < 0) {
    removePidfileAtPath(pidPath);
    return { status: 'not_running' };
  }

  if (!ownsLivePidfile(pidfile)) {
    removePidfileAtPath(pidPath);
    spawnedThisProcess.delete(pidfile.pid);
    return { status: 'not_running' };
  }

  // Prefer the configured stop command — it gives projects a clean shutdown
  // path (e.g. their own `pnpm dev:stop` may run pre-exit hooks). Fall back to
  // SIGTERM-then-SIGKILL on the process group.
  if (config.stopCommand && config.stopCommand.trim()) {
    try {
      const { exec } = await import('@/lib/shared/shell');
      await exec('bash', ['-c', config.stopCommand], {
        cwd: config.cwd,
        timeout: 15_000,
        killProcessGroup: true,
      });
    } catch (e) {
      // Fall through to PGID kill — stop command failing shouldn't strand the process.
      console.warn(`[dev-server] stop command failed for ${project}: ${(e as Error).message}`);
    }
  }

  // Whether or not the stop command ran, verify the process is gone.
  // SIGTERM the group; wait briefly; SIGKILL if still alive. For children
  // spawned by this process, wait for Node to observe the exit so callers do
  // not see a just-killed child as still present.
  try {
    if (isProcessAlive(pidfile.pid)) {
      try { process.kill(-pidfile.pgid, 'SIGTERM'); } catch {}
      if (spawnedThisProcess.has(pidfile.pid)) {
        await waitForTrackedChildExit(pidfile.pid, 5_000);
      } else {
        const killDeadline = Date.now() + 5_000;
        while (Date.now() < killDeadline) {
          if (!isProcessAlive(pidfile.pid)) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (isProcessAlive(pidfile.pid)) {
        try { process.kill(-pidfile.pgid, 'SIGKILL'); } catch {}
        await waitForTrackedChildExit(pidfile.pid, 1_000);
      }
    } else {
      await waitForTrackedChildExit(pidfile.pid, 1_000);
    }
  } catch (e) {
    removePidfileAtPath(pidPath);
    return { status: 'error', error: (e as Error).message };
  }

  removePidfileAtPath(pidPath);
  spawnedThisProcess.delete(pidfile.pid);
  return { status: 'stopped', pid: pidfile.pid };
}

export function isDevServerRunning(project: string): boolean {
  const pidfile = readPidfile(project);
  if (!pidfile) return false;
  return ownsLivePidfile(pidfile);
}

// Boot-time cleanup. Called from instrumentation-node.ts.
// For each pidfile: if the originating job is finished AND no other active
// release/agent run exists for that project, stop the orphaned dev server.
export async function sweepOrphanDevServers(): Promise<{ stopped: string[]; kept: string[] }> {
  const stopped: string[] = [];
  const kept: string[] = [];

  const dir = devServersDir();
  let entries: string[];
  try {
    // No existsSync precheck — readdirSync throws ENOENT and the catch
    // returns the same empty result.
    entries = readdirSync(/*turbopackIgnore: true*/ dir).filter((n) => n.endsWith('.pid'));
  } catch {
    return { stopped, kept };
  }

  const [{ hasActiveWorkForProject }, { db, schema }, { eq }] = await Promise.all([
    import('@/lib/dev-server/active-work'),
    import('@/lib/db'),
    import('drizzle-orm'),
  ]);

  for (const file of entries) {
    const pidPath = join(dir, file);
    const legacyProject = file.replace(/\.pid$/, '');
    const pidfile = readPidfileAtPath(pidPath);
    if (!pidfile) continue;
    const project = typeof pidfile.project === 'string' && pidfile.project.trim()
      ? pidfile.project
      : legacyProject;

    // Dead or untrusted pid → file is stale, just clean it up. For a live
    // process with a mismatched identity, never signal; the PID may have been
    // reused by something TamTam does not own.
    if (pidfile.pid > 0 && !ownsLivePidfile(pidfile)) {
      removePidfileAtPath(pidPath);
      spawnedThisProcess.delete(pidfile.pid);
      continue;
    }

    // Active work exists for this project → leave it running.
    if (await hasActiveWorkForProject(project)) {
      kept.push(project);
      continue;
    }

    // Orphan: TamTam crashed/restarted, the run that started this is gone,
    // no successor is using it. Stop and clean up.
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, project));
    const config: DevServerConfig = {
      startCommand: rows[0]?.devServerStartCommand ?? null,
      stopCommand: rows[0]?.devServerStopCommand ?? null,
      readyUrl: rows[0]?.devServerReadyUrl ?? null,
      cwd: rows[0]?.path ?? pidfile.cwd,
    };
    await stopDevServerPidfile(project, pidPath, pidfile, config);
    stopped.push(project);
  }

  return { stopped, kept };
}
