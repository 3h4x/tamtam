# Postgres-Only + Workflow-Always-On Cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every SQLite touchpoint from TamTam (production code, tests, scripts, QA stack, docs) and make the durable workflow intake path the only agent-run path by deleting the `durable_agent_workflows_enabled` flag.

**Architecture:** Branch already has Postgres schema, `pg.Pool` + `drizzle-orm/node-postgres`, pgvector-backed retrieval, and the workflow intake behind a flag. This plan completes the cutover in eight ordered phases: pgvector extension migration, one-shot data migration script, PGlite test harness, scripts cutover, QA Postgres stack, flag removal, dependency cleanup, docs sweep.

**Tech Stack:** Postgres 16 + pgvector, Drizzle ORM (`drizzle-orm/node-postgres`), `@electric-sql/pglite` for tests, `workflow` 4.2.4 + `@workflow/world-postgres` 4.1.1, Next.js 16, vitest, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-05-14-postgres-workflow-cutover-design.md`

---

## Phase 1 — pgvector extension migration

**Files:**
- Create: `lib/db/migrations/0001_pgvector.sql`
- Modify: `lib/db/migrations/meta/_journal.json`
- Create: `lib/db/migrations/meta/0001_snapshot.json` (drizzle-kit generates)

- [ ] **Step 1: Generate a custom migration**

```
pnpm drizzle-kit generate --custom --name pgvector
```

Expected: creates an empty `lib/db/migrations/0001_pgvector.sql` and appends an entry to `lib/db/migrations/meta/_journal.json`.

- [ ] **Step 2: Fill the migration body**

Replace contents of `lib/db/migrations/0001_pgvector.sql` with:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 3: Verify against a throwaway DB**

```
createdb tamtam_cutover_test 2>/dev/null || true
DATABASE_URL=postgres://$USER@localhost:5432/tamtam_cutover_test pnpm db:migrate
psql tamtam_cutover_test -c "select extname from pg_extension where extname = 'vector';"
dropdb tamtam_cutover_test
```

Expected: migration runs without error, one row with `extname = vector`.

- [ ] **Step 4: Commit**

```
git add lib/db/migrations/0001_pgvector.sql lib/db/migrations/meta/_journal.json lib/db/migrations/meta/0001_snapshot.json
git commit -m "feat(db): create pgvector extension via migration"
```

---

## Phase 2 — One-time SQLite to Postgres data migration script

**Files:**
- Create: `scripts/migrate-sqlite-to-pg.mjs`
- Create: `__tests__/scripts/migrate-sqlite-to-pg.test.ts`
- Modify: `docs/DATABASE.md` (append "One-time SQLite to Postgres migration" section)

- [ ] **Step 1: Write a failing smoke test**

Create `__tests__/scripts/migrate-sqlite-to-pg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

