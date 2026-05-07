# API Routes

Complete reference for TamTam HTTP API routes. All routes live under `app/api/`. New routes must have a matching test in `__tests__/api/<route-name>.test.ts`.

## Agents

- `/api/agents` — CRUD for agents (GET: accepts `?project=` and `?name=` filters, POST)
- `/api/agents/[agentId]` — Agent detail (GET, PATCH, DELETE)
- `/api/agents/[agentId]/run` — Run agent (POST) — composes skills into prompt; returns `200 { status: 'started', job_id, pid, agent }`, `202 { status: 'queued', detail, agent, blockingJobId?, code? }` when another agent on the same project is running/still starting, when an active release lock defers the run with `code: 'pipeline_lock'`, or when an older queued release must run first with `code: 'pending_release'`; returns `409 { code: 'already_running'|'already_starting'|'project_busy', detail, blockingJobId? }` for same-agent duplicates, start-slot duplicates, or when a non-agent project job is already running. Manual (non-scheduled) agent runs bypass `jobs_paused`; scheduled runs are still blocked by the global pause.
- `/api/agents/by-name` — Update agent by project+name without knowing its UUID (PATCH: `{ project, name, ...fields }`) — enables agents to self-improve
- `/api/agents/scheduler-health` — Verify the internal scheduler matches the DB (GET returns `{ ok, expected, actual, missing, orphans, errors, internal: { started, entries: [...] } }`); POST reinstalls anything missing and sweeps legacy PM2 cron orphans, returns `{ before, after, installed, installFailures }`. Surfaced on `/monitoring`.

## Skills

- `/api/skills` — CRUD for skills (GET, POST)
- `/api/skills/[skillId]` — Skill detail (GET, PATCH, DELETE)

## Projects

- `/api/projects` — All projects list (GET)
- `/api/projects/personas` — File-based skills from `skills/docs/skills/` (GET)
- `/api/projects/[schedId]/priority` — Set project scheduling priority (PATCH)
- `/api/projects/[schedId]/pause` — Pause project scheduling (POST)
- `/api/projects/[schedId]/resume` — Resume project scheduling (POST)
- `/api/projects/[schedId]/detail` — Project scheduling detail (GET)
- `/api/config/projects` — Scan workspace for git repos and configure projects (GET, PATCH)

## Project actions (`by-project/[name]/...`)

- `action` — Custom actions (GET, PUT, POST). POST is pause-gated and returns `409 { detail }` when `jobs_paused` is enabled globally.
- `config` — Project test command + workflow flags + per-project pipeline prompt addenda (`review_prompt_addendum`, `fix_prompt_addendum`) (GET, PATCH)
- `run` — Run Claude on project (POST, accepts `model` param). Returns `409 { detail, blocking_job_id }` when another job is already running for the project. Manual terminal runs bypass `jobs_paused` — the global pause does not block this endpoint.
- `review` — Start AI code review (POST)
- `review-pr` — Start AI review of a GitHub PR (POST). PR review prompts ignore `.tamtam/` metadata changes unless the review is explicitly about TamTam configuration.
- `fix-ci` — Start AI CI fix run (POST). Returns `409 { detail, blocking_job_id }` when another job is already running for the project
- `test` — Run project test command (POST)
- `changes` — Uncommitted changes summary (GET, returns `defaultBranch`/`branch`/`ahead`/`behind`/`files`); git pull with strategy (POST: ff-only/merge/rebase). Pull returns `409 { detail, diverged: true }` on branch divergence and `409 { detail }` when the working tree has tracked or untracked local changes, so callers must commit or stash before pulling.
- `changes/diff` — Full git diff content (GET)
- `checkout-default` — Switch to default branch; refuses if uncommitted changes (POST → `{ status: 'switched'|'already-on-branch', branch }`)
- `push` — Push changes to git (POST). Accepts optional JSON body `{ commit?: boolean, release_id?: string }`: `commit: true` runs the commit step first, and `release_id` keeps manual retry/continue pushes linked to an active release chain
- `create-pr` — Push current branch + create GitHub PR (POST → `{ url }`); refuses on default branch
- `release` — Trigger release pipeline (POST)
- `release/[releaseId]` — Release detail: meta-job + ordered pipeline step jobs with verdicts and log excerpts (GET)
- `release/abort` — Abort active release: marks release job aborted, kills running step, releases lock (POST)
- `issues` — GitHub PRs and issues (GET, with `?refresh=1` to bypass cache); POST merges or approves a PR and switches working copy to default after merge
- `issue-branch` — Create or checkout `fix/issue-<n>-<slug>` before Claude edits (POST)
- `continue-issue` — Build a "Continue work" payload for an issue (GET: `?issue_number=N`); returns `{ sessionId, provider, prompt, unverifiedCount, hasContext }`
- `mark-dod` — Run DoD verification for latest issue-linked run (POST); also triggered automatically after review→LGTM
- `pr-branch` — Fetch and checkout a PR's head branch (POST: `{ branch }`)
- `pr-gates` — TamTam-side gate state for a PR: tests/review/DoD badges (GET)
- `branch` — Current + default branch (GET → `{ branch, defaultBranch, commitsAhead }`); no `git fetch` issued
- `behind` — Ahead/behind commit counts vs remote (GET)
- `logs` — Project run log files (GET)
- `docs` — Project documentation files (GET)
- `recommendations` — GET; PATCH `{ id, status }` to update

