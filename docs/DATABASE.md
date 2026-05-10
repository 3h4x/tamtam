# Database — Schema Reference

SQLite with WAL mode. Drizzle ORM. DB at `data/db/tamtam.db` (gitignored). Schema in `lib/db/`.

## When to read this

- Adding a new column or table (check existing schema first)
- Debugging missing data after a server restart (memory vs DB cache)
- Understanding job kinds when filtering runs
- Writing a new query in `lib/job-storage.ts` or related files

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
| `fixPromptAddendum` | TEXT | — | nullable; appended to the standard fix prompt under "Project-specific fix guidance" |

---

### `jobs`

Audit trail for every run, review, fix, test, push, agent execution.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY; format: `{project}-{kind}-{timestamp}` |
| `project` | TEXT | — | NOT NULL; project name |
| `kind` | TEXT | — | NOT NULL; see [Job Kinds](#job-kinds) |
| `prompt` | TEXT | — | nullable; prompt sent to Claude |
| `pid` | INTEGER | — | NOT NULL; PM2 process ID |
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
| `workSummary` | TEXT | — | nullable; concise agent-reported outcome summary |
| `modifiedFiles` | TEXT | — | nullable; JSON array of files changed by an agent run |

#### Job Kinds

| Kind | Description |
|------|-------------|
| `run` | Interactive terminal session |
| `review` | AI code review |
| `fix` | AI fix from review session |
| `fix-ci` | AI fix for CI failures (auto-retry capable) |
| `fix-push` | AI fix for pre-commit/pre-push hook rejections |
| `test` | Project test command |
| `push` | Git commit + push |
| `release` | Meta-job wrapping the full pipeline |
| `action` | Custom action (user-defined bash) |
| `agent:{agentId}` | Scheduled agent execution |

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

### `agents`

Configuration for scheduled automated agents.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | — | PRIMARY KEY |
| `name` | TEXT | — | NOT NULL |
| `project` | TEXT | — | NOT NULL; project name |
| `skillIds` | TEXT | `'[]'` | JSON array of skill IDs |
| `model` | TEXT | `'normal'` | Semantic tier stored by new writes: `fast` / `normal` / `smart`. Legacy rows may still contain `haiku` / `sonnet` / `opus` aliases and are normalized on read. |
| `prompt` | TEXT | `''` | Task prompt for scheduled runs |
| `schedule` | TEXT | — | nullable; e.g. "1h", "30m"; null = manual only |
| `runner` | TEXT | `'pm2'` | `pm2` or `launchctl` |
| `enabled` | INTEGER | `true` | Boolean |
| `createdAt` | REAL | — | NOT NULL |
| `updatedAt` | REAL | — | NOT NULL |

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
| `status` | TEXT | `open` | `open`, `dismissed`, or `applied` |
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
| Project recommendations from agent/scheduler signals | `recommendations` | `id` |
| Reusable prompt blocks | `skills` | `id` |
| Scheduled automation configs | `agents` | `id` |
| GitHub CI status + release tag cache | `ghStatus` | `project` |
| GitHub PRs + issues cache (5 min TTL) | `ghIssuesCache` | `project` |

### Backup and inspect

```bash
# Hot backup via API (safe while running)
curl -X POST http://localhost:1337/api/settings/backup

# Inspect directly with sqlite3
sqlite3 data/db/tamtam.db ".tables"
sqlite3 data/db/tamtam.db "SELECT project, kind, exit_code FROM jobs ORDER BY started_at DESC LIMIT 20;"

# Check cache freshness
sqlite3 data/db/tamtam.db "SELECT project, datetime(fetched_at, 'unixepoch') FROM gh_issues_cache;"
```

### Schema files

| File | Role |
|------|------|
| `lib/db/schema.ts` | Drizzle table definitions |
| `lib/db/index.ts` | DB connection + WAL mode init |
| `lib/job-storage.ts` | Job CRUD, memory cache, `markDone`, completion hooks |
| `lib/config.ts` | Settings read/write with 5s TTL cache |

### Summary maintenance scripts

TamTam stores concise agent and issue-run summaries in `jobs.work_summary`. If older rows are missing that field, use the maintenance scripts below against the intended SQLite database.

Set `TAMTAM_DB_PATH=/abs/path/to/tamtam.db` to target a non-default database. If unset, the scripts use `data/db/tamtam.db` under the repo root.

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
| Projects list empty after adding a repo | `projects` table not updated | Use Settings → workspace scan or `GET /api/config/projects` |
| Deleted project still appears in job history | No FK cascade — jobs retain the project name string | Expected behavior; filter by project name in the Runs page |
