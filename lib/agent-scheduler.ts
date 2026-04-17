import { writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from './shell';
import { getSettings } from './config';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const SCRIPTS_DIR = join(homedir(), 'logs', 'agent-scripts');

function parseScheduleToSeconds(schedule: string): number {
  const s = schedule.trim();
  if (s.endsWith('h')) return parseInt(s.slice(0, -1), 10) * 3600;
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) * 60;
  return parseInt(s, 10);
}

function parseScheduleToCron(schedule: string): string {
  const s = schedule.trim();
  if (s.endsWith('m')) {
    const mins = parseInt(s.slice(0, -1), 10);
    if (mins < 60) return `*/${mins} * * * *`;
    // Fall through to hours
    const hours = Math.floor(mins / 60);
    return `0 */${hours} * * *`;
  }
  if (s.endsWith('h')) {
    const hours = parseInt(s.slice(0, -1), 10);
    return `0 */${hours} * * *`;
  }
  // Assume seconds, convert to nearest minute
  const secs = parseInt(s, 10);
  const mins = Math.max(1, Math.round(secs / 60));
  return `*/${mins} * * * *`;
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
  return join(SCRIPTS_DIR, `${agentId}.sh`);
}

function agentPromptPath(agentId: string): string {
  return join(SCRIPTS_DIR, `${agentId}.prompt.json`);
}

function buildScript(agentId: string): string {
  const token = process.env.Z_API_TOKEN || '';
  const authFlag = token ? `-H "Authorization: Bearer ${token}"` : '';
  const port = process.env.PORT || '1337';
  const url = `http://localhost:${port}/api/agents/${agentId}/run`;
  const promptFile = agentPromptPath(agentId);

  return `#!/bin/bash
/usr/bin/curl -s -X POST ${authFlag} -H "Content-Type: application/json" -d @"${promptFile}" "${url}"
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
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  mkdirSync(join(homedir(), 'logs'), { recursive: true });
}

function writeScriptAndPrompt(agentId: string, prompt: string): void {
  writeFileSync(agentPromptPath(agentId), JSON.stringify({ prompt }));
  writeFileSync(agentScriptPath(agentId), buildScript(agentId));
  chmodSync(agentScriptPath(agentId), 0o755);
}

function cleanupFiles(agentId: string): void {
  const script = agentScriptPath(agentId);
  if (existsSync(script)) unlinkSync(script);
  const promptFile = agentPromptPath(agentId);
  if (existsSync(promptFile)) unlinkSync(promptFile);
}

// --- PM2 scheduling ---

async function installPm2Schedule(agentId: string, schedule: string, prompt: string, project?: string, agentName?: string): Promise<void> {
  ensureDirs();

  // Stop existing if present
  await uninstallPm2Schedule(agentId, project, agentName);

  writeScriptAndPrompt(agentId, prompt);

  const name = pm2Name(agentId, project, agentName);
  const cron = parseScheduleToCron(schedule);
  const scriptPath = agentScriptPath(agentId);

  await exec('pm2', ['start', scriptPath, '--name', name, '--no-autorestart', '--cron', cron]);
}

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

// --- Public API ---

export async function installAgentSchedule(
  agentId: string,
  schedule: string,
  prompt: string,
  runner: string = 'pm2',
  project?: string,
  agentName?: string
): Promise<void> {
  if (runner === 'launchctl') {
    await installLaunchctlSchedule(agentId, schedule, prompt);
  } else {
    await installPm2Schedule(agentId, schedule, prompt, project, agentName);
  }
}

export async function uninstallAgentSchedule(agentId: string, runner: string = 'pm2', project?: string, agentName?: string): Promise<void> {
  if (runner === 'launchctl') {
    await uninstallLaunchctlSchedule(agentId);
  } else {
    await uninstallPm2Schedule(agentId, project, agentName);
  }
}

export async function isAgentScheduleLoaded(agentId: string, runner: string = 'pm2', project?: string, agentName?: string): Promise<boolean> {
  if (runner === 'launchctl') {
    return isLaunchctlScheduleLoaded(agentId);
  }
  return isPm2ScheduleLoaded(agentId, project, agentName);
}
