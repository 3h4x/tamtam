import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const MIGRATION_PATH = join(process.cwd(), 'lib/db/migrations/0014_rename_retrieval_maintenance.sql');

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      schedule text,
      kind text NOT NULL DEFAULT 'user'
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

async function applyRenameMigration(handle: TestDbHandle): Promise<void> {
  const migration = readFileSync(MIGRATION_PATH, 'utf-8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length === 0) continue;
    await handle.db.execute(sql.raw(trimmed));
  }
}

describe('0014 retrieval-maintenance rename migration', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE agents, jobs, settings'));
  });

  it('renames system agents while preserving operator-edited schedules', async () => {
    await sharedHandle.db.execute(sql.raw(`
      INSERT INTO agents (id, name, project, schedule, kind) VALUES
        ('system:alpha:retrieval-maintenance', 'retrieval-maintenance', 'alpha', '1h', 'system'),
        ('system:beta:retrieval-maintenance', 'retrieval-maintenance', 'beta', '30m', 'system'),
        ('system:gamma:retrieval-maintenance', 'retrieval-maintenance', 'gamma', NULL, 'system'),
        ('user-owned', 'retrieval-maintenance', 'alpha', '5m', 'user')
    `));
    await sharedHandle.db.execute(sql.raw(`
      INSERT INTO jobs (id, project, kind) VALUES
        ('job-old', 'alpha', 'agent:retrieval-maintenance'),
        ('job-other', 'alpha', 'agent:other')
    `));
    await sharedHandle.db.execute(sql.raw(`
      INSERT INTO settings (key, value) VALUES
        ('system_agent_dismissed:alpha:retrieval-maintenance', 'true'),
        ('unrelated', 'true')
    `));

    await applyRenameMigration(sharedHandle);

    const agents = await sharedHandle.db.execute(sql.raw(`
      SELECT id, name, schedule, kind FROM agents ORDER BY id
    `));
    expect(agents.rows).toEqual([
      {
        id: 'system:alpha:documentation-reindex-vectors',
        name: 'documentation-reindex-vectors',
        schedule: '16h',
        kind: 'system',
      },
      {
        id: 'system:beta:documentation-reindex-vectors',
        name: 'documentation-reindex-vectors',
        schedule: '30m',
        kind: 'system',
      },
      {
        id: 'system:gamma:documentation-reindex-vectors',
        name: 'documentation-reindex-vectors',
        schedule: null,
        kind: 'system',
      },
      {
        id: 'user-owned',
        name: 'retrieval-maintenance',
        schedule: '5m',
        kind: 'user',
      },
    ]);

    const jobs = await sharedHandle.db.execute(sql.raw(`
      SELECT id, kind FROM jobs ORDER BY id
    `));
    expect(jobs.rows).toEqual([
      { id: 'job-old', kind: 'agent:documentation-reindex-vectors' },
      { id: 'job-other', kind: 'agent:other' },
    ]);

    const settings = await sharedHandle.db.execute(sql.raw(`
      SELECT key, value FROM settings ORDER BY key
    `));
    expect(settings.rows).toEqual([
      { key: 'system_agent_dismissed:alpha:documentation-reindex-vectors', value: 'true' },
      { key: 'unrelated', value: 'true' },
    ]);
  });
});
