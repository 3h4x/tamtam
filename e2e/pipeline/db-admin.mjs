#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { Client } from 'pg';

const mode = process.argv[2];
if (mode !== 'prepare' && mode !== 'drop') {
  console.error('Usage: node e2e/pipeline/db-admin.mjs <prepare|drop>');
  process.exit(1);
}

const targetUrl = process.env.DATABASE_URL;
if (!targetUrl) {
  console.error('[e2e-db] DATABASE_URL is required.');
  process.exit(1);
}

const target = new URL(targetUrl);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!/^tamtam_e2e_pipeline/.test(dbName)) {
  console.error(`[e2e-db] refusing to manage non-e2e database: ${dbName}`);
  process.exit(1);
}

const adminUrl = new URL(process.env.E2E_PG_ADMIN_URL || targetUrl);
adminUrl.pathname = '/postgres';

const admin = new Client({ connectionString: adminUrl.toString() });

try {
  await admin.connect();
  await dropDatabase(dbName);
  if (mode === 'prepare') {
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  }
} finally {
  await admin.end().catch(() => {});
}

if (mode === 'prepare') {
  const result = spawnSync('pnpm', ['db:migrate'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: targetUrl },
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  console.log(`[e2e-db] prepared ${dbName}`);
} else {
  console.log(`[e2e-db] dropped ${dbName}`);
}

async function dropDatabase(name) {
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
}

function quoteIdent(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
