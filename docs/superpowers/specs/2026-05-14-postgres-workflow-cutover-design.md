# Postgres-Only + Workflow-Always-On Cutover

Date: 2026-05-14
Branch: `feat/durable-agent-workflow`

## Goal

Make Postgres the only persistence layer in TamTam (runtime, tests, scripts, QA stack, and docs), and make the durable workflow intake path unconditional by removing the `durable_agent_workflows_enabled` feature flag. After this change, no part of the codebase imports `better-sqlite3` or `sqlite-vec`, and every agent run goes through `runAgentIntakeWorkflow`.

## Non-goals

- Expanding the `workflow` lib beyond agent intake. The release pipeline (`test → review → fix → commit → push → dod → merge`) stays on completion hooks in `lib/jobs/lifecycle.ts` and `lib/pipeline/start-*.ts`.
- Replacing PM2 as the job execution boundary.
- Changing the pgvector schema (`embedding vector(768)`) or retrieval behavior.
- Touching the e2e pipeline harness in `e2e/pipeline/` beyond its DB path.

## Current state (audited 2026-05-14)

**Already migrated to Postgres:**
- `lib/db/index.ts` uses `pg.Pool` + `drizzle-orm/node-postgres`.
- `lib/db/schema.ts` and the single migration `lib/db/migrations/0000_wet_logan.sql` are Postgres-dialect (Drizzle journal version 7, dialect `postgresql`).
- Retrieval moved from `sqlite-vec` to pgvector (commits `5d24673a`, `1cc1db25`).
- `lib/db/backup.ts` shells out to `pg_dump --format=custom` to `.pgdump` files.
- `workflow` 4.2.4 + `@workflow/world-postgres` 4.1.1 are installed; `lib/agents/intake-workflow.ts` exists.

**Still SQLite or inconsistent:**
- Dependencies: `better-sqlite3`, `sqlite-vec`, `@types/better-sqlite3` in `package.json`.
- `next.config.ts:5` lists `better-sqlite3` and `sqlite-vec` in `serverExternalPackages`.
- Dead file: `lib/db/sqlite-vec.ts` (no callers under `app/` or `lib/`; only a test still mocks it).
- Scripts that open a SQLite file directly: `scripts/job-runner.js:54`, `scripts/db-verify.js`, `scripts/db-restore.js`, `scripts/find-stuck-releases.mjs:16`, `scripts/issue-run-summary-utils.mjs:7`, `scripts/qa-seed.mjs:7`, `scripts/ensure-better-sqlite3.js` (plus the `pretest` / `pretest:watch` hooks that invoke it).
- All `__tests__/lib/*.test.ts` and several `__tests__/scripts/*.test.ts` build an in-memory `better-sqlite3` + `drizzle-orm/better-sqlite3` per test file via local `createTestDb()`.
- `vitest.config.ts` pins `pool: 'forks'` because better-sqlite3 is not safe under worker threads.
- `docker-compose.qa.yml` + `Dockerfile.qa` provision `TAMTAM_DB_PATH=/qa/data/tamtam-qa.db`; no Postgres service in the QA stack.
- Feature flag `durable_agent_workflows_enabled` (declared in `lib/shared/config.ts:87,168,367`, allowlisted in `app/api/settings/route.ts:142`, branched in `app/api/agents/[agentId]/run/route.ts:406-448`) defaults to `false`, so the legacy non-workflow agent intake is still the production path.
- pgvector extension is **not** created anywhere despite the schema declaring `embedding vector(768)`. A fresh DB cannot run `pnpm db:migrate`.
- Docs out of date: `CLAUDE.md` (lines 22, 110, 273), `docs/DATABASE.md` (line 3 and §"DB inspection"), `docs/BACKUP.md`, `docs/CACHING.md` (line 90), `docs/E2E.md` (line 272), `docs/AGENT.md` (§"Durable Agent Workflows" describing the flag), `docs/SETTINGS.md` (line 220), `docs/superpowers/plans/2026-05-13-durable-agent-orchestration.md` (the original "defer" decision is now reversed).

## Design — phased execution

Each phase is independently landable and leaves the tree in a green state. The phasing order serializes the riskiest steps (data migration, flag removal) so that backing out one of them does not roll back the others.

### Phase 1 — pgvector extension migration (prerequisite for everything else)

