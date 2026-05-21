#!/usr/bin/env node
// Apply Drizzle migrations against the Postgres database referenced by DATABASE_URL.
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'lib', 'db', 'migrations');

// Load .env.local from the repo root so `pnpm db:migrate` picks up
// DATABASE_URL without requiring the caller to `direnv exec` or pre-export.
// Next.js loads this file automatically for the server; this script runs
// outside Next so we re-implement the same convention here.
function loadEnvLocal() {
  const path = join(__dirname, '..', '.env.local');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvLocal();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:migrate] DATABASE_URL is required (checked env and .env.local).');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool);

try {
  console.log(`[db:migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('[db:migrate] done.');
} catch (err) {
  console.error('[db:migrate] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