describe('scripts/migrate-sqlite-to-pg --help', () => {
  it('prints usage and exits 0', () => {
    const result = spawnSync('node', ['scripts/migrate-sqlite-to-pg.mjs', '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--from');
    expect(result.stdout).toContain('--truncate');
    expect(result.stdout).toContain('--dry-run');
  });
});
```

Run: `pnpm test __tests__/scripts/migrate-sqlite-to-pg.test.ts`
Expected: FAIL (script does not exist).

- [ ] **Step 2: Write the migration script**

Create `scripts/migrate-sqlite-to-pg.mjs`:

```js
#!/usr/bin/env node
/* eslint-env node */

import Database from 'better-sqlite3';
import pg from 'pg';
import { join } from 'path';
import { existsSync } from 'fs';

const { Pool } = pg;

const HELP = `Usage: node scripts/migrate-sqlite-to-pg.mjs [options]

Migrates rows from a TamTam SQLite database into the Postgres database
referenced by DATABASE_URL.

Options:
  --from <path>         Source SQLite file (default: $TAMTAM_DB_PATH or data/db/tamtam.db)
  --truncate            TRUNCATE each target table before insert
  --dry-run             Count rows that would move; perform no writes
  --only <t1,t2,...>    Migrate only the listed tables
  --help                Show this message
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const sqlitePath = args.from ?? process.env.TAMTAM_DB_PATH ?? join(process.cwd(), 'data', 'db', 'tamtam.db');
if (!existsSync(sqlitePath)) {
  console.error(`[migrate] source SQLite file not found: ${sqlitePath}`);
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate] DATABASE_URL not set');
  process.exit(1);
}

const TABLES = [
  { name: 'settings', cols: [['key'], ['value']] },
  { name: 'projects', cols: [
    ['name'], ['path'],
    ['enabled', boolCoerce], ['github'], ['priority'], ['custom_actions'], ['test_command'],
    ['tests_disabled', boolCoerce], ['review_disabled', boolCoerce],
    ['test_cron_enabled', boolCoerce], ['test_cron_schedule'],
    ['auto_commit_enabled', boolCoerce], ['auto_push_enabled', boolCoerce],
    ['auto_pr_merge_enabled', boolCoerce], ['release_after_run', boolCoerce],
    ['issue_auto_branch', boolCoerce], ['last_push_error'], ['last_push_at'],
    ['review_prompt_addendum'], ['fix_prompt_addendum'], ['website'], ['qa_url'],
    ['archived', boolCoerce], ['paused', boolCoerce],
  ] },
  { name: 'jobs', cols: [
    ['id'], ['project'], ['kind'], ['prompt'], ['pid'], ['log_path'], ['started_at'],
    ['finished_at'], ['exit_code'], ['seen', boolCoerce], ['duration_ms'],
    ['input_tokens'], ['output_tokens'], ['cache_read_tokens'], ['cache_create_tokens'],
    ['session_id'], ['user_prompt'], ['context_meta'], ['parent_job_id'],
    ['gh_issue_number'], ['gh_issue_repo'], ['gh_issue_title'],
    ['log_pruned', boolCoerce], ['verdict'], ['cost_usd'], ['model'], ['release_id'],
    ['aborted_at'], ['prompt_bytes'], ['work_summary'], ['modified_files'], ['provider'],
  ] },
  { name: 'skills', cols: [['id'], ['name'], ['description'], ['content'], ['created_at'], ['updated_at']] },
  { name: 'agents', cols: [
    ['id'], ['name'], ['project'], ['skill_ids'], ['model'], ['prompt'], ['schedule'], ['runner'],
    ['enabled', boolCoerce], ['doc_paths'], ['provider'], ['prerequisite_command'],
    ['created_at'], ['updated_at'],
  ] },
  { name: 'recommendations', cols: [
    ['id'], ['project'], ['source_kind'], ['source_id'], ['agent_id'], ['agent_name'],
    ['type'], ['title'], ['detail'], ['status'], ['payload'], ['created_at'], ['updated_at'],
  ] },
  { name: 'gh_status', cols: [
    ['project'], ['release_tag'], ['ci'], ['ci_failed_url'], ['head_sha'], ['local_head_sha'], ['fetched_at'],
  ] },
  { name: 'gh_issues_cache', cols: [['project'], ['repo'], ['prs'], ['issues'], ['fetched_at']] },
  { name: 'pipeline_locks', cols: [['project'], ['locked_by_job_id'], ['acquired_at']] },
  { name: 'queued_agent_runs', cols: [['id'], ['project'], ['agent_id'], ['agent_name'], ['triggered_by'], ['prompt'], ['enqueued_at']] },
  { name: 'notification_throttle', cols: [['key'], ['last_sent_at'], ['suppressed_count']] },
  { name: 'maintenance_status', cols: [['key'], ['value'], ['updated_at']] },
];

const onlyFilter = args.only ? new Set(args.only.split(',')) : null;
const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({ connectionString: dbUrl });

let total = 0;
try {
  for (const table of TABLES) {
    if (onlyFilter && !onlyFilter.has(table.name)) continue;
    if (!hasTable(sqlite, table.name)) {
      console.log(`[migrate] skip ${table.name}: not present in source`);
      continue;
    }
    const rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
    if (rows.length === 0) { console.log(`[migrate] ${table.name}: 0 rows`); continue; }
    if (args.dryRun) { console.log(`[migrate] ${table.name}: would move ${rows.length} rows (dry-run)`); total += rows.length; continue; }
    if (args.truncate) await pool.query(`TRUNCATE TABLE ${table.name} RESTART IDENTITY CASCADE`);

    const pkCol = pkOf(table.name);
    const colNames = table.cols.map(([c]) => c);
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
    const onConflict = args.truncate ? '' : `ON CONFLICT (${pkCol}) DO NOTHING`;
    const insertSql = `INSERT INTO ${table.name} (${colNames.join(', ')}) VALUES (${placeholders}) ${onConflict}`;

    let inserted = 0;
    for (const row of rows) {
      const values = table.cols.map(([col, coerce]) => {
        const v = row[col];
        return coerce ? coerce(v) : v;
      });
      const res = await pool.query(insertSql, values);
      inserted += res.rowCount ?? 0;
    }
    console.log(`[migrate] ${table.name}: ${inserted}/${rows.length} rows inserted`);
    total += inserted;
  }
  console.log(`[migrate] done — ${total} rows moved${args.dryRun ? ' (dry-run)' : ''}`);
} catch (err) {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  sqlite.close();
  await pool.end();
}

function boolCoerce(v) {
  if (v == null) return null;
  return v === 1 || v === '1' || v === true;
}
function hasTable(sqlite, name) {
  const row = sqlite.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
  return Boolean(row);
}
function pkOf(table) {
  const explicit = { queued_agent_runs: 'id', notification_throttle: 'key', maintenance_status: 'key', gh_status: 'project', gh_issues_cache: 'project', pipeline_locks: 'project', projects: 'name', settings: 'key' };
  return explicit[table] ?? 'id';
}
function parseArgs(argv) {
  const out = { dryRun: false, truncate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--truncate') out.truncate = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only') out.only = argv[++i];
  }
  return out;
}
```

- [ ] **Step 3: Run the smoke test**

Run: `pnpm test __tests__/scripts/migrate-sqlite-to-pg.test.ts`
Expected: PASS.

- [ ] **Step 4: Document in `docs/DATABASE.md`**

Append after the existing "DB inspection" section. Section title: "One-time SQLite to Postgres migration". Describe `--dry-run`, `--truncate`, `--only`. Note that retrieval tables are reindexed on next run.

- [ ] **Step 5: Commit**

```
git add scripts/migrate-sqlite-to-pg.mjs __tests__/scripts/migrate-sqlite-to-pg.test.ts docs/DATABASE.md
git commit -m "feat(scripts): one-shot sqlite to postgres data migration"
```

---

## Phase 3 — PGlite test harness

**Files:**
- Create: `__tests__/helpers/test-db.ts`
- Create: `__tests__/helpers/test-db.test.ts`
- Modify: `package.json` (add `@electric-sql/pglite` devDep)
- Modify: `__tests__/global-setup.ts`
- Modify: `vitest.config.ts`
- Modify: 22+ test files under `__tests__/lib/`

- [ ] **Step 1: Install PGlite**

```
pnpm add -D @electric-sql/pglite
```

Expected: `pnpm-lock.yaml` updates with `@electric-sql/pglite` ~0.3.x.

- [ ] **Step 2: Write the helper test (failing)**

Create `__tests__/helpers/test-db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestPgDb, createTestPgDbEmpty } from './test-db';
import * as schema from '@/lib/db/schema';

describe('test-db helper', () => {
  it('createTestPgDb applies full schema and supports vector extension', async () => {
    const handle = await createTestPgDb();
    const tables = await handle.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`);
    const names = tables.rows.map((r) => r.table_name as string);
    expect(names).toContain('settings');
    expect(names).toContain('agents');
    expect(names).toContain('retrieval_chunks');
    const ext = await handle.db.execute(sql`select extname from pg_extension where extname = 'vector'`);
    expect(ext.rows).toHaveLength(1);
    await handle[Symbol.asyncDispose]();
  });

  it('createTestPgDbEmpty boots a Postgres with no schema', async () => {
    const handle = await createTestPgDbEmpty();
    const tables = await handle.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    expect(tables.rows).toHaveLength(0);
    await handle[Symbol.asyncDispose]();
  });

  it('insert via drizzle round-trips a row', async () => {
    const handle = await createTestPgDb();
    await handle.db.insert(schema.settings).values({ key: 'k', value: 'v' });
    const rows = await handle.db.select().from(schema.settings);
    expect(rows).toEqual([{ key: 'k', value: 'v' }]);
    await handle[Symbol.asyncDispose]();
  });
});
```

Run: `pnpm test __tests__/helpers/test-db.test.ts`
Expected: FAIL (helper does not exist).

- [ ] **Step 3: Write the helper**

Create `__tests__/helpers/test-db.ts`:

```ts
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import * as schema from '@/lib/db/schema';
import { join } from 'path';

