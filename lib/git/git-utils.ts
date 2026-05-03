import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from '@/lib/shared/shell';

const REVIEW_DIR = join(homedir(), '.cache', 'tamtam', 'schedule-reviews');

function reviewStatePath(project: string): string {
  return join(REVIEW_DIR, `${project}.hash`);
}

type ReviewStamp = {
  version: 1;
  statusHash: string;
  headSha: string;
  upstreamSha: string | null;
};

type StoredReviewStamp =
  | { kind: 'current'; stamp: ReviewStamp }
  | { kind: 'legacy'; statusHash: string };

export async function gitStatusHash(path: string): Promise<string | null> {
  const result = await exec('git', ['-C', path, 'status', '--porcelain', '--ignore-submodules'], {
    timeout: 5000,
  });
  if (result.exitCode !== 0) return null;
  return createHash('sha1').update(result.stdout).digest('hex');
}

async function gitHeadSha(path: string): Promise<string | null> {
  const result = await exec('git', ['-C', path, 'rev-parse', 'HEAD'], { timeout: 5000 });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

async function gitUpstreamSha(path: string): Promise<string | null> {
  const result = await exec('git', ['-C', path, 'rev-parse', '@{u}'], { timeout: 5000 });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

async function readReviewStamp(path: string): Promise<ReviewStamp | null> {
  const [statusHash, headSha, upstreamSha] = await Promise.all([
    gitStatusHash(path),
    gitHeadSha(path),
    gitUpstreamSha(path),
  ]);
  if (!statusHash || !headSha) return null;
  return { version: 1, statusHash, headSha, upstreamSha };
}

function parseStoredReviewStamp(raw: string): StoredReviewStamp | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<ReviewStamp>;
    if (
      parsed?.version === 1
      && typeof parsed.statusHash === 'string'
      && typeof parsed.headSha === 'string'
      && Object.prototype.hasOwnProperty.call(parsed, 'upstreamSha')
    ) {
      return { kind: 'current', stamp: parsed as ReviewStamp };
    }
  } catch {
    // Fall through to the legacy plain-hash format.
  }
  return { kind: 'legacy', statusHash: trimmed };
}

function migrateLegacyReviewStamp(path: string, stamp: ReviewStamp): void {
  try {
    writeFileSync(path, JSON.stringify(stamp));
  } catch {
    // Best effort only. A failed migration should not block the caller.
  }
}

export async function markReviewed(project: string, path: string): Promise<void> {
  const stamp = await readReviewStamp(path);
  if (!stamp) return;
  mkdirSync(REVIEW_DIR, { recursive: true });
  writeFileSync(reviewStatePath(project), JSON.stringify(stamp));
}

export async function isReviewed(project: string, path: string): Promise<boolean> {
  const p = reviewStatePath(project);
  if (!existsSync(p)) return false;
  const current = await readReviewStamp(path);
  if (!current) return false;
  try {
    const storedRaw = readFileSync(p, 'utf-8').trim();
    const stored = parseStoredReviewStamp(storedRaw);
    if (!stored) return false;
    if (stored.kind === 'legacy') {
      const matches = stored.statusHash === current.statusHash;
      if (matches) migrateLegacyReviewStamp(p, current);
      return matches;
    }
    return stored.stamp.statusHash === current.statusHash
      && stored.stamp.headSha === current.headSha
      && stored.stamp.upstreamSha === current.upstreamSha;
  } catch {
    return false;
  }
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
