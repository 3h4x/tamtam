// Start a graphile-worker pool inside the Next.js process to actually run
// the queued `agent-cron` jobs that `seedAgentCrons` enqueues. Runs against
// the same Postgres as the Vercel Workflow runtime — they share the
// `graphile_worker.jobs` table but have non-overlapping `task_identifier`
// names so they don't trip over each other.
//
// One pool per process. `globalThis.__tamtamCronWorker` pins the runner so
// Next.js's separate module realms see the same instance (mirrors the
// pattern used by `internal-scheduler.ts` for `globalThis.__tamtamScheduler`).
//
// Stop semantics: `stopCronWorker()` triggers graceful shutdown, used by
// tests that swap in fakes. Production never stops it — it lives for the
// lifetime of the Next.js process.

import { run } from 'graphile-worker';
import type { Runner, Task } from 'graphile-worker';
import { createAgentCronTask, type AgentCronDeps, type AgentCronPayload } from '@/lib/workflows/cron/agent-cron-task';
import { createSystemCronTask, type SystemCronDeps } from '@/lib/workflows/cron/system-cron-task';
import { createProjectSweepTask, type ProjectSweepDeps } from '@/lib/workflows/cron/project-sweep-task';

export interface StartCronWorkerOptions {
  connectionString: string;
  agentCronDeps: AgentCronDeps;
  /** Optional — when present, registers `system-cron` in the same worker
   *  pool. If omitted, only `agent-cron` is handled. */
  systemCronDeps?: SystemCronDeps;
  /** Optional — when present, registers `project-sweep` in the same pool. */
  projectSweepDeps?: ProjectSweepDeps;
  /** Lower than the workflow runtime's default (10) so cron tasks can't
   *  starve the queue if many fire concurrently. */
  concurrency?: number;
}

interface CronWorkerSlot {
  runner: Runner | null;
  startPromise: Promise<Runner> | null;
}

declare global {
  // Pinned on globalThis so Next.js's separate module realms see the same
  // runner instance (mirrors `globalThis.__tamtamScheduler` in the legacy
  // in-memory scheduler).
  var __tamtamCronWorker: CronWorkerSlot | undefined;
}

function getSlot(): CronWorkerSlot {
  if (!globalThis.__tamtamCronWorker) {
    globalThis.__tamtamCronWorker = { runner: null, startPromise: null };
  }
  return globalThis.__tamtamCronWorker;
}

/** Idempotent — calling twice in the same process returns the existing
 *  runner. The boot path may invoke this from multiple module realms. */
export async function startCronWorker(opts: StartCronWorkerOptions): Promise<Runner> {
  const slot = getSlot();
  if (slot.runner) return slot.runner;
  if (slot.startPromise) return slot.startPromise;

  // graphile-worker's `Task` type uses `payload: unknown` to stay
  // compatible with arbitrary JSON. Wrap our typed handlers so the
  // graphile typings line up.
  const typedAgentHandler = createAgentCronTask(opts.agentCronDeps);
  const agentCronTask: Task = (payload, helpers) =>
    typedAgentHandler(payload as AgentCronPayload, helpers);
  const taskList: Record<string, Task> = {
    'agent-cron': agentCronTask,
  };
  if (opts.systemCronDeps) {
    taskList['system-cron'] = createSystemCronTask(opts.systemCronDeps);
  }
  if (opts.projectSweepDeps) {
    taskList['project-sweep'] = createProjectSweepTask(opts.projectSweepDeps);
  }

  slot.startPromise = run({
    connectionString: opts.connectionString,
    concurrency: opts.concurrency ?? 4,
    pollInterval: 2000,
    taskList,
    // graphile-worker auto-creates its tables on first run; the workflow
    // runtime did the same on its first boot. No-op on subsequent boots.
    noHandleSignals: true,
  }).then((runner) => {
    slot.runner = runner;
    slot.startPromise = null;
    return runner;
  });

  return slot.startPromise;
}

export async function stopCronWorker(): Promise<void> {
  const slot = getSlot();
  if (slot.runner) {
    try {
      await slot.runner.stop();
    } catch {
      /* ignore */
    }
    slot.runner = null;
  }
  slot.startPromise = null;
}
