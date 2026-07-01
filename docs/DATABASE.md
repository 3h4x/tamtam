# Database — Schema Reference

Postgres 18 (with the `vector` extension) accessed via `pg.Pool` and Drizzle ORM. Connection string lives in `DATABASE_URL` (required). Schema in `lib/db/`.

## Upgrading the Postgres major version (pg16 → pg18)

The bundled `docker-compose.yml` / `docker-compose.qa.yml` pin `pgvector/pgvector:pg18`. The named volume is mounted at `/var/lib/postgresql` (not `/var/lib/postgresql/data`): the Postgres 18 official image — which the pgvector image is built on — moved the default `PGDATA` to a version-scoped subdirectory (`/var/lib/postgresql/18/docker`), so the mount must sit one level up to persist the cluster.

A major-version jump is **not** an in-place upgrade. A volume previously populated by `pg16` (under the old `/var/lib/postgresql/data` layout) will not be read by `pg18`, and a fresh cluster will be initialized. To preserve data, dump under the old image first and restore after switching:

```bash
# 1. With the OLD (pg16) compose still in place, dump:
docker compose exec postgres pg_dump -U tamtam -d tamtam -Fc > tamtam.pre18.dump
# 2. Stop and remove the old volume so pg18 starts a clean cluster:
docker compose down
docker volume rm tamtam-postgres-data   # tamtam-qa-postgres for the QA compose
# 3. Bring up pg18 and verify the cluster is healthy:
docker compose up -d
docker compose exec postgres pg_isready -U tamtam -d tamtam
# 4. Restore:
docker compose exec -T postgres pg_restore -U tamtam -d tamtam --clean --if-exists < tamtam.pre18.dump
```

QA volumes are ephemeral and can simply be recreated.

## When to read this

- Adding a new column or table (check existing schema first)
- Debugging missing data after a server restart (memory vs DB cache)
- Understanding job kinds when filtering runs
- Writing a new query in `lib/jobs/job-storage.ts` or related files

---

---

## Tables

### `settings`

Key-value store for all configuration.

| Column | Type | Constraints |
|--------|------|-------------|
| `key` | TEXT | PRIMARY KEY |
| `value` | TEXT | NOT NULL |

---

### `projects`

Project metadata and per-project pipeline config.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `name` | TEXT | — | PRIMARY KEY |
| `path` | TEXT | — | NOT NULL; absolute filesystem path |
| `enabled` | INTEGER | `false` | Boolean; whether project is active in scheduler |
| `github` | TEXT | — | nullable; GitHub repo URL |
| `priority` | TEXT | — | nullable; scheduling priority |
| `customActions` | TEXT | — | nullable; JSON array of custom action definitions |
| `testCommand` | TEXT | — | nullable; command to run tests |
| `testCronEnabled` | INTEGER | `false` | Boolean |
| `testCronSchedule` | TEXT | — | nullable; e.g. "1h", "30m" |
| `autoPushEnabled` | INTEGER | `false` | Boolean; enables auto-chaining outside of a Release run |
| `lastPushError` | TEXT | — | nullable; last push failure message |
| `lastPushAt` | REAL | — | nullable; Unix timestamp of last push |
| `reviewPromptAddendum` | TEXT | — | nullable; appended to the standard review prompt under "Project-specific review guidance" |
| `reviewPrerequisiteCommand` | TEXT | — | nullable; bash command run before each review, with output appended to the review prompt |
| `fixPromptAddendum` | TEXT | — | nullable; appended to the standard fix prompt under "Project-specific fix guidance" |
| `website` | TEXT | — | nullable; public URL for QA agents |
| `qaUrl` | TEXT | — | nullable; explicit QA target URL, preferred over `website` |
| `devServerStartCommand` | TEXT | — | nullable; DB-only `bash -c` command TamTam runs from the project root at agent kickoff |
| `devServerStopCommand` | TEXT | — | nullable; DB-only command run before TamTam falls back to terminating the owned dev-server process group |
| `devServerReadyUrl` | TEXT | — | nullable; DB-only HTTP(S) readiness URL polled after starting the dev server |
| `dailySpendCapUsd` | DOUBLE PRECISION | — | nullable; rolling 24h project spend cap for new agent runs and Release starts |
| `releaseSpendCapUsd` | DOUBLE PRECISION | — | nullable; per-release child-job spend cap checked between pipeline phases |
| `setupComplete` | BOOLEAN | `false` | Whether the new-project setup wizard is finished |
| `setupState` | TEXT | `'{}'` | JSON object recording setup wizard step statuses (`completed` / `skipped`) |

