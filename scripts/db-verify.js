#!/usr/bin/env node

const Database = require('better-sqlite3');
const { join } = require('path');

const dbPath = process.argv[2] || process.env.TAMTAM_DB_PATH || join(process.cwd(), 'data', 'db', 'tamtam.db');
let sqlite;

try {
  sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  const integrityRows = sqlite.pragma('integrity_check');
  const integrity = integrityRows.map((row) => Object.values(row)[0]).filter(Boolean);
  if (integrity.length !== 1 || integrity[0] !== 'ok') {
    throw new Error(`integrity_check failed: ${integrity.join('; ') || 'no result'}`);
  }

  const foreignKeyRows = sqlite.pragma('foreign_key_check');
  if (foreignKeyRows.length > 0) {
    throw new Error(`foreign_key_check failed: ${foreignKeyRows.length} violation(s)`);
  }

  console.log(`Database verified: ${dbPath}`);
} catch (error) {
  console.error(`Database verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (sqlite) sqlite.close();
}
