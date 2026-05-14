import { sql } from 'drizzle-orm';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPgDbEmpty, type TestDbHandle } from '../../../helpers/test-db';
import * as schema from '@/lib/db/schema';

let sharedHandle: TestDbHandle;

describe('PgvectorBackend', () => {
  beforeEach(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await sharedHandle.db.execute(sql.raw(`
      CREATE TABLE retrieval_chunks (
        id serial PRIMARY KEY,
        chunk_id text NOT NULL UNIQUE,
        project text NOT NULL,
        source_kind text NOT NULL,
        source_id text NOT NULL,
        chunk_index integer NOT NULL,
        text text NOT NULL,
        metadata text NOT NULL,
        embedding text
      )
    `));

    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  });

  afterEach(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  it('counts rows for a filtered source kind list', async () => {
    const { PgvectorBackend } = await import('@/lib/agents/retrieval/pgvector-backend');
    const backend = new PgvectorBackend();

    await sharedHandle.db.execute(sql.raw(`
      INSERT INTO retrieval_chunks (chunk_id, project, source_kind, source_id, chunk_index, text, metadata, embedding)
      VALUES
        ('project_doc:1:0', 'myproject', 'project_doc', '1', 0, 'doc chunk', '{}', NULL),
        ('skill:2:0', 'myproject', 'skill', '2', 0, 'skill chunk', '{}', NULL),
        ('agent_run:3:0', 'myproject', 'agent_run', '3', 0, 'run chunk', '{}', NULL),
        ('project_doc:4:0', 'otherproject', 'project_doc', '4', 0, 'other chunk', '{}', NULL)
    `));

    await expect(backend.countProjectChunks('myproject', ['project_doc', 'skill'])).resolves.toBe(2);
  });
});
