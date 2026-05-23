import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

const PREFIX = 'default_dirty_commit_recovery:';

export const DEFAULT_DIRTY_COMMIT_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

interface DefaultDirtyCommitRecoveryMarker {
  status: string;
  failedAt: number;
  commitJobId: string;
}

function keyFor(project: string): string {
  return `${PREFIX}${project}`;
}

export function normalizeDirtyStatusForRecovery(status: string): string {
  return status
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort()
    .join('\n');
}

function pathFromPorcelainLine(line: string): string | null {
  if (line.length < 4) return null;
  let path = line.slice(3);
  if (!path || path.startsWith('"')) return null;
  const renameSeparator = ' -> ';
  const renameIndex = path.lastIndexOf(renameSeparator);
  if (renameIndex >= 0) path = path.slice(renameIndex + renameSeparator.length);
  return path || null;
}

function dirtyStatusPaths(status: string): string[] | null {
  const paths: string[] = [];
  for (const line of normalizeDirtyStatusForRecovery(status).split('\n')) {
    if (!line) continue;
    const path = pathFromPorcelainLine(line);
    if (!path) return null;
    paths.push(path);
  }
  return paths;
}

function pathTreeNotNewerThanMarker(fullPath: string, maxMtimeMs: number): boolean {
  const stat = statSync(/*turbopackIgnore: true*/ fullPath);
  if (stat.mtimeMs > maxMtimeMs) return false;
  if (!stat.isDirectory()) return true;
  for (const entry of readdirSync(/*turbopackIgnore: true*/ fullPath, { withFileTypes: true })) {
    if (!pathTreeNotNewerThanMarker(join(/*turbopackIgnore: true*/ fullPath, entry.name), maxMtimeMs)) {
      return false;
    }
  }
  return true;
}

function dirtyFilesNotNewerThanMarker(projPath: string, status: string, failedAt: number): boolean {
  const paths = dirtyStatusPaths(status);
  if (!paths) return false;
  const maxMtimeMs = failedAt + 1000;
  for (const relPath of paths) {
    const fullPath = join(/*turbopackIgnore: true*/ projPath, relPath);
    if (!existsSync(/*turbopackIgnore: true*/ fullPath)) continue;
    try {
      if (!pathTreeNotNewerThanMarker(fullPath, maxMtimeMs)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function parseMarker(value: string): DefaultDirtyCommitRecoveryMarker | null {
  try {
    const parsed = JSON.parse(value) as Partial<DefaultDirtyCommitRecoveryMarker>;
    if (typeof parsed.status !== 'string') return null;
    if (typeof parsed.failedAt !== 'number' || !Number.isFinite(parsed.failedAt)) return null;
    if (typeof parsed.commitJobId !== 'string' || !parsed.commitJobId) return null;
    return {
      status: parsed.status,
      failedAt: parsed.failedAt,
      commitJobId: parsed.commitJobId,
    };
  } catch {
    return null;
  }
}

export async function setDefaultDirtyCommitRecoveryMarker(
  project: string,
  status: string,
  commitJobId: string,
  failedAt: number = Date.now(),
): Promise<void> {
  const normalizedStatus = normalizeDirtyStatusForRecovery(status);
  if (!normalizedStatus) return;
  const value = JSON.stringify({ status: normalizedStatus, failedAt, commitJobId });
  await db.insert(schema.settings)
    .values({ key: keyFor(project), value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .execute();
}

export async function clearDefaultDirtyCommitRecoveryMarker(project: string): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, keyFor(project))).execute();
}

export async function hasDefaultDirtyCommitRecoveryMarker(
  project: string,
  projPath: string,
  currentStatus: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const normalizedStatus = normalizeDirtyStatusForRecovery(currentStatus);
  if (!normalizedStatus) return false;
  try {
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keyFor(project)))
      .limit(1);
    const marker = rows[0]?.value ? parseMarker(rows[0].value) : null;
    if (!marker) return false;
    if (nowMs - marker.failedAt > DEFAULT_DIRTY_COMMIT_RECOVERY_TTL_MS) return false;
    if (marker.status !== normalizedStatus) return false;
    return dirtyFilesNotNewerThanMarker(projPath, normalizedStatus, marker.failedAt);
  } catch {
    return false;
  }
}
