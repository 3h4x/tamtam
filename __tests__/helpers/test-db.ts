import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '@/lib/db/schema';

export interface TestDbHandle {
  db: PgliteDatabase<typeof schema>;
  raw: PGlite;
  [Symbol.asyncDispose](): Promise<void>;
}

// PGlite WASM cold start is ~700-1000ms per instance. Snapshotting a freshly
// booted PGlite via `dumpDataDir` and restoring with `loadDataDir` cuts a
// subsequent boot to ~250-400ms. We persist the snapshot to a per-version,
// per-migration-hash file under the OS tmpdir so consecutive `pnpm test`
// invocations and parallel vitest workers can share it.
//
// Snapshot creation must not run against the live handle returned to tests:
// `dumpDataDir()` queues work on PGlite's single WASM thread, so a background
// dump can sit ahead of the test's first DDL/query and trip Vitest's 30s hook
// timeout under parallel full-suite load. Build snapshots with a private
// handle before returning a test handle instead.
const MIGRATIONS_DIR = join(process.cwd(), 'lib/db/migrations');
const CACHE_DIR = join(tmpdir(), 'tamtam-pglite-cache-v3');
const CACHE_LOCK_STALE_MS = 2 * 60 * 1000;
const CACHE_LOCK_WAIT_MS = 60_000;

let cachedMigrationsHash: string | null = null;
let cachedRequiredPublicTables: string[] | null = null;

type SnapshotKind = 'empty' | 'migrated';

function getMigrationsHash(): string {
  if (cachedMigrationsHash !== null) return cachedMigrationsHash;
  const hash = createHash('sha256');
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        hash.update(name);
        hash.update(readFileSync(full));
      }
    }
  }
  walk(MIGRATIONS_DIR);
  cachedMigrationsHash = hash.digest('hex').slice(0, 16);
  return cachedMigrationsHash;
}

function getRequiredPublicTables(): string[] {
  if (cachedRequiredPublicTables !== null) return cachedRequiredPublicTables;
  const names = new Set<string>();
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const entries = readdirSync(MIGRATIONS_DIR).sort();
  for (const name of entries) {
    if (!name.endsWith('.sql')) continue;
    const text = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    for (const match of text.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/gi)) {
      names.add(match[1]);
    }
  }
  cachedRequiredPublicTables = [...names].sort();
  return cachedRequiredPublicTables;
}

function cachePath(kind: SnapshotKind): string {
  return join(CACHE_DIR, `${kind}-${getMigrationsHash()}.tar`);
}

function cacheLockDir(kind: SnapshotKind): string {
  return join(CACHE_DIR, `.${kind}-snapshot-build.lock`);
}

function readSnapshot(file: string): Blob | null {
  try {
    if (!existsSync(file)) return null;
    return new Blob([readFileSync(file)]);
  } catch {
    return null;
  }
}

async function writeSnapshotAsync(file: string, dump: Blob | File): Promise<void> {
  try {
    if (existsSync(file)) return; // another run already populated the cache
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const buf = Buffer.from(await dump.arrayBuffer());
    writeFileSync(tmp, buf);
    try {
      renameSync(tmp, file);
    } catch {
      // Lost a race with another worker; ignore.
    }
  } catch {
    // Cache write is strictly best-effort; never let it break tests.
  }
}

// Instance reuse. Booting PGlite from the snapshot is ~250-400ms; resetting an
// already-booted instance (truncate / drop-schema) is ~10ms. The `db` vitest
// project runs single-worker with `isolate:false` (one fork for all db files),
// so these module-level pools persist across the whole db suite and turn ~N
// boots into a handful of reused instances. Empty and migrated are distinct
// states, so pool them separately. Reuse is safe because the migration set
// seeds no data (a fresh migrated DB == an all-tables-truncated one) and the
// pool is strictly sequential (no concurrency added — the WASM-spin risk that
// forces maxWorkers:1 is unchanged). Kill-switch: TAMTAM_TEST_DB_NO_REUSE=1.
type PoolKind = 'empty' | 'migrated';
const REUSE_ENABLED = process.env.TAMTAM_TEST_DB_NO_REUSE !== '1';
const POOL_CAP = 8;
const idlePools: Record<PoolKind, PGlite[]> = { empty: [], migrated: [] };

