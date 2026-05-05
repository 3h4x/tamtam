# API Routes

Complete reference for TamTam HTTP API routes. All routes live under `app/api/`. New routes must have a matching test in `__tests__/api/<route-name>.test.ts`.

## Agents

- `/api/agents` — CRUD for agents (GET: accepts `?project=` and `?name=` filters, POST)
- `/api/agents/[agentId]` — Agent detail (GET, PATCH, DELETE)
- `/api/agents/[agentId]/run` — Run agent (POST) — composes skills into prompt; returns `200 { status: 'started', job_id, pid, agent }`, `202 { status: 'queued', detail, agent, blockingJobId? }` when another agent on the same project is running or still starting, and `409` for same-agent duplicates
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

- `action` — Custom actions (GET, PUT, POST)
- `config` — Project test command config (GET, PATCH)
- `run` — Run Claude on project (POST, accepts `model` param)
- `review` — Start AI code review (POST)
- `review-pr` — Start AI review of a GitHub PR (POST)
- `fix-ci` — Start AI CI fix run (POST)
- `test` — Run project test command (POST)
- `changes` — Uncommitted changes summary (GET, returns `defaultBranch`/`branch`/`ahead`/`behind`/`files`); git pull with strategy (POST: ff-only/merge/rebase)
- `changes/diff` — Full git diff content (GET)
- `checkout-default` — Switch to default branch; refuses if uncommitted changes (POST → `{ status: 'switched'|'already-on-branch', branch }`)
- `push` — Push changes to git (POST)
- `create-pr` — Push current branch + create GitHub PR (POST → `{ url }`); refuses on default branch
- `release` — Trigger release pipeline (POST)
- `release/[releaseId]` — Release detail: meta-job + ordered pipeline step jobs with verdicts and log excerpts (GET)
- `release/abort` — Abort active release: marks release job aborted, kills running step, releases lock (POST)
- `issues` — GitHub PRs and issues (GET, with `?refresh=1` to bypass cache); POST merges or approves a PR and switches working copy to default after merge
- `issue-branch` — Create or checkout `fix/issue-<n>-<slug>` before Claude edits (POST)
- `continue-issue` — Build a "Continue work" payload for an issue (GET: `?issue_number=N`); returns `{ sessionId, prompt, unverifiedCount, hasContext }`
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
- `/api/jobs/[jobId]` — Job detail (GET, DELETE)
- `/api/jobs/[jobId]/logs` — Job log content (GET)
- `/api/jobs/[jobId]/board-sync` — Manually sync a finished root job to the GitHub project board (POST); rejects running jobs, requires board sync configured, surfaces GitHub failures instead of swallowing them
- `/api/jobs/[jobId]/rerun` — Re-run a job (POST)
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
- `/api/stats/pipeline` — Pipeline health metrics: verdict distribution, fix-loop stats, step durations, MTTR, per-project breakdown (GET, `?window=...`, `?project=`; 60s cache)
- `/api/usage/quota` — Active provider quota snapshot (`?provider=claude|codex` overrides). GET → `QuotaSnapshot` with fiveHour/sevenDay utilization and gate state; POST force-clears cache and re-fetches; 502 when provider data unavailable.
