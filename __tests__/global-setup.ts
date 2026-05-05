import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

export default function globalSetup() {
  if (process.env.TAMTAM_DB_PATH) {
    throw new Error(
      `Refusing to run Vitest with ambient TAMTAM_DB_PATH=${process.env.TAMTAM_DB_PATH}. ` +
      'Unit tests must use the dedicated throwaway DB from __tests__/global-setup.ts. ' +
      'If a child-process test needs a specific DB path, pass TAMTAM_DB_PATH explicitly to that spawned process instead of pre-setting it for the whole Vitest run.'
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'tamtam-vitest-db-'));
  const dbPath = join(dir, 'tamtam.db');
  process.env.TAMTAM_DB_PATH = dbPath;

  // Seed the fallback sqlite path with the full Drizzle schema so tests that
  // touch the real db module do not depend on the developer's local database.
  const sqlite = new Database(dbPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: join(__dirname, '..', 'lib', 'db', 'migrations') });
  } finally {
    sqlite.close();
  }
}
