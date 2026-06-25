import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const mockState = vi.hoisted(() => ({
  dbHolder: { db: null as unknown as TestDbHandle['db'] },
}));

vi.mock('@/lib/db', async () => {
  const realSchema = await vi.importActual<typeof import('@/lib/db/schema')>('@/lib/db/schema');
  return {
    get db() {
      return mockState.dbHolder.db;
    },
    schema: realSchema,
  };
});

import {
  checkDailySpendCap,
  checkReleaseSpendCap,
  getProjectDailySpendUsd,
  getReleaseSpendUsd,
} from '@/lib/pipeline/spend-guard';

let handle: TestDbHandle;

async function applySchema() {
  await handle.db.execute(sql.raw(`
    CREATE TABLE projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      daily_spend_cap_usd double precision,
      release_spend_cap_usd double precision
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      pid integer NOT NULL,
      started_at double precision NOT NULL,
      finished_at double precision,
      cost_usd double precision,
      release_id text
    )
  `));
}

beforeAll(async () => {
  handle = await createTestPgDbEmpty();
  mockState.dbHolder.db = handle.db;
  await applySchema();
});

afterAll(async () => {
  await handle[Symbol.asyncDispose]();
});

beforeEach(async () => {
  await handle.db.execute(sql.raw('TRUNCATE jobs, projects'));
});

describe('spend guard', () => {
  it('sums rolling 24h project spend and ignores older rows', async () => {
    const nowMs = 2_000_000_000;
    await handle.db.execute(sql.raw(`INSERT INTO projects (name, path) VALUES ('p', '/p')`));
    await handle.db.execute(sql.raw(`
      INSERT INTO jobs (id, project, kind, pid, started_at, cost_usd)
      VALUES
        ('new-1', 'p', 'review', 1, ${(nowMs / 1000) - 60}, 1.25),
        ('new-2', 'p', 'fix', 1, ${(nowMs / 1000) - 3600}, 2.50),
        ('old-1', 'p', 'review', 1, ${(nowMs / 1000) - 90000}, 99.00)
    `));

    await expect(getProjectDailySpendUsd('p', nowMs)).resolves.toBeCloseTo(3.75, 4);
  });

  it('blocks when the rolling daily cap is reached', async () => {
    const nowMs = 2_000_000_000;
    await handle.db.execute(sql.raw(`INSERT INTO projects (name, path, daily_spend_cap_usd) VALUES ('p', '/p', 3.75)`));
    await handle.db.execute(sql.raw(`INSERT INTO jobs (id, project, kind, pid, started_at, cost_usd) VALUES ('j1', 'p', 'review', 1, ${(nowMs / 1000) - 60}, 3.75)`));

    const result = await checkDailySpendCap('p', nowMs);

    expect(result).toMatchObject({
      ok: false,
      kind: 'daily',
      project: 'p',
      capUsd: 3.75,
      actualUsd: 3.75,
    });
  });

  it('does not block when caps are unset or zero', async () => {
    await handle.db.execute(sql.raw(`INSERT INTO projects (name, path, daily_spend_cap_usd, release_spend_cap_usd) VALUES ('p', '/p', 0, NULL)`));
    await handle.db.execute(sql.raw(`INSERT INTO jobs (id, project, kind, pid, started_at, cost_usd, release_id) VALUES ('j1', 'p', 'review', 1, 100, 99, 'rel')`));

    await expect(checkDailySpendCap('p', 200_000)).resolves.toEqual({ ok: true });
    await expect(checkReleaseSpendCap('p', 'rel')).resolves.toEqual({ ok: true });
  });

  it('blocks when a release reaches its per-release cap', async () => {
    await handle.db.execute(sql.raw(`INSERT INTO projects (name, path, release_spend_cap_usd) VALUES ('p', '/p', 5)`));
    await handle.db.execute(sql.raw(`
      INSERT INTO jobs (id, project, kind, pid, started_at, cost_usd, release_id)
      VALUES
        ('review-1', 'p', 'review', 1, 100, 2, 'rel'),
        ('fix-1', 'p', 'fix', 1, 200, 3, 'rel'),
        ('other', 'p', 'review', 1, 300, 9, 'other-rel')
    `));

    await expect(getReleaseSpendUsd('rel')).resolves.toBeCloseTo(5, 4);
    const result = await checkReleaseSpendCap('p', 'rel');

    expect(result).toMatchObject({
      ok: false,
      kind: 'release',
      project: 'p',
      releaseId: 'rel',
      capUsd: 5,
      actualUsd: 5,
    });
  });
});