- Generate a custom migration via `pnpm drizzle-kit generate --custom --name pgvector`. This writes `lib/db/migrations/0001_pgvector.sql` (empty) and appends a journal entry to `lib/db/migrations/meta/_journal.json` automatically.
- Fill the generated SQL with a single statement:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
- Verify with `pnpm db:migrate` against a fresh `tamtam_test` DB.

Why first: Phase 2 (PGlite tests) and Phase 5 (QA Postgres) both provision fresh DBs and will fail migration without the extension.

### Phase 2 — One-time SQLite → Postgres data migration script

- Add `scripts/migrate-sqlite-to-pg.mjs`. Reads from a SQLite file (`--from <path>` or `TAMTAM_DB_PATH`, defaulting to `data/db/tamtam.db`); writes to `DATABASE_URL`. Uses `better-sqlite3` (one last time, devDep) and `pg`.
- Table-by-table loop with explicit column maps for each table in `lib/db/schema.ts`. Type coercion:
  - `INTEGER` boolean columns: `0|1 → false|true`.
  - `REAL` / `INTEGER` timestamps stay as `double precision`.
  - JSON-shaped TEXT columns pass through unchanged.
  - `vector(768)` columns: skip retrieval tables on this initial migration; they will reindex on next run.
- Flags:
  - `--truncate` (default off): `TRUNCATE` each target table before insert.
  - `--dry-run`: count rows that would move; no writes.
  - `--only <table,table>` for partial migrations.
- Idempotency: when `--truncate` is off, use `ON CONFLICT (<pk>) DO NOTHING`.
- Document in `docs/DATABASE.md` under a new "One-time SQLite → Postgres migration" section. Delete the script in a follow-up commit after the cutover has run in production.

Why second: the script needs `better-sqlite3` to exist. Landing it before we tear out the SQLite deps in Phase 7 keeps the build green at every step.

### Phase 3 — PGlite test harness

- Add `@electric-sql/pglite` as a devDep (current version ≥ 0.3).
- New helper `__tests__/helpers/test-db.ts` exporting:
  ```ts
  // Boots a PGlite instance and applies the full production migration set.
  // Use this for tests that touch many tables or rely on real defaults/FKs.
  export async function createTestPgDb(): Promise<TestDbHandle>;

  // Boots a PGlite instance with no schema applied. The caller provides DDL
  // directly via db.execute(sql.raw(...)). Mirrors the existing per-test
  // createTestDb() pattern in __tests__/lib/* where tests build only the
  // tables they need.
  export async function createTestPgDbEmpty(): Promise<TestDbHandle>;

  interface TestDbHandle {
    db: NodePgDatabase<typeof schema>;
    raw: PGlite;                       // for tests that need execute(sql.raw(...))
    [Symbol.asyncDispose](): Promise<void>;
  }
  ```
  Both helpers boot a fresh `PGlite` instance with the `vector` extension loaded from `@electric-sql/pglite/vector`. `createTestPgDb()` additionally applies all Drizzle migrations via `migrate(drizzleDb, { migrationsFolder: 'lib/db/migrations' })`. Disposal closes the PGlite instance.

  Per-test isolation: each call returns a new in-process Postgres. No teardown coordination between tests is needed.
- Update `__tests__/global-setup.ts`: keep the `DATABASE_URL` guard; remove the "better-sqlite3" comment.
- Migrate the ~22 test files:
  - Default rule: tests that today build raw SQL DDL inline keep that shape but call `createTestPgDbEmpty()` and adjust the DDL for Postgres dialect (`INTEGER` → `integer`, `INTEGER` booleans → `boolean`, `REAL` → `double precision`, no `pragma` lines).
  - Tests that exercise behavior spanning many tables (e.g. `__tests__/lib/db-bootstrap.test.ts`) switch to `createTestPgDb()` so they get the full production schema for free.
  - Replace `import Database from 'better-sqlite3'` + `import { drizzle } from 'drizzle-orm/better-sqlite3'` with the helper import.
  - Where tests insert via Drizzle, no row-construction change is needed.
- `vitest.config.ts`: drop `pool: 'forks'` and the comment. Keep `maxWorkers: 4`.
- Re-run `pnpm test`. CI runtime should drop (PGlite per test file is fast; worker threads now permitted).

Why third: Phase 4 (scripts cutover) needs the test suite to validate the script changes.

### Phase 4 — Scripts cutover

