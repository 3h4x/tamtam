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

// Incremental review marker — pinned as a real git ref under refs/tamtam/reviewed/<branch>
// rather than a filesystem fingerprint so it lives in the repo, survives clones,
// and is introspectable with `git log refs/tamtam/reviewed/<branch>..HEAD`.

const REVIEWED_REF_PREFIX = 'refs/tamtam/reviewed/';

function reviewedRefName(branch: string): string {
  return `${REVIEWED_REF_PREFIX}${branch}`;
}

export async function getCurrentBranch(path: string): Promise<string | null> {
  const r = await exec('git', ['-C', path, 'branch', '--show-current'], { timeout: 5000 });
  if (r.exitCode !== 0) return null;
  const b = r.stdout.trim();
  return b || null;
}

/** Point refs/tamtam/reviewed/<branch> at HEAD. Best-effort. */
export async function setReviewedRef(path: string, branch: string): Promise<void> {
  try {
    await exec('git', ['-C', path, 'update-ref', reviewedRefName(branch), 'HEAD'], { timeout: 5000 });
  } catch {
    // Best effort — a failed ref write should not block the pipeline.
  }
}

/** Read refs/tamtam/reviewed/<branch> sha, or null if absent. */
export async function getReviewedRefSha(path: string, branch: string): Promise<string | null> {
  const r = await exec('git', ['-C', path, 'rev-parse', '--verify', '--quiet', reviewedRefName(branch)], { timeout: 5000 });
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

/** True iff `ancestor` is an ancestor of `head` (or they are equal). */
export async function isAncestor(path: string, ancestor: string, head: string = 'HEAD'): Promise<boolean> {
  const r = await exec('git', ['-C', path, 'merge-base', '--is-ancestor', ancestor, head], { timeout: 5000 });
  return r.exitCode === 0;
}

/** Delete refs/tamtam/reviewed/<branch> — used when the marker is stale (rebased past). */
export async function clearReviewedRef(path: string, branch: string): Promise<void> {
  try {
    await exec('git', ['-C', path, 'update-ref', '-d', reviewedRefName(branch)], { timeout: 5000 });
  } catch {
    // Ignore — best-effort cleanup.
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
