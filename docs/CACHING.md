# Caching — How It Works

Tamtam uses a layered caching strategy: in-memory TTL caches for hot read paths, a SQLite DB cache for expensive external calls. No Redis or external cache store required.

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
| Project data | `lib/project-data.ts` | 10s | `/api/projects` response (tasks, priorities) | `clearProjectDataCache()` — called on project CRUD |
| Settings | `lib/config.ts` | 5s | All settings reads via `getSettings()` | `reloadConfig()` — called by `PATCH /api/settings` |
| Agents list | `app/api/agents/route.ts` | 10s | `GET /api/agents` (all agents, filtered by project) | `clearAgentsCache()` — called on agent create/update/delete |

### 2. In-memory jobs Map (no TTL)

`lib/job-storage.ts` keeps all active and recent jobs in a `Map<string, JobData>`. This is the authoritative live store — no DB query needed for most job reads. Written to SQLite via `saveToDb()` on every state change; read back from DB on cache miss (e.g. after server restart).

Covers: `GET /api/jobs`, `GET /api/jobs/notifications`, `GET /api/jobs/[jobId]`

### 3. SQLite DB caches

Persist across restarts. Stale data is served until TTL expires or a force-refresh is triggered.

| Table | TTL | Covers | Force-refresh |
|-------|-----|--------|---------------|
| `gh_issues_cache` | 5 min | `GET /api/projects/by-project/[name]/issues` | `?refresh=1` query param |
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

| What changed | Clear function |
|--------------|---------------|
| Project enabled/disabled | `clearProjectDataCache()` in `lib/project-data.ts` |
| Settings updated | `reloadConfig()` in `lib/config.ts` |
| Agent created/updated/deleted | `clearAgentsCache()` in `app/api/agents/route.ts` |
| Issues refreshed | Row upserted in `gh_issues_cache`; `?refresh=1` bypasses TTL check |

---

## Quick Reference

### Cache miss symptoms

| Symptom | Cause | Wait or fix |
|---------|-------|-------------|
| Just-added project not in list | `project-data` cache warm | Wait up to 10s, or call `clearProjectDataCache()` |
| Agent change not reflected in table | Agents cache warm | Wait up to 10s, or create/update any agent to trigger invalidation |
| Issues count stale on main page | `gh_issues_cache` TTL | Wait up to 5 min, or hit `?refresh=1` on the issues endpoint |
| All data stale after server restart | In-memory caches lost | First request rebuilds all caches from DB |

### Verify cache is working

```bash
# Time back-to-back projects requests — second should be faster
time curl -s http://localhost:1337/api/projects > /dev/null
time curl -s http://localhost:1337/api/projects > /dev/null

# Check gh_issues_cache freshness
psql "$DATABASE_URL" -c \
  "SELECT project, to_timestamp(fetched_at) AS cached_at FROM gh_issues_cache ORDER BY fetched_at DESC;"

# Check agents cache TTL by watching DB query logs (dev mode)
# Or run the cache-check agent from the Agents page
```

---

## Key files

| File | Role |
|------|------|
| `lib/project-data.ts` | 10s TTL cache for project task data |
| `lib/config.ts` | 5s TTL cache for all settings |
| `app/api/agents/route.ts` | 10s TTL cache for agents list + `clearAgentsCache()` |
| `lib/job-storage.ts` | In-memory jobs Map + DB persistence |
| `app/api/projects/by-project/[name]/issues/route.ts` | 5-min DB cache via `gh_issues_cache` |
| `app/api/jobs/notifications/route.ts` | Serves running jobs from in-memory Map (no extra DB query) |
