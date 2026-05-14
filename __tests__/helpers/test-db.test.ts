import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDb, createTestPgDbEmpty, type TestDbHandle } from './test-db';
import * as schema from '@/lib/db/schema';

describe('test-db helper', () => {
  // Two tests need a migrated DB; share the same handle to avoid paying
  // PGlite boot + migration twice. The empty-DB handle is also booted in
  // `beforeAll` so its ~700ms PGlite cold-start runs alongside the
  // migrated boot (the two `new PGlite(...)` constructors are issued
  // synchronously before either `waitReady`/`migrate` is awaited), and
  // the empty test body itself is just an assertion query.
  let fullDb: TestDbHandle;
  let emptyDb: TestDbHandle;

  beforeAll(async () => {
    [fullDb, emptyDb] = await Promise.all([createTestPgDb(), createTestPgDbEmpty()]);
  });

  afterAll(async () => {
    await Promise.all([fullDb[Symbol.asyncDispose](), emptyDb[Symbol.asyncDispose]()]);
  });

  it('createTestPgDb applies full schema and creates the vector extension', async () => {
    const tables = await fullDb.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const names = (tables.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(names).toContain('settings');
    expect(names).toContain('agents');
    expect(names).toContain('retrieval_chunks');
    const ext = await fullDb.db.execute(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(ext.rows).toHaveLength(1);
  });

  it('createTestPgDbEmpty boots a Postgres with no public tables', async () => {
    const tables = await emptyDb.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    expect(tables.rows).toHaveLength(0);
  });

  it('round-trips a row through drizzle', async () => {
    await fullDb.db.insert(schema.settings).values({ key: 'roundtrip-k', value: 'v' });
    const rows = await fullDb.db
      .select()
      .from(schema.settings)
      .where(sql`${schema.settings.key} = 'roundtrip-k'`);
    expect(rows).toEqual([{ key: 'roundtrip-k', value: 'v' }]);
  });
});
