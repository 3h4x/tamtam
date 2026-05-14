#!/usr/bin/env node
// Apply Drizzle migrations against the Postgres database referenced by DATABASE_URL.
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'lib', 'db', 'migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:migrate] DATABASE_URL is required.');
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
