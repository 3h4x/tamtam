import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

describe('default dirty commit recovery marker', () => {
  let handle: TestDbHandle;
  let dir: string;

  beforeEach(async () => {
    vi.resetModules();
    handle = await createTestPgDbEmpty();
    await handle.db.execute(sql.raw('CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL)'));
    vi.doMock('@/lib/db', () => ({ db: handle.db, schema }));
    dir = mkdtempSync(join(tmpdir(), 'tamtam-marker-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
    await handle[Symbol.asyncDispose]();
  });

  it('matches only the same dirty status before the marker expires', async () => {
    const file = join(dir, 'src', 'index.ts');
    writeFileSync(file, 'before');
    const failedAt = Date.parse('2026-05-23T10:00:00Z');
    utimesSync(file, failedAt / 1000 - 60, failedAt / 1000 - 60);

    const {
      DEFAULT_DIRTY_COMMIT_RECOVERY_TTL_MS,
      hasDefaultDirtyCommitRecoveryMarker,
      setDefaultDirtyCommitRecoveryMarker,
    } = await import('@/lib/pipeline/commit-recovery-marker');

    await setDefaultDirtyCommitRecoveryMarker('proj', ' M src/index.ts\n', 'commit-1', failedAt);

    await expect(
      hasDefaultDirtyCommitRecoveryMarker('proj', dir, ' M src/index.ts\n', failedAt + 1000),
    ).resolves.toBe(true);
    await expect(
      hasDefaultDirtyCommitRecoveryMarker('proj', dir, ' M src/other.ts\n', failedAt + 1000),
    ).resolves.toBe(false);
    await expect(
      hasDefaultDirtyCommitRecoveryMarker('proj', dir, ' M src/index.ts\n', failedAt + DEFAULT_DIRTY_COMMIT_RECOVERY_TTL_MS + 1),
    ).resolves.toBe(false);
  });

  it('rejects a matching dirty status when a dirty file was edited after the failed commit', async () => {
    const file = join(dir, 'src', 'index.ts');
    writeFileSync(file, 'before');
    const failedAt = Date.parse('2026-05-23T10:00:00Z');
    utimesSync(file, failedAt / 1000 - 60, failedAt / 1000 - 60);

    const {
      hasDefaultDirtyCommitRecoveryMarker,
      setDefaultDirtyCommitRecoveryMarker,
    } = await import('@/lib/pipeline/commit-recovery-marker');

    await setDefaultDirtyCommitRecoveryMarker('proj', ' M src/index.ts\n', 'commit-1', failedAt);
    utimesSync(file, failedAt / 1000 + 60, failedAt / 1000 + 60);

    await expect(
      hasDefaultDirtyCommitRecoveryMarker('proj', dir, ' M src/index.ts\n', failedAt + 120_000),
    ).resolves.toBe(false);
  });
});
