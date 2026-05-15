// Thin facade over the in-process scheduler in `./internal-scheduler.ts`.
//
// All scheduling lives in `internal-scheduler` now — setTimeout fan-out per
// enabled scheduled agent. This file exists for two reasons:
//
//   - Public API surface (installAgentSchedule / uninstallAgentSchedule /
//     getSchedulerHealth) used by `/api/agents` routes and the recommendations
//     applier, kept stable while the underlying implementation evolves.
//   - One file-system side-effect: each agent's prompt is persisted to
//     `<logDir>/agent-scripts/<agentId>.prompt.json` so out-of-band reruns
//     can recover it after a server restart.
//
// The legacy PM2-cron scheduling path was retired with the rest of the
// per-job PM2 infrastructure. Functions and types stay close to their
// pre-retirement shape so callers don't have to change.

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getImproveConfig } from './scheduling';
import { normalizeAgentScheduleOrThrow } from './agent-schedule';

function getLogDir(): string {
  try { return getImproveConfig().logDir; } catch { return join(/*turbopackIgnore: true*/ homedir(), 'logs'); }
}
function getScriptsDir(): string {
  return join(getLogDir(), 'agent-scripts');
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

function ensureDirs(): void {
  mkdirSync(/*turbopackIgnore: true*/ getScriptsDir(), { recursive: true });
}

// --- Public API ---

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
}

export async function uninstallAgentSchedule(
  agentId: string,
  _runner: string = 'pm2',
  _project?: string,
  _agentName?: string,
): Promise<void> {
  const { removeAgentSchedule } = await import('./internal-scheduler');
  removeAgentSchedule(agentId);
  cleanupFiles(agentId);
}

export async function isAgentScheduleLoaded(
  agentId: string,
  _runner: string = 'pm2',
  _project?: string,
  _agentName?: string,
): Promise<boolean> {
  const { dumpInternalScheduler } = await import('./internal-scheduler');
  return dumpInternalScheduler().entries.some((e) => e.agentId === agentId);
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
      // expectedName retained for response-shape compatibility; uses the
      // legacy `tamtam-<project>-agent-<name>` format readers may expect.
      expectedName: a.project && a.name ? `tamtam-${a.project}-agent-${a.name}` : `tamtam-agent-${a.id}`,
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
