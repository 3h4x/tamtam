import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Build a run ULID whose leading 10 chars encode `ms`, matching the decoder
// in local-world-retention.ts. The trailing 16 chars are filler (the random
// component of a real ULID — irrelevant to time decoding).
function runId(ms: number): string {
  let n = ms;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[n % 32] + time;
    n = Math.floor(n / 32);
  }
  return `wrun_${time}${'0'.repeat(16)}`;
}

const DAY = 86_400_000;

describe('pruneLocalWorldRuns', () => {
  let dir: string;
  const NOW = 1_900_000_000_000; // fixed clock
  const now = () => NOW;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tamtam-local-retention-'));
    mkdirSync(join(dir, 'runs'));
    mkdirSync(join(dir, 'steps'));
    process.env.WORKFLOW_LOCAL_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.WORKFLOW_LOCAL_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRun(id: string, fields: Record<string, unknown>): void {
    writeFileSync(join(dir, 'runs', `${id}.json`), JSON.stringify({ runId: id, ...fields }));
  }
  function writeStep(id: string, ms: number, suffix: string): void {
    writeFileSync(join(dir, 'steps', `${id}-step_${suffix}.json`), JSON.stringify({ runId: id, ms }));
  }

  it('deletes terminal runs (and their steps) completed before the cutoff', async () => {
    const oldDone = runId(NOW - 60 * DAY);
    writeRun(oldDone, { status: 'completed', completedAt: new Date(NOW - 40 * DAY).toISOString() });
    writeStep(oldDone, NOW - 50 * DAY, 'a');
    writeStep(oldDone, NOW - 45 * DAY, 'b');

    const recentDone = runId(NOW - 10 * DAY);
    writeRun(recentDone, { status: 'completed', completedAt: new Date(NOW - 5 * DAY).toISOString() });
    writeStep(recentDone, NOW - 6 * DAY, 'a');

    const oldRunning = runId(NOW - 60 * DAY + 1); // distinct id, still active
    writeRun(oldRunning, { status: 'running' }); // no completedAt

    const { pruneLocalWorldRuns } = await import('@/lib/workflows/local-world-retention');
    const summary = pruneLocalWorldRuns({ retentionDays: 30, now });

    expect(summary).toMatchObject({ status: 'completed', runsDeleted: 1, stepsDeleted: 2, errorCount: 0 });
    // Old completed run + its steps gone.
    expect(existsSync(join(dir, 'runs', `${oldDone}.json`))).toBe(false);
    expect(readdirSync(join(dir, 'steps')).some((n) => n.startsWith(`${oldDone}-`))).toBe(false);
    // Recent run and old-but-active run untouched.
    expect(existsSync(join(dir, 'runs', `${recentDone}.json`))).toBe(true);
    expect(existsSync(join(dir, 'runs', `${oldRunning}.json`))).toBe(true);
    expect(readdirSync(join(dir, 'steps')).some((n) => n.startsWith(`${recentDone}-`))).toBe(true);
  });

  it('is disabled when retentionDays <= 0', async () => {
    const oldDone = runId(NOW - 60 * DAY);
    writeRun(oldDone, { status: 'completed', completedAt: new Date(NOW - 40 * DAY).toISOString() });

    const { pruneLocalWorldRuns } = await import('@/lib/workflows/local-world-retention');
    const summary = pruneLocalWorldRuns({ retentionDays: 0, now });

    expect(summary.status).toBe('disabled');
    expect(summary.runsDeleted).toBe(0);
    expect(existsSync(join(dir, 'runs', `${oldDone}.json`))).toBe(true);
  });

  it('returns cleanly when the runs dir does not exist', async () => {
    rmSync(join(dir, 'runs'), { recursive: true, force: true });
    const { pruneLocalWorldRuns } = await import('@/lib/workflows/local-world-retention');
    const summary = pruneLocalWorldRuns({ retentionDays: 30, now });
    expect(summary.status).toBe('completed');
    expect(summary.runsDeleted).toBe(0);
  });
});

describe('decodeUlidTimeMs', () => {
  it('round-trips an encoded timestamp', async () => {
    const { decodeUlidTimeMs } = await import('@/lib/workflows/local-world-retention');
    const ms = 1_899_999_999_999;
    expect(decodeUlidTimeMs(runId(ms))).toBe(ms);
  });
  it('returns null for non-ULID names', async () => {
    const { decodeUlidTimeMs } = await import('@/lib/workflows/local-world-retention');
    expect(decodeUlidTimeMs('legacy')).toBeNull();
  });
});