---

### `jobs`

Audit trail for every run, review, fix, test, push, agent execution.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY; format: `{project}-{kind}-{timestamp}` |
| `project` | TEXT | — | NOT NULL; project name |
| `kind` | TEXT | — | NOT NULL; see [Job Kinds](#job-kinds) |
| `prompt` | TEXT | — | nullable; prompt sent to Claude |
| `pid` | INTEGER | — | NOT NULL; spawned child PID, server PID for inline coordinator jobs, or `0` when no external process is owned |
| `logPath` | TEXT | — | nullable; absolute path to NDJSON log file |
| `startedAt` | REAL | — | NOT NULL; Unix timestamp (seconds) |
| `finishedAt` | REAL | — | nullable; null while running |
| `exitCode` | INTEGER | — | nullable; process exit code |
| `seen` | INTEGER | `false` | Boolean; user notification state |
| `durationMs` | INTEGER | — | nullable; total wall time |
| `inputTokens` | INTEGER | — | nullable; Claude input tokens |
| `outputTokens` | INTEGER | — | nullable; Claude output tokens |
| `cacheReadTokens` | INTEGER | — | nullable; prompt cache read tokens |
| `cacheCreateTokens` | INTEGER | — | nullable; prompt cache write tokens |
| `sessionId` | TEXT | — | nullable; Claude session ID for `--resume` |
| `contextMeta` | TEXT | — | nullable; JSON `{ skills, docs }` for terminal sessions |
| `userPrompt` | TEXT | — | nullable; user-supplied prompt override |
| `parentJobId` | TEXT | — | nullable; parent job in pipeline chain |
| `releaseId` | TEXT | — | nullable; parent release meta-job id for pipeline children |
| `abortedAt` | REAL | — | nullable; Unix timestamp (seconds) when a job/release was cancelled |
| `releaseDeadlineAt` | BIGINT | — | nullable; Unix timestamp (milliseconds) when a release meta-job should be auto-aborted |
| `workSummary` | TEXT | — | nullable; concise agent-reported outcome summary |
| `modifiedFiles` | TEXT | — | nullable; JSON array of files changed by an agent run |
| `skillIds` | TEXT | `'[]'` | JSON array of resolved run skill records `{ id, name, promptChars, source }`; used by `/stats` to estimate per-skill prompt/cache-read spend |

---

### `test_runs`

Per-test outcomes recorded by the release test step when it can parse failing tests.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `project` | TEXT | — | NOT NULL; project name |
| `jobId` | TEXT | — | NOT NULL; owning `test` job |
| `testId` | TEXT | — | NOT NULL; framework-specific test identifier |
| `framework` | TEXT | — | NOT NULL; currently `vitest` or `pytest` |
| `commitSha` | TEXT | — | nullable; project HEAD when the outcome was recorded |
| `status` | TEXT | — | NOT NULL; `flaky`, `fail`, or `quarantined` |
| `firstSeenAt` | REAL | — | NOT NULL; owning test job start timestamp |
| `finishedAt` | REAL | — | NOT NULL; outcome timestamp |

#### Job Kinds

| Kind | Description |
|------|-------------|
| `run` | Interactive terminal session |
| `review` | AI code review |
| `fix` | AI fix — single kind covering test/review/commit/push hook fix scenarios. The fix's `parentJobId` indicates which step kind triggered it (read by `start-fix.ts` to craft the prompt and by `decideNextPhase` to route the post-fix re-verification). |
| `fix-ci` | AI fix for CI failures (auto-retry capable; manual-button trigger, distinct from in-pipeline `fix`) |
| `test` | Project test command |
| `commit` | Git commit step |
| `push` | Git push step |
| `release` | Meta-job wrapping the full pipeline |
| `action` | Custom action (user-defined bash) |
| `agent:{agentName}` | Scheduled agent execution |

---

### `skills`

User-defined reusable prompt blocks.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY |
| `name` | TEXT | — | NOT NULL |
| `description` | TEXT | `''` | |
| `content` | TEXT | `''` | Markdown content prepended to Claude prompts |
| `createdAt` | REAL | — | NOT NULL; Unix timestamp |
| `updatedAt` | REAL | — | NOT NULL; Unix timestamp |

---

### `skillRevisions`

Append-only audit history for DB-backed skill edits. Each PATCH/revert stores the previous `skills` row as JSON before mutating the live row. Nightly retention keeps the newest `skill_revision_retention_count` rows per skill.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `entityId` | TEXT | — | `skills.id` at edit time |
| `snapshot` | TEXT | — | JSON snapshot of the prior skill row |
| `author` | TEXT | — | `settings.user_name` or environment fallback |
| `note` | TEXT | — | nullable operator note |
| `createdAt` | REAL | — | Unix timestamp |

Index: `skill_revisions_entity_created` on `(entity_id, created_at)`.

---

### `notification_throttle`

Persisted dedupe state for outbound webhook throttling.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `key` | TEXT | — | PRIMARY KEY; `${event}:${project}:${agent-or-kind}` |
| `lastSentAt` | INTEGER | — | Unix timestamp in milliseconds for the last delivered alert |
| `suppressedCount` | INTEGER | `0` | Number of matching alerts suppressed since `lastSentAt` |

---

### `queued_agent_runs`

DB-backed deferred agent runs created when a release pipeline lock or pending release must run before new agent work. Rows are replayed by the recovery drain after the lock clears and survive server restarts.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `project` | TEXT | — | owning project |
| `agentId` | TEXT | — | deferred agent id |
| `agentName` | TEXT | — | display name at queue time |
| `triggeredBy` | TEXT | `manual` | original trigger header value |
| `prompt` | TEXT | `''` | prompt to replay |
| `modelOverride` | TEXT | — | nullable canonical per-run model tier (`fast`, `normal`, or `smart`) |
| `enqueuedAt` | REAL | — | Unix timestamp (seconds) |

Indexes: unique `queued_agent_runs_project_agent` on `(project, agentId)`.

---

### `job_completion_events`

Durable event log for job-completion trigger migration. Rows are written when a job reaches a terminal state; the probe sweep consumes unhandled rows and dispatches release-after-run, release-after-fix-CI, auto-resume, or queued-agent drain routing when the matching legacy inline hook is disabled.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `jobId` | TEXT | — | unique job id that emitted the event |
| `kind` | TEXT | — | job kind at completion time |
| `exitCode` | INTEGER | — | nullable terminal exit code |
| `project` | TEXT | — | owning project |
| `releaseId` | TEXT | — | nullable release meta-job id |
| `ghIssueNumber` | INTEGER | — | nullable linked GitHub issue number |
| `emittedAt` | REAL | — | Unix timestamp (seconds) |
| `consumedBy` | TEXT | — | nullable consumer tag once handled |
| `consumedAt` | REAL | — | nullable Unix timestamp (seconds) when consumed |

Indexes: unique `job_completion_events_job_id` on `jobId`; `job_completion_events_unconsumed` on `(consumedBy, emittedAt)`.

---

### `job_resource_samples`

Append-only per-job process resource telemetry written by the probe sweep. Each running job with a usable child PID is sampled with `ps -o %cpu=,rss= -p <pid>` so job detail views can draw CPU and resident-memory time series without an external observability backend. Nightly retention prunes samples older than `job_row_retention_days`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `jobId` | TEXT | — | job id sampled by the probe sweep |
| `sampledAt` | REAL | — | Unix timestamp (seconds) |
| `cpuPct` | REAL | — | nullable process CPU percent from `ps` |
| `rssKb` | INTEGER | — | nullable resident set size in KB from `ps` |

Index: `job_resource_samples_job_sampled` on `(jobId, sampledAt)`.

---

### `pipeline_lock_events`

Durable event log for pipeline-lock release recovery. `releaseLock` and stale-lock self-healing write rows when a project lock is dropped. The probe sweep consumes unhandled rows and drains pending releases before queued agent runs for the project when `legacy_pipeline_lock_inline_drain_enabled` is disabled.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `project` | TEXT | — | project whose lock was released |
| `releasedByJobId` | TEXT | — | nullable job id that previously held the lock |
| `reason` | TEXT | — | release reason, such as `released`, `heal:holder_finished`, or `heal:holder_missing` |
| `emittedAt` | REAL | — | Unix timestamp (seconds) |
| `consumedBy` | TEXT | — | nullable consumer tag once handled |
| `consumedAt` | REAL | — | nullable Unix timestamp (seconds) when consumed |

Index: `pipeline_lock_events_unconsumed` on `(consumedBy, emittedAt)`.

---

### `maintenance_status`

Persisted latest-status records for server maintenance tasks. Values are JSON payloads so narrowly scoped maintenance subsystems can evolve their summary shape without a schema change.

Also stores transient cross-process coordination keys whose state must survive
Next.js module/runtime boundaries. Current key prefix:
`agent_run_slot:<project>` reserves one mutable agent run per project until the
owning agent job reaches a terminal state.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `key` | TEXT | — | PRIMARY KEY; retention uses `retention:project-logs:last` and `retention:nightly:last` |
| `value` | TEXT | — | JSON summary payload |
| `updatedAt` | REAL | — | Unix timestamp (seconds) when the summary was written |

---

### `agents`

Configuration for scheduled automated agents.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY |
| `name` | TEXT | — | NOT NULL |
| `project` | TEXT | — | NOT NULL; project name |
| `skillIds` | TEXT | `'[]'` | JSON array of skill IDs |
| `docPaths` | TEXT | `'[]'` | JSON array of project-relative docs attached to prompt context |
| `model` | TEXT | `'normal'` | Semantic tier stored by new writes: `fast` / `normal` / `smart`. Legacy rows may still contain `haiku` / `sonnet` / `opus` aliases and are normalized on read. |
| `prompt` | TEXT | `''` | Task prompt for scheduled runs |
| `schedule` | TEXT | — | nullable; e.g. "1h", "30m"; null = manual only |
| `enabled` | INTEGER | `true` | Boolean |
| `provider` | TEXT | — | nullable; optional required provider for the first attempt |
| `fallbackEnabled` | BOOLEAN | `false` | Enables one transient provider fallback retry for this agent when `provider_fallback_chain` has a next provider |
| `prerequisiteCommand` | TEXT | — | nullable; optional shell command run before prompt composition |
| `kind` | TEXT | `'user'` | `user` rows run through the normal CLI intake workflow; `system` rows are TamTam-owned built-ins dispatched to internal handlers |
| `createdAt` | REAL | — | NOT NULL |
| `updatedAt` | REAL | — | NOT NULL |

Agents are DB-only — there is no file-based agent definition. System-agent rows are seeded by TamTam for enabled projects; deletion writes a `settings` dismissal marker keyed as `system_agent_dismissed:<project>:<agentName>`. Seeding checks project-local agent-name conflicts with the same case-insensitive rule used by the public create route.

---

### `agentRevisions`

Append-only audit history for agent edits. Each PATCH/revert stores the previous `agents` row as JSON before mutating the live row. Nightly retention keeps the newest `skill_revision_retention_count` rows per agent.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `entityId` | TEXT | — | `agents.id` at edit time |
| `snapshot` | TEXT | — | JSON snapshot of the prior agent row |
| `author` | TEXT | — | `settings.user_name` or environment fallback |
| `note` | TEXT | — | nullable operator note |
| `createdAt` | REAL | — | Unix timestamp |

Index: `agent_revisions_entity_created` on `(entity_id, created_at)`.

---

### `recommendations`

Actionable project suggestions derived from agent outcomes and scheduler signals.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY; stable per project/type/agent |
| `project` | TEXT | — | NOT NULL; project name |
| `sourceKind` | TEXT | — | NOT NULL; job kind or subsystem that produced the recommendation |
| `sourceId` | TEXT | — | nullable; originating job ID |
| `agentId` | TEXT | — | nullable; related agent ID |
| `agentName` | TEXT | — | nullable; related agent display name |
| `type` | TEXT | — | NOT NULL; e.g. `agent_schedule_backoff` |
| `title` | TEXT | — | NOT NULL; short display title |
| `detail` | TEXT | — | NOT NULL; operator-facing explanation |
| `status` | TEXT | `open` | `open`, `dismissed`, `applied`, or `resolved` (auto-cleared after the triggering condition no longer holds) |
| `payload` | TEXT | — | nullable; JSON metadata for UI/actions |
| `createdAt` | REAL | — | NOT NULL; Unix timestamp |
| `updatedAt` | REAL | — | NOT NULL; Unix timestamp |

---

### `ghStatus`

Cache of GitHub status per project. Refreshed by the scheduler.

| Column | Type | Notes |
|--------|------|-------|
| `project` | TEXT | PRIMARY KEY |
| `releaseTag` | TEXT | nullable; latest release tag |
| `ci` | TEXT | nullable; `passing` / `failing` |
| `ciFailedUrl` | TEXT | nullable; URL to failed CI run |
| `headSha` | TEXT | nullable; latest remote commit SHA |
| `localHeadSha` | TEXT | nullable; latest local commit SHA |
| `fetchedAt` | TEXT | NOT NULL; ISO timestamp |

---

### `ghIssuesCache`

Cache of GitHub PRs and issues per project.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `project` | TEXT | — | PRIMARY KEY |
| `repo` | TEXT | — | NOT NULL; `owner/repo` |
| `prs` | TEXT | `'[]'` | JSON array of PR objects |
| `issues` | TEXT | `'[]'` | JSON array of issue objects |
| `fetchedAt` | REAL | — | NOT NULL; Unix timestamp |

---

### `ghIssueDetailCache`

Cache of the filtered detail payload used by `GET /api/projects/by-project/[name]/issues?pick_top=1`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | — | PRIMARY KEY |
| `project` | TEXT | — | NOT NULL |
| `number` | INTEGER | — | NOT NULL; GitHub issue number |
| `payload` | TEXT | — | NOT NULL; JSON issue detail after untrusted comments were dropped |
| `fetchedAt` | REAL | — | NOT NULL; Unix timestamp |

Index: unique `gh_issue_detail_cache_project_number` on `(project, number)`.

The payload is not returned blindly: every cache hit revalidates the issue author and cached comment authors against the current `trusted_github_users` plus project `safe_users` allowlist before responding.

---

### `ollama_usage`

Per-embedding telemetry for local Ollama `/api/embed` calls. Populated best-effort from the retrieval embedder and queried by `/api/stats/ollama`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | — | PRIMARY KEY AUTOINCREMENT |
| `ts` | REAL | — | NOT NULL; Unix timestamp (seconds) |
| `model` | TEXT | — | NOT NULL; embedding model name |
| `project` | TEXT | — | nullable; owning project when known |
| `sourceKind` | TEXT | — | nullable; `project_doc`, `agent_run`, `query`, or null when unavailable |
| `inputTokens` | INTEGER | `0` | NOT NULL; Ollama-reported `prompt_eval_count` or estimated fallback |
| `durationMs` | INTEGER | `0` | NOT NULL; Ollama-reported or wall-clock duration in milliseconds |

Index: `ollama_usage_ts` on `ts` for windowed stats queries.

### `queued_terminal_runs`

Terminal `run` requests that arrived while a blocking job (release/fix/run/agent) was running for the project. Instead of rejecting the user's prompt, the run route persists it here and drains it FIFO when the blocker clears — ahead of queued agents (user input has priority). DB-backed so a queued run survives a restart; boot recovery replays the head. Managed by `lib/terminal/pending-terminal-run.ts`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY; the queueId (uuid) the originating terminal polls |
| `project` | TEXT | — | NOT NULL |
| `enqueued_at` | REAL | — | NOT NULL; Unix timestamp (seconds), FIFO order |
| `payload` | TEXT | — | NOT NULL; JSON of the raw run inputs captured before prompt composition (`prompt`, `userPrompt`, `model`, `provider`, `permissionMode`, `resumeSessionId`, `personas`, `contextMeta`, `ghIssue*`, `attachmentPaths`) so a replay recomposes identically |
| `status` | TEXT | `pending` | NOT NULL; `pending` or `started` |
| `started_job_id` | TEXT | — | nullable; the spawned `run` job id, set when drained |

Index: `queued_terminal_runs_project_enqueued` on `(project, enqueued_at)` for per-project FIFO reads.

---

### `initiatives`

DB-backed backlog for the autonomous initiative engine (orchestrator-driven chore discovery and dispatch). Rows track code-verifiable work candidates (lint errors, TODOs, failing tests, type errors, etc.) and their pipeline progress.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL | — | PRIMARY KEY |
| `project` | TEXT | — | NOT NULL; owning project |
| `source` | TEXT | — | NOT NULL; `'mining'` (probe-driven, Phase 1) or `'pm'` (charter/manual, Phase 2) |
| `kind` | TEXT | — | NOT NULL; chore type: `'lint'`, `'type-error'`, `'failing-test'`, `'missing-test'`, `'todo'`, `'dep-bump'`, `'docs-gap'`, `'gh-issue'`, etc. |
| `title` | TEXT | — | NOT NULL; operator-facing one-liner |
| `rationale` | TEXT | — | NOT NULL; why this chore is being tracked |
| `prompt` | TEXT | — | NOT NULL; agent task prompt for this chore |
| `score` | DOUBLE PRECISION | `0` | NOT NULL; severity + decay; higher = higher priority |
| `status` | TEXT | `'proposed'` | NOT NULL; status lifecycle: `'proposed'` (just found) → `'queued'` (admitted to backlog) → `'running'` (dispatched, agent/release running) → `'shipped'` (released successfully) or `'failed'` (error + cooldown). Operators may move `proposed`/`queued` rows to `'rejected'` and restore rejected rows to `queued`; `superseded` is reserved. |
| `dedup_key` | TEXT | — | NOT NULL; unique `(project, dedup_key)` for de-duplication so re-detection of the same issue does not create duplicates |
| `release_id` | TEXT | — | nullable; associated job id while running. Initially the agent job id; replaced with the parent release job id once release-after-run starts the pipeline. |
| `attempts` | INTEGER | `0` | NOT NULL; dispatch attempt count; used to decay score on failure |
| `cooldown_until` | DOUBLE PRECISION | — | nullable; Unix timestamp (ms) when a failed chore's cooldown expires and it may be retried |
| `pinned_at` | DOUBLE PRECISION | — | nullable; Unix timestamp (ms) when an operator pinned the initiative ahead of unpinned queue items |
| `created_at` | DOUBLE PRECISION | — | NOT NULL; Unix timestamp (ms) when the chore was first detected |
| `updated_at` | DOUBLE PRECISION | — | NOT NULL; Unix timestamp (ms) of the last status/score update |

**Status Lifecycle:**
- `proposed` — newly detected by probes; awaiting admission to the backlog.
- `queued` — admitted to the backlog; eligible for dispatch when gates clear.
- `running` — dispatched; agent run or release pipeline is in progress.
- `shipped` — release merged successfully; cooldown cleared.
- `failed` — agent run or release failed; entry is in cooldown (`cooldown_until > now`).
- `rejected` — operator rejected the backlog item; the Miner will not reopen it. Restore moves it back to `queued` and clears pin/release/cooldown association fields.
- `superseded` — reserved for Phase 2 (charter/PM features).

**Constraints:** Unique index on `(project, dedup_key)` prevents duplicate backlog entries for the same work.

---

## Key Patterns

**Upsert** (used throughout `job-storage.ts`):
```typescript
db.insert(schema.jobs).values({ ... })
  .onConflictDoUpdate({ target: schema.jobs.id, set: { ... } })
  .run();
```

**Query by project**:
```typescript
db.select().from(schema.jobs).where(eq(schema.jobs.project, name)).all()
```

**Memory + DB hybrid**: Active jobs are kept in a memory cache (`jobs` Map in `job-storage.ts`) for fast access; `saveToDb()` persists them. On server restart the cache is cold — reads fall through to DB via `getJob(id)`.

**No FK enforcement**: Project names are stored as plain strings. Deleting a project does not cascade to jobs.

---

## Quick Reference

### Which table owns what

| Data | Table | Key |
|------|-------|-----|
| Global config (workspace path, Claude bin, verdict rules…) | `settings` | `key` |
| Project metadata + per-project pipeline flags | `projects` | `name` |
| Every run / review / fix / push / agent execution | `jobs` | `id` |
| Latest maintenance telemetry | `maintenance_status` | `key` |
| Project recommendations from agent/scheduler signals | `recommendations` | `id` |
| Reusable prompt blocks | `skills` | `id` |
| Scheduled automation configs | `agents` | `id` |
| Skill and agent edit audit history | `skillRevisions`, `agentRevisions` | `entityId` |
| GitHub CI status + release tag cache | `ghStatus` | `project` |
| GitHub PRs + issues cache (5 min TTL) | `ghIssuesCache` | `project` |
| Filtered issue-cruncher detail cache (5 min TTL) | `ghIssueDetailCache` | `project`, `number` |
| Local Ollama embedding telemetry | `ollama_usage` | `id` |

### Backup and inspect

```bash
# Hot backup via API (safe while running) — produces a pg_dump custom-format
# file under data/db/ (or $TAMTAM_BACKUP_DIR).
curl -X POST http://localhost:1337/api/settings/backup

# Verify the live DB (checks pgvector extension + table count)
pnpm db:verify

# Verify a .pgdump file without touching the live DB
node scripts/db-verify.js --backup data/db/tamtam-YYYYMMDD-HHMM.pgdump

# Restore a .pgdump (stops PM2, pg_restore --clean --if-exists, restart)
pnpm db:restore data/db/tamtam-YYYYMMDD-HHMM.pgdump

# Inspect directly with psql
psql "$DATABASE_URL" -c "\\dt"
psql "$DATABASE_URL" -c "SELECT project, kind, exit_code FROM jobs ORDER BY started_at DESC LIMIT 20;"

# Check cache freshness
psql "$DATABASE_URL" -c "SELECT project, to_timestamp(fetched_at) FROM gh_issues_cache;"
psql "$DATABASE_URL" -c "SELECT project, number, to_timestamp(fetched_at) FROM gh_issue_detail_cache;"
```

### Schema files

| File | Role |
|------|------|
| `lib/db/schema.ts` | Drizzle table definitions |
| `lib/db/index.ts` | DB connection (`pg.Pool` + drizzle/node-postgres) |
| `lib/jobs/storage.ts` | Job CRUD, memory cache, `markDone`, completion hooks |
| `lib/shared/config.ts` | Settings read/write with 5s TTL cache |

### Summary maintenance scripts

TamTam stores concise agent and issue-run summaries in `jobs.work_summary`. If older rows are missing that field, use the maintenance scripts below; they connect to the database referenced by `DATABASE_URL`.

| Command | Behavior |
|------|------|
| `pnpm backfill:issue-run-summaries` | Read/write. Scans finished issue-linked `run` jobs with an empty `work_summary`, extracts a summary from each NDJSON log, and updates matching DB rows. |
| `pnpm check:summary-extraction` | Read-only. Samples recent jobs with logs and prints the extracted summary so you can validate the parser before or after a backfill. |
| `pnpm peek:summary -- /abs/path/to/log.ndjson` | Read-only. Dumps the last parsed assistant paragraphs from a single log file to help debug why a summary was or was not extracted. |

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Job shows as running after server restart | Memory cache lost on restart; `finishedAt` never written | Job process died mid-run; `markDone` was never called — mark it manually via DB or rerun |
| `getJob(id)` returns null for a recent job | Job not yet persisted (`saveToDb` runs async) | Add a short delay or check again after 1s |
| Issues/PRs show stale data | `ghIssuesCache` TTL not expired (5 min) | Force refresh via the Refresh button or `POST /api/projects/by-project/[name]/issues?refresh=1` |
| Issue-cruncher body/comments stale | `ghIssueDetailCache` TTL not expired (5 min) | Call `GET /api/projects/by-project/[name]/issues?pick_top=1&refresh=1`; trust allowlist changes are still applied on every cache hit |
| Projects list empty after adding a repo | `projects` table not updated | Use Settings → workspace scan or `GET /api/config/projects` |
| Deleted project still appears in job history | No FK cascade — jobs retain the project name string | Expected behavior; filter by project name in the Runs page |