async function resetForReuse(raw: PGlite, kind: PoolKind): Promise<void> {
  // Best-effort clear of session-level residue (temp tables, prepared
  // statements, SET vars, cursors) a table reset alone would leave behind.
  // Non-fatal: the structural reset below is the part that actually matters, so
  // a PGlite that rejects DISCARD ALL still reuses correctly.
  try {
    await raw.exec('DISCARD ALL;');
  } catch {
    /* best effort */
  }
  if (kind === 'empty') {
    // Empty tests build their own schema; drop everything back to a bare
    // public schema (matches a freshly-booted no-migrations instance).
    await raw.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    return;
  }
  // Migrated: truncate every public table + reset identity sequences. Migrations
  // seed no rows, so this reproduces the fresh-migrated snapshot exactly. Listed
  // then truncated in one statement to avoid depending on plpgsql (`DO`).
  const res = await raw.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const names = res.rows.map((r) => `public."${r.tablename}"`);
  if (names.length > 0) {
    await raw.exec(`TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE;`);
  }
}

async function acquireFromPool(kind: PoolKind): Promise<PGlite | null> {
  while (REUSE_ENABLED && idlePools[kind].length > 0) {
    const raw = idlePools[kind].pop()!;
    try {
      await resetForReuse(raw, kind);
      return raw;
    } catch {
      // A wedged instance can't be reset cleanly — discard it and try the next
      // (or fall back to a fresh boot). Reuse must never leak dirty state.
      try { await raw.close(); } catch { /* already gone */ }
    }
  }
  return null;
}

// Non-pooling handle: closes the instance on dispose. Used for internal
// lifecycles that must NOT be reused — the snapshot builder's private handle
// and the stale-snapshot verification path (a wrong-schema instance must be
// discarded, never pooled).
function makeHandle(raw: PGlite): TestDbHandle {
  const db = drizzle(raw, { schema });
  let closed = false;
  return {
    db,
    raw,
    async [Symbol.asyncDispose]() {
      if (closed) return;
      closed = true;
      try {
        await raw.close();
      } catch (e) {
        if (e instanceof Error && /PGlite is closed/i.test(e.message)) return;
        throw e;
      }
    },
  };
}

// Pooling handle returned to tests: on dispose it returns the instance to its
// kind's idle pool for the next test instead of closing (a fresh boot). Reset
// happens lazily on the next acquire (kept out of dispose so a reset failure
// can't surface as a teardown error). Falls back to a real close when reuse is
// disabled or the pool is already at capacity (bounds a per-`beforeEach` burst).
function makePooledHandle(raw: PGlite, kind: PoolKind): TestDbHandle {
  const db = drizzle(raw, { schema });
  let closed = false;
  return {
    db,
    raw,
    async [Symbol.asyncDispose]() {
      if (closed) return;
      closed = true;
      if (REUSE_ENABLED && idlePools[kind].length < POOL_CAP) {
        idlePools[kind].push(raw);
        return;
      }
      try {
        await raw.close();
      } catch (e) {
        if (e instanceof Error && /PGlite is closed/i.test(e.message)) return;
        throw e;
      }
    },
  };
}

async function bootPGlite(): Promise<TestDbHandle> {
  const raw = new PGlite({ extensions: { vector } });
  await raw.waitReady;
  return makeHandle(raw);
}

async function bootPGliteFromSnapshot(snapshot: Blob): Promise<TestDbHandle> {
  const raw = await PGlite.create({ loadDataDir: snapshot, extensions: { vector } });
  return makeHandle(raw);
}

async function isMigratedSnapshotCurrent(handle: TestDbHandle): Promise<boolean> {
  const requiredTables = getRequiredPublicTables();
  if (requiredTables.length === 0) return true;

  try {
    const tables = await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const existing = new Set((tables.rows as Array<{ table_name: string }>).map((row) => row.table_name));
    return requiredTables.every((name) => existing.has(name));
  } catch {
    return false;
  }
}