Rewrite each SQLite-touching script to use Postgres via `pg.Pool` (or `@/lib/db` when run inside the Next.js bundle). Each script keeps its existing CLI surface so external callers (Husky hooks, scheduled tasks) are unaffected.

| Script | Today | New behavior |
|---|---|---|
| `scripts/job-runner.js` | `new Database(dbPath).prepare('UPDATE jobs ...').run()` for in-process job state updates | Open a short-lived `pg.Client` against `DATABASE_URL`; same SQL ported to Postgres |
| `scripts/db-verify.js` | `pragma integrity_check` / `foreign_key_check` on SQLite | `pg_isready` + `SELECT 1` against the target DB; report drizzle migration count vs `_journal.json` |
| `scripts/db-restore.js` | Copy SQLite sidecars, swap files | `pg_restore --clean --if-exists --dbname=$DATABASE_URL <backup.pgdump>` with `pnpm stop` / `pnpm start` framing |
| `scripts/find-stuck-releases.mjs` | Read jobs via SQLite | Read via `pg.Pool`, same query rewritten in Postgres dialect |
| `scripts/issue-run-summary-utils.mjs` | SQLite helper used by `backfill-*` and `peek-summary` scripts | `pg.Pool` helper with the same exported shape |
| `scripts/qa-seed.mjs` | Seeds an SQLite DB at `TAMTAM_DB_PATH` | Seeds via `pg.Pool` against the QA `DATABASE_URL` (Phase 5 provides the service) |

Delete: `scripts/ensure-better-sqlite3.js` and the `pretest` / `pretest:watch` hooks in `package.json`. Delete `__tests__/scripts/ensure-better-sqlite3.test.ts`.

### Phase 5 — QA Docker stack

- Add `postgres` service to `docker-compose.qa.yml` using `pgvector/pgvector:pg16` (ships the extension preinstalled). Volume `tamtam-qa-postgres` for persistence between QA runs.
- Replace `TAMTAM_DB_PATH=/qa/data/tamtam-qa.db` with `DATABASE_URL=postgres://tamtam@postgres:5432/tamtam_qa` in `docker-compose.qa.yml` and `Dockerfile.qa`.
- `Dockerfile.qa` `CMD` becomes: wait for Postgres → `pnpm db:migrate` → `node scripts/qa-seed.mjs` → `next dev`.
- The bind-mount source pattern (`.:/app`) is preserved so source edits still hot-reload without rebuild.

### Phase 6 — Workflow flag removal (intake-only cutover)

- Delete the `if (settings.durable_agent_workflows_enabled) { … }` branch at `app/api/agents/[agentId]/run/route.ts:406-448` and **all** code below it that constitutes the legacy inline path (the prereq exec block, the inline `composeAgentSkills`/CLI spawn, etc.). The entry into `runAgentIntakeWorkflow` becomes unconditional for every agent run.
- The `via: 'workflow'` field in the success response stays (always-on), documented in `docs/API.md` as a stable contract.
- Remove the setting:
  - `lib/shared/config.ts:87` (interface field).
  - `lib/shared/config.ts:168` (default).
  - `lib/shared/config.ts:367` (deserialization branch).
  - `app/api/settings/route.ts:142` (allowlist entry).
- Migration: write a small Drizzle migration `0002_drop_durable_agent_workflows_flag.sql` that issues `DELETE FROM settings WHERE key = 'durable_agent_workflows_enabled';`. Optional — the row is harmless if left behind — but cleaner.
- Docs: rewrite `docs/AGENT.md` § "Durable Agent Workflows" to describe the now-unconditional path (no flag). Strip the setting from `docs/SETTINGS.md`. Update `docs/API.md` `/api/agents/[agentId]/run` description to drop the qualifier "when … is on and the run qualifies".

### Phase 7 — Dependency + dead code cleanup

