import { exec } from '@/lib/shared/shell';
import { readFile } from 'fs/promises';
import { join } from 'path';

function parseNumstatTotal(stdout: string): number {
  let total = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [added, removed] = trimmed.split('\t');
    if (added === '-' || removed === '-') continue; // binary
    const a = Number.parseInt(added, 10);
    const d = Number.parseInt(removed, 10);
    if (Number.isFinite(a)) total += a;
    if (Number.isFinite(d)) total += d;
  }
  return total;
}

function countTextLines(buf: Buffer): number {
  if (buf.includes(0)) return 0;
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) {
    if (byte === 10) lines += 1;
  }
  return buf[buf.length - 1] === 10 ? lines : lines + 1;
}

async function untrackedLineDelta(projPath: string): Promise<number> {
  const r = await exec('git', ['-C', projPath, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 10000 });
  if (r.exitCode !== 0 || !r.stdout) return 0;

  let total = 0;
  for (const relPath of r.stdout.split('\0')) {
    if (!relPath) continue;
    try {
      const buf = await readFile(/*turbopackIgnore: true*/ join(projPath, relPath));
      total += countTextLines(buf);
    } catch {
      // Directory entries, races, and unreadable files contribute no LOC.
    }
  }
  return total;
}

/**
 * Cumulative uncommitted line delta (added + removed) across the entire
 * working tree, measured by `git diff --numstat HEAD` for tracked changes
 * plus direct line counts for untracked files. Binary rows / files contribute
 * 0. Returns 0 on a clean tree or when git fails — a conservative
 * "below threshold" signal that never blocks a release on its own (the caller
 * only consults this when a threshold is set).
 */
export async function worktreeLineDelta(projPath: string): Promise<number> {
  const r = await exec('git', ['-C', projPath, 'diff', '--numstat', 'HEAD'], { timeout: 10000 });
  if (r.exitCode !== 0) return 0;
  return parseNumstatTotal(r.stdout) + await untrackedLineDelta(projPath);
}