async function isEmptySnapshotCurrent(handle: TestDbHandle): Promise<boolean> {
  try {
    const tables = await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    return tables.rows.length === 0;
  } catch {
    return false;
  }
}

async function removeSnapshot(file: string): Promise<void> {
  try {
    unlinkSync(file);
  } catch {
    // Cache cleanup is best-effort. A failed unlink just means the next
    // caller may also reject the same invalid snapshot and rebuild locally.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSnapshotBuildLock<T>(kind: SnapshotKind, work: () => Promise<T>, onLockTimeout: () => Promise<T>): Promise<T> {
  const lockDir = cacheLockDir(kind);
  const startedAt = Date.now();

  while (true) {
    try {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
      mkdirSync(lockDir);
      break;
    } catch {
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > CACHE_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > CACHE_LOCK_WAIT_MS) {
        return onLockTimeout();
      }
      await sleep(50);
    }
  }

  try {
    return await work();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function buildSnapshot(kind: SnapshotKind, file: string): Promise<void> {
  const handle = await bootPGlite();
  try {
    if (kind === 'migrated') {
      await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
    }
    const dump = await handle.raw.dumpDataDir();
    await writeSnapshotAsync(file, dump);
  } finally {
    await handle[Symbol.asyncDispose]();
  }
}

async function ensureSnapshot(kind: SnapshotKind): Promise<string | null> {
  const file = cachePath(kind);
  if (readSnapshot(file)) return file;

  const built = await withSnapshotBuildLock(kind, async () => {
    if (readSnapshot(file)) return;
    await buildSnapshot(kind, file);
  }, async () => null);
  if (built === null) return null;
  return file;
}

/**
 * Boot a PGlite instance and apply the full production migration set.
 * Use for tests that touch many tables or rely on real defaults/FKs.
 *
 * Uses a disk-cached snapshot keyed by the migrations folder hash; first
 * call pays the cold boot + migrate + dump cost on a private handle,
 * subsequent calls restore from the snapshot (~250-400ms vs ~1000ms cold).
 */
export async function createTestPgDb(): Promise<TestDbHandle> {
  const reused = await acquireFromPool('migrated');
  if (reused) return makePooledHandle(reused, 'migrated');

  const file = await ensureSnapshot('migrated');
  const cached = file ? readSnapshot(file) : null;
  if (file && cached) {
    const handle = await bootPGliteFromSnapshot(cached);
    if (await isMigratedSnapshotCurrent(handle)) return makePooledHandle(handle.raw, 'migrated');
    await handle[Symbol.asyncDispose]();
    await removeSnapshot(file);
  }

  const handle = await bootPGlite();
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  return makePooledHandle(handle.raw, 'migrated');
}

/**
 * Boot a PGlite instance with no schema applied. The caller provides DDL
 * directly via `db.execute(sql.raw(...))`. Mirrors the legacy per-test
 * `createTestDb()` pattern where tests build only the tables they need.
 *
 * The `vector` extension is still loaded (PGlite has it preinstalled in the
 * extensions option) but not yet CREATE'd; tests that need it can do so
 * explicitly via `await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'))`.
 *
 * Uses the same disk-snapshot strategy as `createTestPgDb`, with a separate
 * cache file for the no-migrations variant.
 */
export async function createTestPgDbEmpty(): Promise<TestDbHandle> {
  const reused = await acquireFromPool('empty');
  if (reused) return makePooledHandle(reused, 'empty');

  const file = await ensureSnapshot('empty');
  const cached = file ? readSnapshot(file) : null;
  if (file && cached) {
    const handle = await bootPGliteFromSnapshot(cached);
    if (await isEmptySnapshotCurrent(handle)) return makePooledHandle(handle.raw, 'empty');
    await handle[Symbol.asyncDispose]();
    await removeSnapshot(file);
  }

  const handle = await bootPGlite();
  return makePooledHandle(handle.raw, 'empty');
}

export async function prewarmTestPgDbSnapshots(): Promise<void> {
  await Promise.all([
    ensureSnapshot('empty'),
    ensureSnapshot('migrated'),
  ]);
}
