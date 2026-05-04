import { writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from '@/lib/shared/shell';
import { getSettings } from '@/lib/shared/config';
import { getImproveConfig } from './scheduling';
import { normalizeAgentScheduleOrThrow } from './agent-schedule';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

function getLogDir(): string {
  try { return getImproveConfig().logDir; } catch { return join(homedir(), 'logs'); }
}
function getScriptsDir(): string {
  return join(getLogDir(), 'agent-scripts');
}

function parseScheduleToSeconds(schedule: string): number {
  const s = normalizeAgentScheduleOrThrow(schedule);
  if (s.endsWith('h')) return parseInt(s.slice(0, -1), 10) * 3600;
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) * 60;
  return parseInt(s, 10);
}

function agentLabel(agentId: string): string {
  const settings = getSettings();
  const prefix = settings.launchagent_prefix || 'com.tamtam';
  return `${prefix}.agent.${agentId}`;
}

function pm2Name(agentId: string, project?: string, agentName?: string): string {
  if (project && agentName) return `tamtam-${project}-agent-${agentName}`;
  return `tamtam-agent-${agentId}`;
}

function agentPlistPath(agentId: string): string {
  return join(LAUNCH_AGENTS_DIR, `${agentLabel(agentId)}.plist`);
}

function agentScriptPath(agentId: string): string {
  return join(getScriptsDir(), `${agentId}.sh`);
}

function agentPromptPath(agentId: string): string {
  return join(getScriptsDir(), `${agentId}.prompt.json`);
}

function buildLaunchctlScript(agentId: string): string {
  const port = process.env.PORT || '1337';
  const url = `http://localhost:${port}/api/agents/${agentId}/run`;
  const promptFile = agentPromptPath(agentId);

  return `#!/bin/bash
/usr/bin/curl -s -X POST -H "Content-Type: application/json" -H "X-Tamtam-Trigger: schedule" -d @"${promptFile}" "${url}"
`;
}

function buildPlist(agentId: string, schedule: string): string {
  const label = agentLabel(agentId);
  const intervalSec = parseScheduleToSeconds(schedule);
  const scriptPath = agentScriptPath(agentId);
  const logDir = join(homedir(), 'logs');
  const logPath = join(logDir, `agent-scheduler-${agentId}.log`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSec}</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;
}

function ensureDirs(): void {
  mkdirSync(getScriptsDir(), { recursive: true });
  mkdirSync(join(homedir(), 'logs'), { recursive: true });
}

function writeScriptAndPrompt(agentId: string, prompt: string): void {
  writeFileSync(agentPromptPath(agentId), JSON.stringify({ prompt }));
  writeFileSync(agentScriptPath(agentId), buildLaunchctlScript(agentId));
  chmodSync(agentScriptPath(agentId), 0o755);
}

