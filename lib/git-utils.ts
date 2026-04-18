import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from './shell';

const REVIEW_DIR = join(homedir(), '.cache', 'z', 'schedule-reviews');

function reviewStatePath(project: string): string {
  return join(REVIEW_DIR, `${project}.hash`);
}

export async function gitStatusHash(path: string): Promise<string | null> {
  const result = await exec('git', ['-C', path, 'status', '--porcelain', '--ignore-submodules'], {
    timeout: 5000,
  });
  if (result.exitCode !== 0) return null;
  return createHash('sha1').update(result.stdout).digest('hex');
}

export async function markReviewed(project: string, path: string): Promise<void> {
  const h = await gitStatusHash(path);
  if (h === null) return;
  mkdirSync(REVIEW_DIR, { recursive: true });
  writeFileSync(reviewStatePath(project), h);
}

export async function isReviewed(project: string, path: string): Promise<boolean> {
  const p = reviewStatePath(project);
  if (!existsSync(p)) return false;
  const current = await gitStatusHash(path);
  if (current === null) return false;
  const stored = readFileSync(p, 'utf-8').trim();
  return stored === current;
}

export async function gitChanges(path: string): Promise<number | null> {
  try {
    const result = await exec('git', ['-C', path, 'status', '--porcelain', '--ignore-submodules'], {
      timeout: 5000,
    });
    if (result.exitCode !== 0) return null;
    return result.stdout.split('\n').filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

export async function gitUntracked(path: string): Promise<number> {
  try {
    const result = await exec('git', ['-C', path, 'ls-files', '--others', '--exclude-standard'], {
      timeout: 5000,
    });
    if (result.exitCode !== 0) return 0;
    return result.stdout.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
