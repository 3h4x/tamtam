import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { exec } from '@/lib/shared/shell';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const WRAPPER_DIR = join(homedir(), '.local', 'share', 'z-improve');
const PAUSED_DIR = join(WRAPPER_DIR, 'paused');

function launchAgentLabel(project: string): string {
  const owner = process.env.LAUNCHAGENT_PREFIX || 'com.tamtam';
  return `${owner}.improve.${project}`;
}

export function plistPath(project: string): string {
  return join(LAUNCH_AGENTS_DIR, `${launchAgentLabel(project)}.plist`);
}

function wrapperPath(project: string): string {
  return join(WRAPPER_DIR, `z.${project}`);
}

export function pausedPlistPath(project: string): string {
  return join(PAUSED_DIR, basename(plistPath(project)));
}

export async function pauseAll(projects: string[]): Promise<void> {
  const { mkdirSync, renameSync } = await import('fs');
  mkdirSync(PAUSED_DIR, { recursive: true });
  for (const project of projects) {
    const plist = plistPath(project);
    if (existsSync(plist)) {
      await exec('launchctl', ['unload', plist]);
      renameSync(plist, pausedPlistPath(project));
    }
  }
}

export async function resumeAll(projects: string[]): Promise<void> {
  const { renameSync } = await import('fs');
  for (const project of projects) {
    const paused = pausedPlistPath(project);
    if (existsSync(paused)) {
      const plist = plistPath(project);
      renameSync(paused, plist);
      await exec('launchctl', ['load', plist]);
    }
  }
}

export interface LaunchctlInfo {
  loaded: boolean;
  pid: number | null;
  lastExit: number | null;
  plistMinute: number | null;
  wrapperPhase: number | null;
  wrapperCycle: number | null;
}

export async function launchctlInfo(project: string): Promise<LaunchctlInfo> {
  const label = launchAgentLabel(project);
  const result = await exec('launchctl', ['list', label]);

  const info: LaunchctlInfo = {
    loaded: result.exitCode === 0,
    pid: null,
    lastExit: null,
    plistMinute: null,
    wrapperPhase: null,
    wrapperCycle: null,
  };

  if (result.exitCode === 0) {
    // `launchctl list <label>` output varies by macOS version and can emit
    // either `PID = 123;` or `"PID" = 123;` style keys.
    const pidMatch = result.stdout.match(/"?PID"?\s*=\s*(\d+)/);
    const exitMatch = result.stdout.match(/"?LastExitStatus"?\s*=\s*(\d+)/);
    if (pidMatch) info.pid = parseInt(pidMatch[1], 10);
    if (exitMatch) info.lastExit = parseInt(exitMatch[1], 10);
  }

  const plist = plistPath(project);
  if (existsSync(plist)) {
    const content = readFileSync(plist, 'utf-8');
    const minMatch = content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    if (minMatch) info.plistMinute = parseInt(minMatch[1], 10);
  }

  const wrapper = wrapperPath(project);
  if (existsSync(wrapper)) {
    const content = readFileSync(wrapper, 'utf-8');
    const phaseMatch = content.match(/Run every (\d+)h \(phase (\d+)\)/);
    if (phaseMatch) {
      info.wrapperCycle = parseInt(phaseMatch[1], 10);
      info.wrapperPhase = parseInt(phaseMatch[2], 10);
    }
  }

  return info;
}
