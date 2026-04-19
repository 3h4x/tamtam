import { writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from './shell';

const SCRIPTS_DIR = join(homedir(), 'logs', 'test-scheduler');

export function parseTestScheduleToCron(schedule: string): string {
  const s = schedule.trim();
  if (s.endsWith('m')) {
    const mins = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    if (mins < 60) return `*/${mins} * * * *`;
    const hours = Math.floor(mins / 60);
    return `0 */${hours} * * *`;
  }
  if (s.endsWith('h')) {
    const hours = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    return `0 */${hours} * * *`;
  }
  if (s.endsWith('d')) {
    const days = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    if (days === 1) return `0 0 * * *`;
    return `0 0 */${days} * *`;
  }
  // Allow raw cron expression (5 parts)
  if (s.split(/\s+/).length === 5) return s;
  throw new Error(`Invalid schedule: ${schedule} (use 30m, 1h, 6h, 1d, or cron expression)`);
}

function pm2Name(projectName: string): string {
  return `tamtam-test-${projectName}`;
}

function scriptPath(projectName: string): string {
  return join(SCRIPTS_DIR, `${projectName}.sh`);
}

function buildScript(projectName: string): string {
  const port = process.env.PORT || '1337';
  const url = `http://localhost:${port}/api/projects/by-project/${encodeURIComponent(projectName)}/test`;
  return `#!/bin/bash
/usr/bin/curl -s -X POST -H "Content-Type: application/json" "${url}"
`;
}

function ensureDirs(): void {
  mkdirSync(SCRIPTS_DIR, { recursive: true });
}

export async function installTestSchedule(projectName: string, schedule: string): Promise<void> {
  ensureDirs();
  await uninstallTestSchedule(projectName);

  const cron = parseTestScheduleToCron(schedule);
  const path = scriptPath(projectName);
  writeFileSync(path, buildScript(projectName));
  chmodSync(path, 0o755);

  await exec('pm2', ['start', path, '--name', pm2Name(projectName), '--no-autorestart', '--cron', cron]);
}

export async function uninstallTestSchedule(projectName: string): Promise<void> {
  await exec('pm2', ['delete', pm2Name(projectName)]);
  const path = scriptPath(projectName);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
}

export async function isTestScheduleLoaded(projectName: string): Promise<boolean> {
  const result = await exec('pm2', ['describe', pm2Name(projectName)]);
  return result.exitCode === 0;
}
