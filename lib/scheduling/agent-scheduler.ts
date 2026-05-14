import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig } from './scheduling';
import { normalizeAgentScheduleOrThrow } from './agent-schedule';

function getLogDir(): string {
  try { return getImproveConfig().logDir; } catch { return join(/*turbopackIgnore: true*/ homedir(), 'logs'); }
}
function getScriptsDir(): string {
  return join(getLogDir(), 'agent-scripts');
}

function pm2Name(agentId: string, project?: string, agentName?: string): string {
  if (project && agentName) return `tamtam-${project}-agent-${agentName}`;
  return `tamtam-agent-${agentId}`;
}

function agentPromptPath(agentId: string): string {
  return join(getScriptsDir(), `${agentId}.prompt.json`);
}

function cleanupFiles(agentId: string): void {
  // Older builds wrote a per-agent shell script next to the prompt; clean up
  // either artifact if present so nothing lingers after an agent is removed.
  for (const ext of ['sh', 'prompt.json']) {
    const p = join(getScriptsDir(), `${agentId}.${ext}`);
    if (existsSync(/*turbopackIgnore: true*/ p)) unlinkSync(/*turbopackIgnore: true*/ p);
  }
}

// --- PM2 scheduling (legacy cleanup only) ---
//
// installPm2Schedule was removed: PM2 cron with --no-autostart silently
// no-op'd, so registering an agent there had no effect. All scheduling now
// lives in lib/internal-scheduler.ts. The uninstall + reconcile helpers stay
// to clean up any legacy entries left over from before the migration.

async function uninstallPm2Schedule(agentId: string, project?: string, agentName?: string): Promise<void> {
  const name = pm2Name(agentId, project, agentName);
  // pm2 delete returns non-zero if process doesn't exist, that's fine
  await exec('pm2', ['delete', name]);
  cleanupFiles(agentId);
}

async function isPm2ScheduleLoaded(agentId: string, project?: string, agentName?: string): Promise<boolean> {
  const name = pm2Name(agentId, project, agentName);
  const result = await exec('pm2', ['describe', name]);
  return result.exitCode === 0;
}

// --- Reconciliation ---

/**
 * Compare PM2's running `tamtam-*-agent-*` processes against the expected set
 * (enabled, scheduled, pm2-runner agents from the DB) and delete any orphans.
 *
 * This runs at startup to clean up stale entries left by renames, project
 * changes, runner switches, or failed uninstalls.
 */
export async function reconcilePm2Schedules(
  agents: Array<{ id: string; project: string; name: string; runner: string; schedule: string | null; enabled: boolean }>
): Promise<void> {
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec('pm2', ['jlist']);
  } catch {
    return;
  }
  if (result.exitCode !== 0 || !result.stdout.trim()) return;

  let processes: Array<{ name: string }>;
  try {
    processes = JSON.parse(result.stdout);
  } catch {
    return;
  }

  const expectedNames = new Set<string>();
  for (const agent of agents) {
    if (!agent.schedule || !agent.enabled) continue;
    expectedNames.add(pm2Name(agent.id, agent.project, agent.name));
  }

  for (const proc of processes) {
    const { name } = proc;
    if (!name || !name.startsWith('tamtam-') || !name.includes('-agent-')) continue;
    if (expectedNames.has(name)) continue;
    try {
      await exec('pm2', ['delete', name]);
      console.log(`[scheduler] reconciled orphan PM2 entry: ${name}`);
    } catch (err) {
      console.error(`[scheduler] failed to delete orphan ${name}:`, err);
    }
  }
}

// --- Public API ---

function ensureDirs(): void {
  mkdirSync(/*turbopackIgnore: true*/ getScriptsDir(), { recursive: true });
}

export async function installAgentSchedule(
  agentId: string,
  schedule: string,
  prompt: string,
  _runner: string = 'pm2',
  project?: string,
  agentName?: string,
): Promise<void> {
  const normalizedSchedule = normalizeAgentScheduleOrThrow(schedule);
  ensureDirs();
  // Persist prompt next to the runtime artifacts so out-of-band reruns can
  // recover it.
  writeFileSync(/*turbopackIgnore: true*/ agentPromptPath(agentId), JSON.stringify({ prompt }));

  const { upsertAgentSchedule } = await import('./internal-scheduler');
  upsertAgentSchedule({
    id: agentId,
    project: project ?? '',
    name: agentName ?? agentId,
    schedule: normalizedSchedule,
    prompt,
    enabled: true,
  });
  await uninstallPm2Schedule(agentId, project, agentName);
}

export async function uninstallAgentSchedule(
  agentId: string,
  _runner: string = 'pm2',
  project?: string,
  agentName?: string,
): Promise<void> {
  const { removeAgentSchedule } = await import('./internal-scheduler');
  removeAgentSchedule(agentId);
  await uninstallPm2Schedule(agentId, project, agentName);
}

export async function isAgentScheduleLoaded(
  agentId: string,
  _runner: string = 'pm2',
  project?: string,
  agentName?: string,
): Promise<boolean> {
  return isPm2ScheduleLoaded(agentId, project, agentName);
}

// --- Health / verification ---

export type SchedulerExpected = {
  id: string;
  project: string;
  name: string;
  runner: string;
  schedule: string;
  expectedName: string;
};

export type SchedulerHealth = {
  ok: boolean;
  expected: SchedulerExpected[];
  actual: { pm2: string[] };
  missing: SchedulerExpected[];
  orphans: { pm2: string[] };
  errors: string[];
};

export async function getSchedulerHealth(
  agents: Array<{ id: string; project: string; name: string; runner: string; schedule: string | null; enabled: boolean }>,
): Promise<SchedulerHealth> {
  const expected: SchedulerExpected[] = [];
  for (const a of agents) {
    if (!a.enabled || !a.schedule) continue;
    expected.push({
      id: a.id,
      project: a.project,
      name: a.name,
      runner: a.runner,
      schedule: a.schedule,
      expectedName: pm2Name(a.id, a.project, a.name),
    });
  }

  const errors: string[] = [];

  const { dumpInternalScheduler } = await import('./internal-scheduler');
  const internal = dumpInternalScheduler();
  const internalIds = new Set(internal.entries.map((e) => e.agentId));

  const missing: SchedulerExpected[] = [];
  for (const e of expected) {
    if (!internalIds.has(e.id)) missing.push(e);
  }

  const expectedInternalIds = new Set(expected.map((e) => e.id));
  const internalOrphans = internal.entries
    .filter((e) => !expectedInternalIds.has(e.agentId))
    .map((e) => `${e.project}/${e.name}`);

  const orphans = { pm2: internalOrphans };
  const internalNames = internal.entries.map((e) => `${e.project}/${e.name}`);

  const ok = errors.length === 0 && missing.length === 0 && orphans.pm2.length === 0;
  return {
    ok,
    expected,
    actual: { pm2: internalNames },
    missing,
    orphans,
    errors,
  };
}

/** Surface internal scheduler state (next-fire times, last-fire counts) for the monitoring panel. */
export async function getInternalSchedulerDump() {
  const { dumpInternalScheduler } = await import('./internal-scheduler');
  return dumpInternalScheduler();
}
