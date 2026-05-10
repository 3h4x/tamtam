# API Routes

Complete reference for TamTam HTTP API routes. All routes live under `app/api/`. New routes must have a matching test in `__tests__/api/<route-name>.test.ts`.

## Agents

- `/api/agents` — CRUD for agents (GET: accepts `?project=` and `?name=` filters, POST). POST accepts optional `prerequisiteCommand`, a shell command stored on the agent and run before the agent CLI starts. When `skillIds` contains `agent-issue-cruncher` and `prerequisiteCommand` is omitted, TamTam stores a default trusted-only issues fetch against the local API; explicit `null` / empty-string clears remain cleared instead of re-enabling that default.
- `/api/agents/[agentId]` — Agent detail (GET, PATCH, DELETE). PATCH accepts optional `prerequisiteCommand`; `null` or an empty string clears it.
- `/api/agents/[agentId]/run` — Run agent (POST) — composes skills into prompt; body accepts `{ prompt: string, readOnly?: boolean }`. If the agent has `prerequisiteCommand`, the route creates the job row first so the run is visible and cancellable during the prerequisite, then runs the command with `bash -c` in the project directory, captures stdout/stderr to `<logDir>/<jobId>.prereq.txt`, and prepends a summary block to the agent prompt. Returns `200 { status: 'started', job_id, pid, agent }` or `200 { status: 'cancelled', job_id }` when the prerequisite is cancelled before the agent CLI spawns; returns `202 { status: 'queued', detail, agent, blockingJobId?, code? }` when another agent on the same project is running/still starting, when an active release lock defers the run with `code: 'pipeline_lock'`, or when an older queued release must run first with `code: 'pending_release'`; returns `409 { code: 'already_running'|'already_starting'|'project_busy', detail, blockingJobId? }` for same-agent duplicates, start-slot duplicates, or when a non-agent project job is already running. With `readOnly: true`, the route skips local-worktree serialization gates: non-agent project busy checks, different-agent queueing/start-slot checks, pending-release re-acquire checks, and dirty-worktree checks. It still enforces same-agent duplicate rejection, active release pipeline locks, and CLI quota/pause gates. Manual agent runs are allowed on `fix/issue-*` branches; scheduled runs are still skipped there by the internal scheduler. Manual (non-scheduled) agent runs bypass `jobs_paused`; scheduled runs are still blocked by the global pause.
- `/api/agents/by-name` — Update agent by project+name without knowing its UUID (PATCH: `{ project, name, ...fields }`) — mirrors `/api/agents/[agentId]` writable fields, including `prerequisiteCommand`, and enables agents to self-improve
- `/api/agents/stats` — Per-agent aggregates for an Overview dashboard. GET requires `?project=<name>` and returns `200 { project, agents: [{ name, runs, finishedRuns, successfulRuns, avgDurationMs, totalDurationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd, modifiedFilesCount, reviewFixesTriggered }] }`; returns `400` when `project` is missing and `500 { detail }` on unexpected database errors. Aggregates are computed from rows in `jobs` whose `kind = 'agent:<name>'`. `reviewFixesTriggered` counts `fix` jobs that share a `release_id` with one of this agent's runs and is non-zero only when the agent name matches `/review/i` — a rough proxy for "fixes triggered per review".
- `/api/agents/improve-prompt` — Rewrite a draft agent prompt with project context (POST: `{ project, draftPrompt, skillIds?, docPaths? }`). The route builds context from TamTam's agent primer, project `CLAUDE.md`, selected docs, and selected skills/personas, then invokes the configured Claude-compatible fast provider. Returns `200 { improvedPrompt }`; returns `400` for invalid input, `404` when the project is unknown, `413` when `draftPrompt` exceeds 32 KiB, `429 { code: 'providers_over_budget', detail }` when all enabled providers are budget-blocked, and `502` when the provider exits unsuccessfully or returns empty output. No job row is created.
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
- `config` — Project test command + DB-backed pipeline toggles (`test_cron_enabled`, `auto_commit_enabled`, `auto_push_enabled`, `auto_pr_merge_enabled`, `release_after_run`, `tests_disabled`, `review_disabled`, `issue_auto_branch`) + per-project pipeline prompt addenda (`review_prompt_addendum`, `fix_prompt_addendum`) + file-backed commit-message style override (`commit_style`) (GET, PATCH). `pr_workflow_enabled` is no longer part of this route contract; push-vs-PR behavior is derived from the checked-out branch at runtime. `commit_style` is stored in `.tamtam/config.yml`; empty string clears the project override so commit generation falls back to the global setting.
- `run` — Run Claude on project (POST, accepts `model` param). Returns `409 { detail, blocking_job_id }` when another job is already running for the project. Manual terminal runs bypass `jobs_paused` — the global pause does not block this endpoint.
- `review` — Start AI code review (POST)
- `review-pr` — Start AI review of a GitHub PR (POST). PR review prompts ignore `.tamtam/` metadata changes unless the review is explicitly about TamTam configuration.
- `fix-ci` — Start AI CI fix run (POST). Returns `409 { detail, blocking_job_id }` when another job is already running for the project
- `test` — Run project test command (POST)
- `changes` — Uncommitted changes summary (GET, returns `defaultBranch`/`branch`/`ahead`/`behind`/`files`); git pull with strategy (POST: ff-only/merge/rebase). Pull returns `409 { detail, diverged: true }` on branch divergence and `409 { detail }` when the working tree has tracked or untracked local changes, so callers must commit or stash before pulling.
- `changes/diff` — Full git diff content (GET)
- `checkout-default` — Switch to default branch; refuses if uncommitted changes (POST → `{ status: 'switched'|'already-on-branch', branch }`)
- `push` — Push changes to git (POST). Accepts optional JSON body `{ commit?: boolean, release_id?: string }`: `commit: true` runs the commit step first; `release_id` keeps manual push retries linked to the active release chain, and with `commit: true` it also allows the History "Retry commit" flow to re-run the failed commit for the latest finished release on that project
- `create-pr` — Push current branch + create GitHub PR (POST → `{ url }`). Accepts optional JSON body `{ force?: boolean }`; `force: true` retries with `git push --no-verify` to skip the local pre-push hook after an explicit user confirmation flow. Refuses on the default branch. Returns `409 { detail, hookFailure: 'pre-push-tests'|'pre-push-other', retryable: true }` when a retryable pre-push-hook failure blocks the initial push; non-hook push failures remain `500`.
- `release` — Trigger release pipeline (POST)
- `release/[releaseId]` — Release detail: meta-job + ordered pipeline step jobs with verdicts and log excerpts (GET)
- `release/abort` — Abort active release (POST). On the fast path it marks the release aborted, stops the running step, finalizes the release, and releases the lock. If the active inline `commit`/`push` step acknowledges cancellation but does not unwind within 20s, it returns `409 { status: 'abort_pending', detail, release_id, killed_job_id: null }`; the late step completion then finalizes the release as aborted, stops the monitor, and releases the lock without requiring a second abort request.
- `issues` — GitHub PRs and issues (GET, with `?refresh=1` to bypass cache). `?trusted_only=1` filters the returned `issues` array server-side to authors trusted by the union of global `trusted_github_users` and per-project `.tamtam/config.yml` `security.safe_users`; the `prs` array is left untouched. By default the response is slim: each issue is stripped to `{number, title, labels, author, url}` and each PR to `{number, title, labels, author, url, branch, isDraft}`. Pass `?full=1` to include `body`, `assignees`, and all other raw fields. POST merges or approves a PR and switches working copy to default after merge
- `issue-branch` — Create or checkout `fix/issue-<n>-<slug>` before Claude edits (POST)
- `continue-issue` — Build a "Continue work" payload for an issue (GET: `?issue_number=N`); returns `{ sessionId, provider, prompt, unverifiedCount, hasContext }`
- `issues/[number]/close-stale` — Post a verdict comment then close the issue (POST: `{ findings: string; reason?: 'stale' | 'duplicate' | 'wontfix' | 'fixed' }`). `reason` defaults to `stale`; `fixed` maps to GitHub state-reason `completed`, everything else maps to `not_planned`. Returns `{ status: 'closed', issue, repo, reason, verdict }`; `502` when the `gh` CLI calls fail.
- `mark-dod` — Run DoD verification for the latest release-linked issue or PR context (POST); also triggered automatically after review→LGTM and after successful PR-producing pushes when auto-merge is off
- `pr-branch` — Fetch and checkout a PR's head branch (POST: `{ branch }`)
- `pr-gates` — TamTam-side gate state for a PR: tests/review/DoD badges (GET)
- `branch` — Current + default branch (GET → `{ branch, defaultBranch, commitsAhead }`); no `git fetch` issued
- `behind` — Ahead/behind commit counts vs remote (GET)
- `logs` — Project run log files (GET)
- `docs` — Project documentation files (GET)
- `recommendations` — GET; PATCH `{ id, status }` to update non-terminal state (`open` or `dismissed`)
- `recommendations/apply` — Apply an auto-applicable recommendation server-side (POST `{ id }`). Validates the recommendation is still `open`, performs the underlying mutation, then marks the row `applied`; returns `409 { detail }` when the recommendation is stale/non-open