## Jobs / Runs

- `/api/jobs` — All runs across projects (GET)
- `/api/jobs/[jobId]` — Job detail (GET, DELETE). `GET` returns parsed log text for normal jobs, but returns the raw aggregated `log` for `release` jobs because release logs mix plain shell output with NDJSON child streams
- `/api/jobs/[jobId]/logs` — Job log content (GET)
- `/api/jobs/[jobId]/board-sync` — Manually sync a finished root job to the GitHub project board (POST); rejects running jobs, requires board sync configured, surfaces GitHub failures instead of swallowing them
- `/api/jobs/[jobId]/rerun` — Re-run a job (POST). Returns `409 { detail, blocking_job_id }` when another job is already running for the project
- `/api/jobs/[jobId]/fix` — Start AI fix run for a failed job (POST)
- `/api/jobs/[jobId]/seen` — Mark job as seen (POST)
- `/api/jobs/notifications` — Unseen job notifications (GET)
- `/api/jobs/notifications/mark-seen` — Mark all notifications seen (POST)
- `/api/streaming/[jobId]` — SSE stream of parsed text deltas from NDJSON log (`?raw=1` for raw lines)

## Settings

- `/api/settings` — Settings CRUD (GET, PATCH) — includes GitHub board sync, CLI routing/binary/model, `base_prompt`, permission mode, pipeline model overrides, budget gates, retention, and all `notification_*` keys
- `/api/settings/test-notification` — Send a test webhook payload (POST)
- `/api/settings/board-resync` — Re-run `syncJobToProjectBoard(job, 'manual')` for the most recent release/agent/run jobs (default last 7d, top 100; `?days=`/`?limit=`); skips pipeline child jobs, stops on GitHub secondary rate-limit, 250 ms inter-call delay (POST → `{ ok, days, limit, scanned, resynced, failed, rateLimited }`)
- `/api/settings/backup` — SQLite hot backup (POST)

GitHub board cards carry four TEXT custom fields provisioned by `ensureProjectBoard`: **Project**, **Agent** (empty for non-agent runs), **Run kind**, **Branch**. Field IDs persisted under `github_board_custom_field_ids`. Values written on first sync of a card and skipped on subsequent syncs unless they change. `github_board_view_url` (optional UI URL override) and `github_board_custom_field_ids` round-trip through `lib/shared/config.ts`.

## Health / Monitoring / Stats

- `/api/health` — Health check (GET)
- `/api/monitoring` — Prometheus + Loki status aggregation (GET); env: `PROMETHEUS_URL`, `LOKI_URL`
- `/api/monitoring/pm2-logs` — Tail tamtam PM2 log files (error + out from `~/.pm2/logs/`), last 64 KB; `?limit=` (max 500), `?out=0` to suppress stdout (GET)
- `/api/stats/usage` — Token usage per project and per agent kind (GET, `?window=24h|7d|30d|all`)
- `/api/stats/pipeline` — Pipeline health metrics: verdict distribution, recovery-loop stats (`fix` and `fix-push`, attributed by `releaseId` when present and otherwise by the enclosing release window), step durations, MTTR, per-project breakdown, and active recovery-budget config snapshot (`maxStepIterations`, `maxFixPushAttempts`, `stepWindowSeconds`; sourced from the same helper as runtime enforcement) (GET, `?window=...`, `?project=`; 60s cache)
- `/api/usage/quota` — Active provider quota snapshot (`?provider=claude|codex` overrides). GET/POST return `QuotaSnapshot & { gateEnabled: boolean, schedulerThrottle: null | { reason: string, projectedPct: number, worstProvider: 'claude'|'codex', resumesAtMs: number | null } }`. `schedulerThrottle` is the server-computed multi-provider scheduled-agent weekly-throttle verdict: it is non-null only when every enabled provider that can actually run scheduled work is blocked on the 7d burn cap. Providers without quota fetchers (`gemini`, `lmstudio`) count as available fallback and keep `schedulerThrottle` null; quota-aware providers (`claude`, `codex`) count as unavailable only when their snapshot is missing while a sibling quota-aware provider has known quota data. POST force-clears cache and re-fetches all enabled quota-aware providers before computing that verdict; 502 when provider data unavailable.