export interface TestDbHandle {
  db: NodePgDatabase<typeof schema>;
  raw: PGlite;
  pool: Pool;
  [Symbol.asyncDispose](): Promise<void>;
}

function makePGlitePool(raw: PGlite): Pool {
  const fakePool = {
    query: async (text: string, values?: unknown[]) => {
      const result = await raw.query(text, values ?? []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        const result = await raw.query(text, values ?? []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      release: () => {},
    }),
    end: async () => { await raw.close(); },
  } as unknown as Pool;
  return fakePool;
}

async function bootPGlite() {
  const raw = new PGlite({ extensions: { vector } });
  await raw.waitReady;
  const pool = makePGlitePool(raw);
  const db = drizzle(pool, { schema });
  return { raw, pool, db };
}

export async function createTestPgDb(): Promise<TestDbHandle> {
  const { raw, pool, db } = await bootPGlite();
  await migrate(db, { migrationsFolder: join(process.cwd(), 'lib/db/migrations') });
  return {
    db, raw, pool,
    async [Symbol.asyncDispose]() { await raw.close(); },
  };
}

export async function createTestPgDbEmpty(): Promise<TestDbHandle> {
  const { raw, pool, db } = await bootPGlite();
  return {
    db, raw, pool,
    async [Symbol.asyncDispose]() { await raw.close(); },
  };
}
```

Run: `pnpm test __tests__/helpers/test-db.test.ts`
Expected: PASS — all three sub-tests green. If the Pool shim doesn't satisfy drizzle's expected interface, iterate on `makePGlitePool` (e.g. it may need `query` to accept a config object as well as `(text, values)`); refine until the test passes.

- [ ] **Step 4: Update global setup**

Replace `__tests__/global-setup.ts`:

```ts
export default function globalSetup() {
  // Tests use PGlite via __tests__/helpers/test-db.ts. Guard against running
  // against the production Postgres if a test accidentally imports @/lib/db.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://tamtam_test@localhost:5432/tamtam_test';
  }
}
```

- [ ] **Step 5: Switch vitest config off forks**

Replace `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    globalSetup: ['./__tests__/global-setup.ts'],
    pool: 'threads',
    maxWorkers: 4,
  },
});
```

- [ ] **Step 6: Port the canonical example — `__tests__/lib/job-storage.test.ts`**

Replace the imports:

```ts
// remove:
// import Database from 'better-sqlite3';
// import { drizzle } from 'drizzle-orm/better-sqlite3';