## Jobs / Runs

- `/api/jobs` — All runs across projects (GET). Returns `{ jobs, total, pendingReleaseProjects }`; `total` is counted after the optional `project` filter and before any `limit` slice.
- `/api/jobs/[jobId]` — Job detail (GET, DELETE). `GET` returns a display-oriented `log`: `release` jobs return the raw aggregated log verbatim, while other jobs return parsed Claude output with any non-NDJSON passthrough lines (for example agent prerequisite output) preserved ahead of the parsed stream. `DELETE` cooperatively cancels inline `commit`/`push` jobs; if they do not stop cleanly within 20s it returns `409 { detail }` instead of force-killing the server PID.
- `/api/jobs/[jobId]/logs` — Job log content (GET)
- `/api/jobs/[jobId]/board-sync` — Manually sync a finished root job to the GitHub project board (POST); rejects running jobs, requires board sync configured, surfaces GitHub failures instead of swallowing them
- `/api/jobs/[jobId]/rerun` — Re-run a job (POST). Returns `409 { detail, blocking_job_id }` when another job is already running for the project
- `/api/jobs/[jobId]/fix` — Start AI fix run for a failed job (POST)
- `/api/jobs/[jobId]/seen` — Mark job as seen (POST)
- `/api/jobs/notifications` — Unseen job notifications (GET)
- `/api/jobs/notifications/mark-seen` — Mark all notifications seen (POST)
- `/api/streaming/[jobId]` — SSE stream of parsed text deltas from NDJSON log (`?raw=1` for raw lines)

## Cross-project recommendations

- `/api/recommendations` — Read-only list of every `open` recommendation across all projects, newest first (GET)
- `/api/recommendations/summary` — Read-only summary of all `open` recommendations (`{ openCount, byProject }`) for header/global UI polling (GET)

## Settings

- `/api/settings` — Settings CRUD (GET, PATCH) — includes GitHub board sync, CLI routing/binary/model, `base_prompt`, permission mode, the dedicated global trusted-GitHub-users allowlist (`trusted_github_users`), pipeline model overrides, budget gates, retention, and all `notification_*` keys. `trusted_github_users` is stored as JSON in the DB but exposed by this route as a comma-separated string for the Settings UI.
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
