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

// Pending background snapshot writes. `[Symbol.asyncDispose]` awaits the
// matching entry (if any) before closing the PGlite, so the cache is
// reliably populated even when the caller disposes immediately after the
// helper returns.
const pendingDumps = new WeakMap<PGlite, Promise<void>>();

// PGlite WASM cold start is ~700-1000ms per instance. Snapshotting a freshly
// booted PGlite via `dumpDataDir` and restoring with `loadDataDir` cuts a
// subsequent boot to ~250-400ms. We persist the snapshot to a per-version,
// per-migration-hash file under the OS tmpdir so consecutive `pnpm test`
// invocations and parallel vitest workers can share it. The snapshot is
// written in the background after the handle is returned, so the first
// call in a session is no slower than the original cold-boot path.
const MIGRATIONS_DIR = join(process.cwd(), 'lib/db/migrations');
const CACHE_DIR = join(tmpdir(), 'tamtam-pglite-cache-v1');

let cachedMigrationsHash: string | null = null;
let cachedRequiredPublicTables: string[] | null = null;

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

function cachePath(kind: 'empty' | 'migrated'): string {
  return join(CACHE_DIR, `${kind}-${getMigrationsHash()}.tar`);
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

function persistSnapshotInBackground(file: string, raw: PGlite): void {
  // Kick off the dump SYNCHRONOUSLY so the dump command is enqueued on
  // PGlite's WASM thread before the caller has a chance to issue any
  // subsequent queries against `raw`. This guarantees the snapshot
  // captures the state at the moment this function was called, not
  // some later mutated state.
  //
  // The returned promise resolves with the disk-write completing; we
  // store it in `pendingDumps` so `[Symbol.asyncDispose]` can await it.
  if (existsSync(file)) {
    pendingDumps.set(raw, Promise.resolve());
    return;
  }
  const dumpPromise = raw.dumpDataDir();
  const work = (async () => {
    try {
      const dump = await dumpPromise;
      await writeSnapshotAsync(file, dump);
    } catch {
      // best-effort
    }
  })();
  pendingDumps.set(raw, work);
}

function makeHandle(raw: PGlite): TestDbHandle {
  const db = drizzle(raw, { schema });
  return {
    db,
    raw,
    async [Symbol.asyncDispose]() {
      // If a background snapshot dump is in flight, wait for it before
      // closing so the cache reliably populates.
      const pending = pendingDumps.get(raw);
      if (pending) {
        try {
          await pending;
        } catch {
          // ignore
        }
        pendingDumps.delete(raw);
      }
      await raw.close();
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

async function removeSnapshot(file: string): Promise<void> {
  try {
    unlinkSync(file);
  } catch {
    // Cache cleanup is best-effort. A failed unlink just means the next
    // caller may also reject the same invalid snapshot and rebuild locally.
  }
}

/**
 * Boot a PGlite instance and apply the full production migration set.
 * Use for tests that touch many tables or rely on real defaults/FKs.
 *
 * Uses a disk-cached snapshot keyed by the migrations folder hash; first
 * call pays the cold boot + migrate cost and writes a snapshot in the
 * background, subsequent runs restore from the snapshot (~250-400ms vs
 * ~1000ms cold).
 */
export async function createTestPgDb(): Promise<TestDbHandle> {
  const file = cachePath('migrated');
  const cached = readSnapshot(file);
  if (cached) {
    const handle = await bootPGliteFromSnapshot(cached);
    if (await isMigratedSnapshotCurrent(handle)) return handle;
    await handle[Symbol.asyncDispose]();
    await removeSnapshot(file);
  }

  const handle = await bootPGlite();
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  persistSnapshotInBackground(file, handle.raw);
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
 *
 * Uses the same disk-snapshot strategy as `createTestPgDb`, with a separate
 * cache file for the no-migrations variant.
 */
export async function createTestPgDbEmpty(): Promise<TestDbHandle> {
  const file = cachePath('empty');
  const cached = readSnapshot(file);
  if (cached) return bootPGliteFromSnapshot(cached);

  const handle = await bootPGlite();
  persistSnapshotInBackground(file, handle.raw);
  return handle;
}