// add:
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import { sql } from 'drizzle-orm';
```

Replace the local `createTestDb()` function with an async `beforeEach` that builds the same tables in Postgres dialect:

```ts
let handle: TestDbHandle;
let db: TestDbHandle['db'];

beforeEach(async () => {
  handle = await createTestPgDbEmpty();
  db = handle.db;
  await db.execute(sql.raw(`
    CREATE TABLE jobs (
      id text PRIMARY KEY,
      project text NOT NULL,
      kind text NOT NULL,
      pid integer NOT NULL,
      started_at double precision NOT NULL,
      finished_at double precision,
      exit_code integer,
      seen boolean DEFAULT false
      -- copy the rest of the original DDL with these type swaps:
      --   TEXT -> text, INTEGER -> integer (or boolean if it's a 0/1 column),
      --   REAL -> double precision, drop any PRAGMA lines
    );
  `));
  vi.resetModules();
  vi.doMock('@/lib/db', () => ({ db, schema }));
});

afterEach(async () => {
  await handle[Symbol.asyncDispose]();
});
```

Run: `pnpm test __tests__/lib/job-storage.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit the example port**

```
git add __tests__/helpers/test-db.ts __tests__/helpers/test-db.test.ts __tests__/global-setup.ts vitest.config.ts __tests__/lib/job-storage.test.ts package.json pnpm-lock.yaml
git commit -m "feat(tests): introduce PGlite harness, port job-storage test"
```

- [ ] **Step 8: Port the remaining lib tests in batches of 5-7**

Apply the same pattern as Step 6 to:

- `__tests__/lib/agent-conflicts.test.ts`
- `__tests__/lib/agent-run-report.test.ts`
- `__tests__/lib/agents-cache.test.ts`
- `__tests__/lib/apply-recommendation.test.ts`
- `__tests__/lib/compose-skills.test.ts`
- `__tests__/lib/config.test.ts`
- `__tests__/lib/db-bootstrap.test.ts` (use `createTestPgDb()` — applies full schema)
- `__tests__/lib/default-agent-skills.test.ts`
- `__tests__/lib/file-agent-overrides.test.ts`
- `__tests__/lib/gh-status.test.ts`
- `__tests__/lib/github-board-sync-nonfatal.test.ts`
- `__tests__/lib/issue-run-summary-backfill.test.ts`
- `__tests__/lib/job-storage-mark-dod.test.ts`
- `__tests__/lib/notifications.test.ts`
- `__tests__/lib/pending-release.test.ts`
- `__tests__/lib/pipeline-lock.test.ts`
- `__tests__/lib/project-data.test.ts`
- `__tests__/lib/recommendations.test.ts`
- `__tests__/lib/resume-stuck-release.test.ts`
- `__tests__/lib/retention.test.ts`
- `__tests__/lib/scheduling.test.ts`

For each file, port → `pnpm test __tests__/lib/<file>.test.ts` → commit in batches.

- [ ] **Step 9: Final test run**

Run: `pnpm test`
Expected: all lib tests pass. Script tests under `__tests__/scripts/` are still SQLite-mode and pass against their existing implementations; Phase 4 ports them.

---

## Phase 4 — Scripts cutover

**Files:**
- Modify: `scripts/job-runner.js`
- Modify: `scripts/db-verify.js`
- Modify: `scripts/db-restore.js`
- Modify: `scripts/find-stuck-releases.mjs`
- Modify: `scripts/issue-run-summary-utils.mjs`
- Modify: `scripts/qa-seed.mjs`
- Delete: `scripts/ensure-better-sqlite3.js`
- Delete: `__tests__/scripts/ensure-better-sqlite3.test.ts`
- Modify: `package.json` (remove `pretest`, `pretest:watch` hooks)
- Modify: corresponding test files under `__tests__/scripts/`

- [ ] **Step 1: Port `scripts/job-runner.js`**

Read lines 50-80 to find the SQLite open. Replace `require('better-sqlite3')` + the local DB construction with `pg.Client`:

```js
const { Client } = require('pg');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[job-runner] DATABASE_URL not set');
  process.exit(1);
}
const pgClient = new Client({ connectionString: databaseUrl });
await pgClient.connect();
```

Translate each prepared SQLite call to a `pgClient.query(...)` with `$1`-style placeholders. Convert 0/1 booleans to true/false. Close the client (`await pgClient.end()`) in the finally / exit handler.

Update `__tests__/scripts/job-runner.test.ts` to use `createTestPgDb()` and inject `DATABASE_URL` pointing at the PGlite-shim. Run: `pnpm test __tests__/scripts/job-runner.test.ts`. Expected: PASS.

- [ ] **Step 2: Port `scripts/db-verify.js`**

Replace contents with:

```js
#!/usr/bin/env node
const { Client } = require('pg');

const dbUrl = process.argv[2] || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Usage: pnpm db:verify [DATABASE_URL]');
  process.exit(1);
}

(async () => {
  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    const ext = await client.query("select extname from pg_extension where extname = 'vector'");
    if (ext.rows.length === 0) throw new Error('pgvector extension missing');
    const tables = await client.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
    console.log(`Database verified: ${dbUrl} (tables=${tables.rows[0].n})`);
  } catch (err) {
    console.error(`Database verification failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
```

- [ ] **Step 3: Port `scripts/db-restore.js`**

Replace contents with:

```js
#!/usr/bin/env node
const { existsSync } = require('fs');
const { resolve } = require('path');
const { spawnSync } = require('child_process');

