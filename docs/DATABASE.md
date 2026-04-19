# Database — Schema Reference

SQLite with WAL mode. Drizzle ORM. DB at `data/db/tamtam.db` (gitignored). Schema in `lib/db/`.

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
| `model` | TEXT | `'sonnet'` | `haiku` / `sonnet` / `opus` |
| `prompt` | TEXT | `''` | Task prompt for scheduled runs |
| `schedule` | TEXT | — | nullable; e.g. "1h", "30m"; null = manual only |
| `runner` | TEXT | `'pm2'` | `pm2` or `launchctl` |
| `enabled` | INTEGER | `true` | Boolean |
| `createdAt` | REAL | — | NOT NULL |
| `updatedAt` | REAL | — | NOT NULL |

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