- `package.json`: remove `better-sqlite3`, `sqlite-vec`, `@types/better-sqlite3`. Remove from `pnpm.onlyBuiltDependencies`.
- `next.config.ts:5`: drop `better-sqlite3` and `sqlite-vec` from `serverExternalPackages` (keep `pg` and `graphile-worker`).
- Delete `lib/db/sqlite-vec.ts`.
- Run `pnpm install`, `pnpm audit`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm test:e2e` (or at least `test:e2e:pipeline`).

### Phase 8 — Documentation sweep

Targeted edits, no rewrites:

- `CLAUDE.md`:
  - Line 22: "Drizzle ORM + better-sqlite3, WAL mode" → "Drizzle ORM + node-postgres, DATABASE_URL required".
  - Line 110 (Test DB scope): replace the `createTestDb()` paragraph with a description of `__tests__/helpers/test-db.ts` and PGlite.
  - Line 273 (Production data safety): `data/db/tamtam.db` → "the Postgres database referenced by `DATABASE_URL`".
- `docs/DATABASE.md`: rewrite header line 3 and the "DB inspection" section (lines 270-294) for Postgres (`psql`, `pg_dump`, `pnpm db:verify`).
- `docs/BACKUP.md`: rewrite to describe `.pgdump` backups, retention, and `pnpm db:restore <file>.pgdump`.
- `docs/CACHING.md:90`: swap the `sqlite3 data/db/tamtam.db` example for the equivalent `psql $DATABASE_URL -c "..."`.
- `docs/E2E.md:272`: temp DB description switches from `/tmp/tamtam-e2e-pipeline/data/db/tamtam.db` to a per-suite Postgres database name (e2e harness creates and drops it).
- `docs/AGENT.md`: rewrite "Durable Agent Workflows" subsection per Phase 6.
- `docs/SETTINGS.md`: remove the `durable_agent_workflows_enabled` row.
- `docs/superpowers/plans/2026-05-13-durable-agent-orchestration.md`: prepend a dated header note:
  > **Update 2026-05-14:** This plan recommended deferring `workflow` adoption. That recommendation was reversed: TamTam moved to Postgres + `@workflow/world-postgres`, and the durable intake path is now the only agent intake path (see `docs/superpowers/specs/2026-05-14-postgres-workflow-cutover-design.md`). The body below is preserved for historical context.

## Test plan

- `pnpm test` green after Phase 3 (PGlite harness).
- `pnpm test:e2e:pipeline` green after Phase 4 (scripts cutover) and Phase 6 (flag removal).
- `pnpm dev:qa` boots a working stack after Phase 5; agent run on a seeded QA project completes end-to-end against the QA Postgres.
- Manual smoke against the user's live DB after Phase 2 migration script run: `psql` row counts match `sqlite3` row counts for `projects`, `jobs`, `agents`, `settings`, `recommendations`, `gh_status`, `gh_issues_cache`, `pipeline_locks`, `queued_agent_runs`, `notification_throttle`, `maintenance_status`, `skills`.

## Risks and mitigations

- **Data loss during one-shot migration.** Mitigation: Phase 2 lands the script and we dry-run it against your live DB *before* Phase 7 removes `better-sqlite3`. Always have a `.pgdump` of the target Postgres before running with `--truncate`.
- **PGlite divergence from production Postgres.** PGlite supports pgvector via its own extension package. Mitigation: e2e pipeline tests stay on a real Postgres image (Phase 5 stack reused), unit tests on PGlite. Any test that exercises pgvector-specific operators stays in the e2e or integration tier, not in PGlite.
- **Flag removal regresses an agent path we hadn't validated.** Mitigation: the intake workflow already covers all branches (readOnly, prereq, non-readOnly, no-prereq) per `app/api/agents/[agentId]/run/route.ts:406-448`. The legacy branch is what we're removing, not what we're relying on. Pipeline e2e (`pnpm test:e2e:pipeline`) is the regression net.
- **Drift between `docker-compose.qa.yml` and developer machines.** Mitigation: a section in `CLAUDE.md` documents the supported local Postgres options (Homebrew `postgresql@16` + the `pgvector` formula, or `docker run pgvector/pgvector:pg16`). The QA stack is the canonical reproducer.
- **Workflow lib version pinning.** The current `workflow` 4.2.4 + `@workflow/world-postgres` 4.1.1 combo was vetted on this branch. Mitigation: lockfile stays frozen; no version bumps in this cutover.

## Open items deferred to follow-up branches

- Removing `scripts/migrate-sqlite-to-pg.mjs` after the cutover has run in production for at least one full release cycle.
- Decommissioning `data/db/tamtam.db` and any local SQLite backups in `data/db/backups/` (operator task, not a code change).
- Considering whether to expand `workflow` to own pipeline orchestration (`docs/superpowers/plans/2026-05-13-durable-agent-orchestration.md` is explicitly out of scope here but would be the next natural spec).