function cleanupFiles(agentId: string): void {
  const script = agentScriptPath(agentId);
  if (existsSync(script)) unlinkSync(script);
  const promptFile = agentPromptPath(agentId);
  if (existsSync(promptFile)) unlinkSync(promptFile);
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

// --- Launchctl scheduling ---

async function installLaunchctlSchedule(agentId: string, schedule: string, prompt: string): Promise<void> {
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  ensureDirs();

  // Unload existing if present
  const plist = agentPlistPath(agentId);
  if (existsSync(plist)) {
    await exec('launchctl', ['unload', plist]);
  }

  writeScriptAndPrompt(agentId, prompt);

  writeFileSync(plist, buildPlist(agentId, schedule));
  await exec('launchctl', ['load', plist]);
}

async function uninstallLaunchctlSchedule(agentId: string): Promise<void> {
  const plist = agentPlistPath(agentId);
  if (existsSync(plist)) {
    await exec('launchctl', ['unload', plist]);
    unlinkSync(plist);
  }
  cleanupFiles(agentId);
}

async function isLaunchctlScheduleLoaded(agentId: string): Promise<boolean> {
  const label = agentLabel(agentId);
  const result = await exec('launchctl', ['list', label]);
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
    if (agent.runner !== 'pm2' || !agent.schedule || !agent.enabled) continue;
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

/**
 * @deprecated The launchctl runner is no longer supported. New agents should
 * use `runner: 'pm2'` (which now means in-process scheduling via
 * `lib/internal-scheduler.ts`). The launchctl branches below remain for
 * backwards compatibility with any pre-existing DB rows but emit a warning.
 */
function warnLaunchctlDeprecated(where: string): void {
  console.warn(`[agent-scheduler] launchctl runner is deprecated (${where}); migrate to runner='pm2'`);
}

export async function installAgentSchedule(
  agentId: string,
  schedule: string,
  prompt: string,
  runner: string = 'pm2',
  project?: string,
  agentName?: string
): Promise<void> {
  const normalizedSchedule = normalizeAgentScheduleOrThrow(schedule);
  if (runner === 'launchctl') {
    warnLaunchctlDeprecated('install');
    await installLaunchctlSchedule(agentId, normalizedSchedule, prompt);
    return;
  }
  // PM2 cron with --no-autostart silently no-op'd; agents registered that way
  // never fired. Real scheduling is now handled in-process by lib/internal-scheduler.
  // We still sweep any legacy PM2 cron entry so it doesn't show up as an orphan.
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

export async function uninstallAgentSchedule(agentId: string, runner: string = 'pm2', project?: string, agentName?: string): Promise<void> {
  if (runner === 'launchctl') {
    warnLaunchctlDeprecated('uninstall');
    await uninstallLaunchctlSchedule(agentId);
    return;
  }
  const { removeAgentSchedule } = await import('./internal-scheduler');
  removeAgentSchedule(agentId);
  await uninstallPm2Schedule(agentId, project, agentName);
}

export async function isAgentScheduleLoaded(agentId: string, runner: string = 'pm2', project?: string, agentName?: string): Promise<boolean> {
  if (runner === 'launchctl') {
    warnLaunchctlDeprecated('isLoaded');
    return isLaunchctlScheduleLoaded(agentId);
  }
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
  actual: { pm2: string[]; launchctl: string[] };
  missing: SchedulerExpected[];
  orphans: { pm2: string[]; launchctl: string[] };
  errors: string[];
};

async function listLaunchctlAgentLabels(): Promise<{ labels: string[]; error?: string }> {
  const settings = getSettings();
  const prefix = `${settings.launchagent_prefix || 'com.tamtam'}.agent.`;
  try {
    const r = await exec('launchctl', ['list']);
    if (r.exitCode !== 0) return { labels: [], error: r.stderr.trim() || `launchctl list exit ${r.exitCode}` };
    const labels: string[] = [];
    // Output format: PID\tStatus\tLabel
    for (const line of r.stdout.split('\n')) {
      const cols = line.split('\t');
      const label = cols[2]?.trim();
      if (label && label.startsWith(prefix)) labels.push(label);
    }
    return { labels };
  } catch (err) {
    return { labels: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getSchedulerHealth(
  agents: Array<{ id: string; project: string; name: string; runner: string; schedule: string | null; enabled: boolean }>
): Promise<SchedulerHealth> {
  const expected: SchedulerExpected[] = [];
  for (const a of agents) {
    if (!a.enabled || !a.schedule) continue;
    const expectedName = a.runner === 'launchctl' ? agentLabel(a.id) : pm2Name(a.id, a.project, a.name);
    expected.push({ id: a.id, project: a.project, name: a.name, runner: a.runner, schedule: a.schedule, expectedName });
  }

  const errors: string[] = [];

  // Internal scheduler covers all PM2-runner agents. Launchctl runner is
  // independent (real OS scheduler).
  const { dumpInternalScheduler } = await import('./internal-scheduler');
  const internal = dumpInternalScheduler();
  const internalIds = new Set(internal.entries.map(e => e.agentId));

  const lcRes = await listLaunchctlAgentLabels();
  if (lcRes.error) errors.push(`launchctl: ${lcRes.error}`);
  const lcSet = new Set(lcRes.labels);

  const missing: SchedulerExpected[] = [];
  const expectedLc = new Set<string>();
  for (const e of expected) {
    if (e.runner === 'launchctl') {
      expectedLc.add(e.expectedName);
      if (!lcSet.has(e.expectedName)) missing.push(e);
    } else {
      if (!internalIds.has(e.id)) missing.push(e);
    }
  }

  // Internal scheduler entries with no matching enabled DB agent = orphans.
  const expectedInternalIds = new Set(
    expected.filter(e => e.runner !== 'launchctl').map(e => e.id)
  );
  const internalOrphans = internal.entries
    .filter(e => !expectedInternalIds.has(e.agentId))
    .map(e => `${e.project}/${e.name}`);

  const orphans = {
    pm2: internalOrphans,
    launchctl: lcRes.labels.filter(l => !expectedLc.has(l)),
  };

  const internalNames = internal.entries.map(e => `${e.project}/${e.name}`);

  const ok = errors.length === 0 && missing.length === 0 && orphans.pm2.length === 0 && orphans.launchctl.length === 0;
  return {
    ok,
    expected,
    actual: { pm2: internalNames, launchctl: lcRes.labels },
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
