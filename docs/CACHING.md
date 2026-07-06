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

Several project-page caches (Branch info, Project config, Release plan, Agent stats) use **stale-while-revalidate** via `lib/shared/swr-cache.ts` (`swrGet` / `swrRefresh`): a short TTL alone barely helps a real user, because humans revisit a project minutes apart — far past any short TTL — so every visit would miss and pay the full recompute. SWR serves the last value immediately and refreshes in the background, so **only the first-ever load per project is slow**. Concurrent misses single-flight one compute.

**Why this matters — the cold-mount stampede.** The project page fires ~12 heavy requests concurrently on mount (branch, config, behind, issues-summary, release-plan, agent-stats, usage-quota, prompt-insights, …). Measured cold, they contend for git processes / DB connections / the event loop and **all** balloon to 4–7s each — even endpoints that are ~6ms in isolation. So per-endpoint timing under-reports the real cost; profile the page (browser Resource Timing), not one endpoint at a time. SWR is the lever: once a project's caches are warm, its header requests return from memory in ~ms and drop out of the stampede, so they no longer contend. The remaining cost is the first-ever cold load per project (and the first load after a server restart, when all in-memory caches are empty).

**Middleware auth-check memo (`middleware.ts`).** The Edge middleware gates every non-public request by delegating to `/api/auth/check` over an internal `fetch` (it needs the DB-stored hash + Node crypto, unavailable in Edge). That doubled the request count under the mount stampede (12 page requests → 12 extra auth checks) and put a ~280ms floor on even zero-work cache-hit endpoints. The middleware now single-flights concurrent identical checks into one fetch and memos the decision for a short TTL (keyed by `authorization` + `cookie`; only real HTTP responses cached; fail-closed on error). Trade-off: an auth-config change propagates in ≤ the TTL. This is why cache-hit header endpoints dropped from ~280ms to ~5ms under concurrency.

**Residual after all the above — client-side connection queuing.** With the server fast, the browser's own ~6-connections-per-host limit becomes the bottleneck: ~19 requests firing on mount queue over 6 sockets, so a 5ms endpoint can still show ~1s of `total` duration (mostly stalled/queued, not server time). The remaining lever is client-side: defer the non-header panels (AgentsStats, PromptInsights, usage-quota, …) until after the header paints, shrinking the concurrent burst.

| Cache | File | TTL | Covers | Invalidated by |
|-------|------|-----|--------|----------------|
| Project data | `lib/shared/project-data.ts` | 10s | `/api/projects` response (tasks, priorities) | `clearProjectDataCache()` — called on project CRUD; invalidates any older in-flight refresh generation |
| Settings | `lib/shared/config.ts` | 5s | All settings reads via `getSettings()` | `reloadConfig()` — called by `PATCH /api/settings` |
| Agents list | `lib/agents/agents-cache.ts` | 10s | `GET /api/agents` (DB agents, filtered by project) | `clearAgentsCache()` — called on agent create/update/delete |
| Branch info | `app/api/projects/by-project/[projectName]/branch/route.ts` | 5s (SWR) | `GET …/branch` (current branch, default branch, commitsAhead) — drives header branch label + Create-PR button | Stale-while-revalidate + single-flight (`__tamtamBranchInfoCache` / `__tamtamBranchInfoInflight`). Compute spawns 2–3 git processes; SWR means only the first-ever load pays for it |
| Project config | `lib/shared/project-config-cache.ts` (`__tamtamConfigCache` / `__tamtamConfigInflight`) | 5s (SWR) | `GET …/config` (paused, auto-release, test/dev/website config) — drives the header Paused pill + Release/Auto-release buttons | `clearConfigCache()` on `PATCH …/config`; **plus** the client sends `x-tamtam-refresh: 1` on its post-mutation refetch (`fetchProjectConfig({force:true})`) → `swrRefresh` recomputes synchronously (mutation correctness). Passive reads are SWR + single-flight. Compute does an fs test-command probe + `.tamtam/config.yml` read + several DB reads |
| Release plan | `app/api/projects/by-project/[projectName]/release/plan/route.ts` (`__tamtamReleasePlanCache` / `__tamtamReleasePlanInflight`) | 5s (SWR) | `GET …/release/plan` (dry-run of the Release button) — drives the ReleasePlanPanel | SWR + single-flight; read-only, side-effect-free (the panel re-fetches as inputs settle and the real Release re-checks at launch). Compute does ~5–6 read-only git spawns + fs probe + DB reads; a rejected compute is not cached |
| Agent stats | `app/api/agents/stats/route.ts` (`__tamtamAgentStatsCache` / `__tamtamAgentStatsInflight`) | 10s (SWR) | `GET /api/agents/stats?project=…` (per-agent run rollup) — drives the AgentsStats panel | SWR + single-flight; read-only. Compute pulls every `agent:*` job row for the project and aggregates in JS, so it was a heavy contributor to the cold project-page request stampede |
| Behind/ahead | `app/api/projects/by-project/[projectName]/behind/route.ts` (`__tamtamBehindCache` / `__tamtamBehindInflight`) | 60s (SWR) | `GET …/behind` ("N commits behind" badge) | SWR + single-flight. Compute does a network `git fetch`; SWR keeps that blocking fetch off the mount critical path — the badge serves stale and refreshes in the background |

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
| Project config updated | `clearConfigCache()` in `lib/shared/project-config-cache.ts` (called by `PATCH …/config`); the client's forced refetch also sends `x-tamtam-refresh: 1` to bypass the server cache |
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
| `lib/shared/swr-cache.ts` | Single-flight stale-while-revalidate primitive (`swrGet` / `swrRefresh` / `swrClear`); backs the branch, config, and release-plan header caches |
| `lib/shared/project-data.ts` | 10s TTL cache for project task data |
| `lib/shared/config.ts` | 5s TTL cache for all settings |
| `lib/agents/agents-cache.ts` | 10s TTL cache for DB agents; cleared by `clearAgentsCache()` |
| `lib/jobs/job-storage.ts` | In-memory jobs Map + DB persistence |
| `app/api/projects/by-project/[projectName]/issues/route.ts` | 5-min DB caches via `gh_issues_cache` and `gh_issue_detail_cache` |
| `app/api/jobs/notifications/route.ts` | Serves running jobs from in-memory Map (no extra DB query) |
