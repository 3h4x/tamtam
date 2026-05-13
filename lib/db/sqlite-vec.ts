import type Database from 'better-sqlite3';
import { createRequire } from 'module';

type SqliteVecModule = {
  load(db: Database.Database): void;
};

const require = createRequire(import.meta.url);
const SQLITE_VEC_UNAVAILABLE_DETAIL =
  'Retrieval is unavailable: sqlite-vec is not installed in this environment';

function resolveSqliteVec(): SqliteVecModule | null {
  try {
    return require('sqlite-vec') as SqliteVecModule;
  } catch {
    return null;
  }
}

export function isSqliteVecAvailable(): boolean {
  return resolveSqliteVec() !== null;
}

export function getSqliteVecUnavailableDetail(): string {
  return SQLITE_VEC_UNAVAILABLE_DETAIL;
}

export function loadSqliteVec(db: Database.Database): boolean {
  const sqliteVec = resolveSqliteVec();
  if (!sqliteVec) return false;
  sqliteVec.load(db);
  return true;
}
