# Caching — How It Works

Tamtam uses a layered caching strategy: in-memory TTL caches for hot read paths, a Postgres DB cache for expensive external calls. No Redis or external cache store required.

## When to read this

- Adding a new frequently-polled API endpoint (add a cache)
- Debugging stale data (understand TTLs and invalidation points)
- Understanding why a change isn't reflected immediately in the UI
- Auditing cache coverage before adding new polling

---

## Cache layers

### 1. In-memory TTL caches (server process)

Live in the Next.js server process. Lost on restart — clients see a cold miss on first request after restart, then warm on subsequent calls within TTL.

| Cache | File | TTL | Covers | Invalidated by |
|-------|------|-----|--------|----------------|
| Project data | `lib/shared/project-data.ts` | 10s | `/api/projects` response (tasks, priorities) | `clearProjectDataCache()` — called on project CRUD; invalidates any older in-flight refresh generation |
| Settings | `lib/shared/config.ts` | 5s | All settings reads via `getSettings()` | `reloadConfig()` — called by `PATCH /api/settings` |
| Agents list | `lib/agents/agents-cache.ts` | 10s | `GET /api/agents` (DB agents, filtered by project) | `clearAgentsCache()` — called on agent create/update/delete |

### 2. In-memory jobs Map (no TTL)

`lib/jobs/job-storage.ts` keeps all active and recent jobs in a `Map<string, JobData>`. This is the authoritative live store — no DB query needed for most job reads. Written to Postgres via `saveToDb()` on every state change; read back from DB on cache miss (e.g. after server restart, via `loadFromDb()` at boot).

Covers: `GET /api/jobs`, `GET /api/jobs/notifications`, `GET /api/jobs/[jobId]`

### 3. Postgres DB caches

Persist across restarts. Stale data is served until TTL expires or a force-refresh is triggered.

| Table | TTL | Covers | Force-refresh |
|-------|-----|--------|---------------|
| `gh_issues_cache` | 5 min | `GET /api/projects/by-project/[name]/issues` | `?refresh=1` query param |
| `gh_issue_detail_cache` | 5 min | `GET /api/projects/by-project/[name]/issues?pick_top=1` detail payloads | `?refresh=1` query param; cache hits still revalidate trusted authors before returning |
| `gh_status` | Refreshed by scheduler | GitHub CI status + release tag per project | Scheduler tick or manual scan |

---

## What is NOT cached

| Endpoint | Why |
|----------|-----|
| `GET /api/jobs/[jobId]` | Hits in-memory Map — already O(1), no DB needed |
| `GET /api/agents/[agentId]` | Single-row lookup — fast enough, infrequent |
| `GET /api/settings` | Reads via `getSettings()` which has its own 5s TTL |
| `POST/PATCH/DELETE *` | Mutations must never be cached |

---

## Invalidation rules

**Write-through pattern** (used everywhere): mutations call the cache-clear function immediately after the DB write, so the next read sees fresh data.

```
mutation → DB write → clearXxxCache() → next GET rebuilds cache
```

`project-data` additionally uses single-flight stale-while-revalidate for expired reads: concurrent cache misses share one rebuild, and an expired cached value can be returned while a background refresh runs. A later `clearProjectDataCache()` bumps the cache generation and detaches any older in-flight refresh, so a pre-mutation refresh cannot republish stale project data after the mutation.

| What changed | Clear function |
|--------------|---------------|
| Project enabled/disabled | `clearProjectDataCache()` in `lib/shared/project-data.ts` |
| Settings updated | `reloadConfig()` in `lib/shared/config.ts` |
| Agent created/updated/deleted | `clearAgentsCache()` in `lib/agents/agents-cache.ts` |
| Issues refreshed | Row upserted in `gh_issues_cache`; `?refresh=1` bypasses TTL check |
| Issue detail refreshed | Row upserted in `gh_issue_detail_cache`; `?refresh=1` bypasses TTL check; current trust allowlists are applied again on every cache hit |

---

## Quick Reference

### Cache miss symptoms

| Symptom | Cause | Wait or fix |
|---------|-------|-------------|
| Just-added project not in list | `project-data` cache warm | Wait up to 10s, or call `clearProjectDataCache()` |
| Agent change not reflected in table | Agents cache warm | Wait up to 10s, or create/update any agent to trigger invalidation |
| Issues count stale on main page | `gh_issues_cache` TTL | Wait up to 5 min, or hit `?refresh=1` on the issues endpoint |
| Issue-cruncher body/comments stale | `gh_issue_detail_cache` TTL | Wait up to 5 min, or hit `?pick_top=1&refresh=1`; removed trusted users are dropped immediately on cache hits |
| All data stale after server restart | In-memory caches lost | First request rebuilds all caches from DB |

### Verify cache is working

```bash
# Time back-to-back projects requests — second should be faster
time curl -s http://localhost:1337/api/projects > /dev/null
time curl -s http://localhost:1337/api/projects > /dev/null

# Check gh_issues_cache freshness
psql "$DATABASE_URL" -c \
  "SELECT project, to_timestamp(fetched_at) AS cached_at FROM gh_issues_cache ORDER BY fetched_at DESC;"

# Check gh_issue_detail_cache freshness
psql "$DATABASE_URL" -c \
  "SELECT project, number, to_timestamp(fetched_at) AS cached_at FROM gh_issue_detail_cache ORDER BY fetched_at DESC;"

# Check agents cache TTL by watching DB query logs (dev mode)
# Or run the cache-check agent from the Agents page
```

---

## Key files

| File | Role |
|------|------|
| `lib/shared/project-data.ts` | 10s TTL cache for project task data |
| `lib/shared/config.ts` | 5s TTL cache for all settings |
| `lib/agents/agents-cache.ts` | 10s TTL cache for DB agents; cleared by `clearAgentsCache()` |
| `lib/jobs/job-storage.ts` | In-memory jobs Map + DB persistence |
| `app/api/projects/by-project/[projectName]/issues/route.ts` | 5-min DB caches via `gh_issues_cache` and `gh_issue_detail_cache` |
| `app/api/jobs/notifications/route.ts` | Serves running jobs from in-memory Map (no extra DB query) |
