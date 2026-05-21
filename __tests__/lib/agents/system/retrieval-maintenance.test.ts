import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS retrieval_records (
      id text PRIMARY KEY,
      project text NOT NULL,
      source_kind text NOT NULL,
      source_id text NOT NULL,
      chunk_count integer NOT NULL,
      content_hash text NOT NULL,
      indexed_at double precision NOT NULL,
      embedding_model text
    )
  `));
}

describe('documentation-reindex-vectors helpers', () => {
  let sharedHandle: TestDbHandle;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await sharedHandle[Symbol.asyncDispose]();
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE retrieval_records'));
    vi.resetModules();
  });

  it('detectModelMismatch returns true when any record has a different model', async () => {
    await sharedHandle.db.insert(schema.retrievalRecords).values([
      { id: 'a:project_doc:CLAUDE.md', project: 'a', sourceKind: 'project_doc', sourceId: 'CLAUDE.md', chunkCount: 1, contentHash: 'h1', indexedAt: 1, embeddingModel: 'old-model' },
      { id: 'a:project_doc:README.md', project: 'a', sourceKind: 'project_doc', sourceId: 'README.md', chunkCount: 1, contentHash: 'h2', indexedAt: 2, embeddingModel: 'old-model' },
    ]);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/system/retrieval-maintenance');
    const result = await mod.__testing.detectModelMismatch('a', 'new-model');
    expect(result).toBe(true);
  });

  it('detectModelMismatch returns false when all records match the current model', async () => {
    await sharedHandle.db.insert(schema.retrievalRecords).values([
      { id: 'a:project_doc:CLAUDE.md', project: 'a', sourceKind: 'project_doc', sourceId: 'CLAUDE.md', chunkCount: 1, contentHash: 'h1', indexedAt: 1, embeddingModel: 'nomic-embed-text' },
    ]);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/system/retrieval-maintenance');
    const result = await mod.__testing.detectModelMismatch('a', 'nomic-embed-text');
    expect(result).toBe(false);
  });

  it('detectModelMismatch returns false for an empty corpus (no records)', async () => {
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/system/retrieval-maintenance');
    const result = await mod.__testing.detectModelMismatch('a', 'nomic-embed-text');
    expect(result).toBe(false);
  });

  it('detectModelMismatch ignores NULL embedding_model rows (legacy data)', async () => {
    await sharedHandle.db.insert(schema.retrievalRecords).values([
      { id: 'a:project_doc:CLAUDE.md', project: 'a', sourceKind: 'project_doc', sourceId: 'CLAUDE.md', chunkCount: 1, contentHash: 'h1', indexedAt: 1, embeddingModel: null },
    ]);

    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/system/retrieval-maintenance');
    const result = await mod.__testing.detectModelMismatch('a', 'nomic-embed-text');
    expect(result).toBe(false);
  });

  it('summarize captures wipe + reindex + verify in one line', async () => {
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/system/retrieval-maintenance');
    const text = mod.__testing.summarize({
      agentId: 'a',
      agentName: 'documentation-reindex-vectors',
      wiped: true,
      reindexStatus: 'ok',
      chunks: 12,
      indexedSources: 4,
      skippedSources: 1,
      verdict: 'ok',
      reason: 'looks healthy',
    });
    expect(text).toContain('wiped');
    expect(text).toContain('reindex: 4 indexed, 1 skipped, 12 chunks');
    expect(text).toContain('verify: ok');
    expect(text).toContain('looks healthy');
  });

  it('summarize falls back to "verifier unavailable" when verdict is null', async () => {
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    const mod = await import('@/lib/agents/system/retrieval-maintenance');
    const text = mod.__testing.summarize({
      agentId: 'a',
      agentName: 'documentation-reindex-vectors',
      wiped: false,
      reindexStatus: 'ok',
      chunks: 0,
      indexedSources: 0,
      skippedSources: 0,
      verdict: null,
      reason: 'verifier_unavailable',
    });
    expect(text).toContain('verify: skipped');
    expect(text).not.toContain('wiped');
  });
});