const backupArg = process.argv[2];
if (!backupArg) {
  console.error('Usage: pnpm db:restore <path-to-backup.pgdump>');
  process.exit(1);
}
const backupPath = resolve(backupArg);
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[db-restore] DATABASE_URL not set');
  process.exit(1);
}
if (!existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

try {
  run('pnpm', ['stop'], { allowFailure: true });
  run('pg_restore', ['--clean', '--if-exists', `--dbname=${dbUrl}`, backupPath]);
  run(process.execPath, ['scripts/db-verify.js']);
  run('pnpm', ['start']);
  console.log(`Database restored from ${backupPath}`);
} catch (err) {
  console.error(`Database restore failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status || 1}`);
  }
  return result;
}
```

Update `__tests__/scripts/db-restore.test.ts`: replace the SQLite-file sidecar assertions with `vi.mock('child_process')` and assertions about the `pg_restore` call's args.

- [ ] **Step 4: Port `scripts/find-stuck-releases.mjs`**

Replace its SQLite open with a `pg.Pool`. Translate `?` placeholders to `$N`. Boolean coercion as needed.

- [ ] **Step 5: Port `scripts/issue-run-summary-utils.mjs`**

Replace SQLite helper with a `pg.Pool`-based helper. Keep exported function names so downstream `.mjs` scripts (backfill, peek, check) compile unchanged. Update `__tests__/scripts/issue-run-summary-scripts.test.ts`.

- [ ] **Step 6: Port `scripts/qa-seed.mjs`**

Replace SQLite open with `pg.Client` against `DATABASE_URL`. Update DDL/seeding statements for Postgres dialect. Update `__tests__/scripts/qa-seed.test.ts`.

- [ ] **Step 7: Delete `ensure-better-sqlite3`**

```
rm scripts/ensure-better-sqlite3.js __tests__/scripts/ensure-better-sqlite3.test.ts
```

Edit `package.json` to remove the `pretest` and `pretest:watch` entries from `scripts`.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: all tests pass without `ensure-better-sqlite3` ever firing.

- [ ] **Step 9: Commit**

```
git add scripts/ package.json __tests__/scripts/
git commit -m "feat(scripts): port db scripts to postgres, drop ensure-better-sqlite3"
```

---

## Phase 5 — QA Docker stack

**Files:**
- Modify: `docker-compose.qa.yml`
- Modify: `Dockerfile.qa`

- [ ] **Step 1: Add a Postgres service to `docker-compose.qa.yml`**

Replace contents with:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: tamtam
      POSTGRES_PASSWORD: tamtam
      POSTGRES_DB: tamtam_qa
    volumes:
      - tamtam-qa-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tamtam -d tamtam_qa"]
      interval: 2s
      timeout: 5s
      retries: 30
  tamtam-qa:
    build:
      context: .
      dockerfile: Dockerfile.qa
    ports:
      - "1338:1338"
    environment:
      NODE_ENV: development
      NEXT_TELEMETRY_DISABLED: "1"
      WATCHPACK_POLLING: "true"
      PORT: "1338"
      HOSTNAME: 0.0.0.0
      TAMTAM_ROOT: /app
      DATABASE_URL: postgres://tamtam:tamtam@postgres:5432/tamtam_qa
      TAMTAM_BASE_URL: http://localhost:1338
      TAMTAM_QA_MODE: "1"
      CLAUDE_BIN: /app/scripts/qa-shim.js
      SHIM_INACTIVITY_TIMEOUT_MS: "120000"
      PATH: /app/scripts/qa-mocks:/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - .:/app
      - tamtam-qa-node-modules:/app/node_modules
      - tamtam-qa-next:/app/.next
      - tamtam-qa-data:/qa

volumes:
  tamtam-qa-postgres:
  tamtam-qa-data:
  tamtam-qa-node-modules:
  tamtam-qa-next:
```

- [ ] **Step 2: Update `Dockerfile.qa`**

Replace `ENV TAMTAM_DB_PATH=/qa/data/tamtam-qa.db` with `ENV DATABASE_URL=postgres://tamtam:tamtam@postgres:5432/tamtam_qa`.

Update the `CMD` to migrate then seed then start:

```dockerfile
CMD ["sh", "-c", "pnpm install --frozen-lockfile --prod=false --config.confirm-modules-purge=false && pnpm db:migrate && node scripts/qa-seed.mjs && next dev --port 1338 --hostname 0.0.0.0"]
```

- [ ] **Step 3: Smoke test**

Run: `pnpm dev:qa` (ctrl-C when verified)
Expected: stack boots, migrations apply, seed runs, Next.js dev server reachable on http://localhost:1338.

- [ ] **Step 4: Commit**

```
git add docker-compose.qa.yml Dockerfile.qa
git commit -m "feat(qa): provision postgres + pgvector for dev:qa stack"
```

---

## Phase 6 — Workflow flag removal (intake-only cutover)

**Files:**
- Modify: `app/api/agents/[agentId]/run/route.ts` (delete legacy inline path at lines 450-672, drop the if-flag wrapper at 406-448)
- Modify: `lib/shared/config.ts` (lines 87, 168, 367)
- Modify: `app/api/settings/route.ts:142`
- Modify: `docs/AGENT.md`, `docs/SETTINGS.md:220`, `docs/API.md`
- Create: `lib/db/migrations/0002_drop_durable_agent_workflows_flag.sql`

