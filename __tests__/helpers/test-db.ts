import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { join } from 'path';
import * as schema from '@/lib/db/schema';

export interface TestDbHandle {
  db: PgliteDatabase<typeof schema>;
  raw: PGlite;
  [Symbol.asyncDispose](): Promise<void>;
}

async function bootPGlite(): Promise<TestDbHandle> {
  const raw = new PGlite({ extensions: { vector } });
  await raw.waitReady;
  const db = drizzle(raw, { schema });
  return {
    db,
    raw,
    async [Symbol.asyncDispose]() {
      await raw.close();
    },
  };
}

/**
 * Boot a PGlite instance and apply the full production migration set.
 * Use for tests that touch many tables or rely on real defaults/FKs.
 */
export async function createTestPgDb(): Promise<TestDbHandle> {
  const handle = await bootPGlite();
  await migrate(handle.db, { migrationsFolder: join(process.cwd(), 'lib/db/migrations') });
  return handle;
}

/**
 * Boot a PGlite instance with no schema applied. The caller provides DDL
 * directly via `db.execute(sql.raw(...))`. Mirrors the legacy per-test
 * `createTestDb()` pattern where tests build only the tables they need.
 *
 * The `vector` extension is still loaded (PGlite has it preinstalled in the
 * extensions option) but not yet CREATE'd; tests that need it can do so
 * explicitly via `await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'))`.
 */
export async function createTestPgDbEmpty(): Promise<TestDbHandle> {
  return bootPGlite();
}