- [ ] **Step 1: Test that all runs go through workflow regardless of flag**

If a test file `__tests__/api/agent-run.test.ts` exists, add a case. Otherwise create one:

```ts
it('always routes through the workflow intake', async () => {
  // seed an agent, leave durable_agent_workflows_enabled unset / false
  const res = await POST(req, { params: { agentId: 'a1' } });
  const body = await res.json();
  expect(body.via).toBe('workflow');
});
```

Run: `pnpm test __tests__/api/agent-run.test.ts`
Expected: FAIL.

- [ ] **Step 2: Delete the legacy inline path**

Edit `app/api/agents/[agentId]/run/route.ts`:

- Remove the `if (settings.durable_agent_workflows_enabled) { ... }` wrapper at line 406; the workflow `start()` call becomes unconditional.
- Delete all code below the workflow-start return (from line ~450 `let prerequisiteResult: ...` through line ~672, before the function's final closing brace). The workflow already owns prerequisite, release-lock recheck, blocker recheck, prereq artifact write, compose, retrieval, memory, and PM2 spawn.
- Keep the response shape: `{ status: 'started', job_id, pid: 0, agent, via: 'workflow' }`.

- [ ] **Step 3: Remove the setting**

`lib/shared/config.ts`:
- Line 87: delete `durable_agent_workflows_enabled: boolean;` from the interface.
- Line 168: delete the default `durable_agent_workflows_enabled: false,`.
- Line 367: delete the deserialization branch.

`app/api/settings/route.ts:142`: remove `'durable_agent_workflows_enabled'` from the allowed-keys array.

- [ ] **Step 4: Optional cleanup migration**

```
pnpm drizzle-kit generate --custom --name drop_durable_agent_workflows_flag
```

Fill the generated SQL:

```sql
DELETE FROM settings WHERE key = 'durable_agent_workflows_enabled';
```

- [ ] **Step 5: Rerun the test**

Run: `pnpm test __tests__/api/agent-run.test.ts`
Expected: PASS.

- [ ] **Step 6: Doc updates**

`docs/AGENT.md`: rewrite the "Durable Agent Workflows" subsection to describe the unconditional path. Strip every reference to `durable_agent_workflows_enabled` and the toggle hint.

`docs/SETTINGS.md`: delete the `durable_agent_workflows_enabled` row at line 220 and any related code-block examples.

`docs/API.md` (`/api/agents/[agentId]/run` entry): drop the "(or `200 {..., via: 'workflow'}` when ...is on...)" parenthetical. State the response is always `via: 'workflow'`.

- [ ] **Step 7: Full check**

Run: `pnpm lint && pnpm type-check && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```
git add app/api/agents/[agentId]/run/route.ts lib/shared/config.ts app/api/settings/route.ts docs/AGENT.md docs/SETTINGS.md docs/API.md lib/db/migrations/0002_*.sql lib/db/migrations/meta/
git commit -m "feat(agents): make workflow intake the only agent path, remove flag"
```

---

## Phase 7 — Dependency + dead code cleanup

**Files:**
- Modify: `package.json`
- Modify: `next.config.ts:5`
- Delete: `lib/db/sqlite-vec.ts`
- Modify: any test mocks that referenced `@/lib/db/sqlite-vec`
- Regenerate: `pnpm-lock.yaml`

- [ ] **Step 1: Update `package.json`**

- Delete `"better-sqlite3"` from `dependencies`.
- Delete `"sqlite-vec"` from `dependencies`.
- Delete `"@types/better-sqlite3"` from `devDependencies`.
- Add `"better-sqlite3"` to `devDependencies` so the migration script keeps working through deprecation: `"better-sqlite3": "^12.9.0"`.
- Keep `better-sqlite3` in `pnpm.onlyBuiltDependencies`; remove `sqlite-vec` from that list if present.

- [ ] **Step 2: Run install**

```
pnpm install
```

Expected: `sqlite-vec` gone from `node_modules`; `better-sqlite3` is a devDep now.

- [ ] **Step 3: Drop sqlite from `next.config.ts`**

Edit line 5:

```ts
serverExternalPackages: ['pg', 'graphile-worker'],
```

- [ ] **Step 4: Delete the dead file**

```
rm lib/db/sqlite-vec.ts
```

Search for remaining importers:

```
grep -rn "sqlite-vec\|@/lib/db/sqlite-vec" lib/ app/ __tests__/ --include="*.ts"
```

Update any test mock of `@/lib/db/sqlite-vec` (notably `__tests__/lib/agent-run-report.test.ts` ~line 59) to mock the pgvector backend instead, or drop the mock if it's no longer load-bearing.

- [ ] **Step 5: Audit + suite**

```
pnpm audit
pnpm lint
pnpm type-check
pnpm test
```

Expected: zero new high-severity findings; all tests green.

- [ ] **Step 6: Commit**

```
git add package.json pnpm-lock.yaml next.config.ts __tests__/lib/agent-run-report.test.ts
git rm lib/db/sqlite-vec.ts
git commit -m "chore: remove sqlite-vec runtime, demote better-sqlite3 to devDep"
```

---

## Phase 8 — Documentation sweep

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/DATABASE.md`
- Modify: `docs/BACKUP.md`
- Modify: `docs/CACHING.md`
- Modify: `docs/E2E.md`
- Modify: `docs/superpowers/plans/2026-05-13-durable-agent-orchestration.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Line 22: replace the Database bullet with:

```
- **Database**: Drizzle ORM + node-postgres (`pg.Pool`), Postgres 16 with pgvector. `DATABASE_URL` is required.
```

Line 110 (Test DB scope): rewrite the `createTestDb()` paragraph to describe `__tests__/helpers/test-db.ts` — `createTestPgDb()` for full schema, `createTestPgDbEmpty()` for raw DDL.

Line 273 (Production data safety): replace `data/db/tamtam.db` with "the Postgres database referenced by `DATABASE_URL`".

- [ ] **Step 2: Rewrite `docs/DATABASE.md` header (line 3) and DB inspection section**

Header:

```
Postgres 16 (with the `vector` extension) accessed via `pg.Pool` and Drizzle ORM. The connection string lives in `DATABASE_URL`. Schema in `lib/db/`.
```

Replace the lines 270-294 SQLite commands with `psql "$DATABASE_URL"` examples. State that `TAMTAM_DB_PATH` is no longer consulted.

- [ ] **Step 3: Rewrite `docs/BACKUP.md`**

Replace SQLite descriptions with `.pgdump` retention + `pnpm db:restore <file.pgdump>` runbook. Document `keepRecent` + `keepWeekly` retention policy from `lib/db/backup.ts`.

- [ ] **Step 4: Update `docs/CACHING.md:90`**

Swap the `sqlite3 data/db/tamtam.db ...` example for the equivalent `psql "$DATABASE_URL" -c "..."`.

- [ ] **Step 5: Update `docs/E2E.md:272`**

Replace temp DB path description with a per-suite Postgres database name (e.g. `tamtam_e2e_pipeline_<runId>`) created/dropped by the harness via `DATABASE_URL`.

- [ ] **Step 6: Reverse the deferred plan note**

Open `docs/superpowers/plans/2026-05-13-durable-agent-orchestration.md` and prepend a header note:

```
> **Update 2026-05-14:** This plan recommended deferring `workflow` adoption. That recommendation was reversed: TamTam moved to Postgres + `@workflow/world-postgres`, and the durable intake path is now the only agent intake path (see `docs/superpowers/specs/2026-05-14-postgres-workflow-cutover-design.md`). The body below is preserved for historical context.
```

- [ ] **Step 7: Commit**

```
git add CLAUDE.md docs/
git commit -m "docs: update for postgres-only + workflow-always-on cutover"
```

---

## Final verification

- [ ] **Pre-push check**

```
pnpm lint && pnpm type-check && pnpm test
```

Expected: all green.

- [ ] **End-to-end smoke against QA**

```
pnpm dev:qa
```

Then in another shell, hit the seeded agent's run endpoint and verify the response includes `"via": "workflow"`.

- [ ] **Confirm no production sqlite imports**

```
grep -rn "better-sqlite3\|sqlite-vec" lib/ app/ --include="*.ts" --include="*.tsx"
```

Expected: no matches. (The remaining hits are intentionally in `scripts/migrate-sqlite-to-pg.mjs` and `__tests__/scripts/migrate-sqlite-to-pg.test.ts` only.)
