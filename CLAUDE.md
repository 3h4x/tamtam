# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude-compatible CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Vision

A **quality-gated release pipeline** for each tracked repo: `test → review → (fix loop) → commit → push → DoD (mark-dod) → pr-wait/merge → soak`. The **Release** button triggers it; with `auto_push_enabled`, the chain continues automatically. PR-vs-direct is decided at runtime from branch context (default branch → push direct; non-default → open or reuse a PR). Verdicts (`LGTM` / `NEEDS ATTENTION` / `DO NOT SHIP`) drive fix loops. The single global setting `fix_max_iterations` (default `0` = unlimited; run until success or the release wall-clock timeout) caps the review-driven loops: review→fix→review, test→fix→test, commit→fix→commit, and the review-driven push→fix→push leg. The optional `release_min_lines` gate can re-dispatch the same agent before release, and `release_reinforce_max_iterations` (default `3`) bounds those reinforce reruns; a no-progress rerun still releases whatever exists. Two failure-recovery loops keep finite hardcoded caps (2 attempts each) so a permanently broken environment can't loop forever even when the setting is 0 — the pre-push-hook rejection retry (`getPushFixAttemptCap()`) and the fix-CI fast-crash recovery (`FIX_CI_MAX_RETRIES`).

### ULTIMATE requirement — merge or HITL, never a silent stop

**Every release MUST terminate in exactly one of two states: (1) the work is _merged/shipped_, or (2) a _HITL signal_ is raised in the inbox (`/inbox`) telling the operator precisely what to decide and do.** A release must **never** end in a third state — stopped without merging **and** without surfacing anything. A silent stop (an issue that is "not merged and not in the inbox") is a **bug**, not an acceptable outcome.

Enforcement lives in `lib/workflows/inbox.ts`: every non-merge `pr-wait` terminal — `conflict`, `risky_diff`, `merge_permanent`, `switch_failed`, `timeout`, or an unrecorded/blank failure — raises a `pr_needs_manual_merge` inbox signal. Only self-healing terminals (`checks_failed` → re-dispatched fix-ci) and benign terminals (`merged`, `pr_closed`) are exempt (the `NO_HITL_REASONS` denylist — anything not on it that finishes a pr-wait non-zero surfaces). When adding any new code path that can end a release without a merge, it MUST either self-heal (and be provably bounded) or emit an inbox HITL. Do not add a terminal that leaves an operator with no merge and no signal.

See `docs/PIPELINE.md` for the full state machine.

## Concepts

- **Skills** — reusable prompt blocks (DB-backed + file-based personas from `skills/docs/skills/`, plus optional runtime personas from `data/skills/` when that directory exists).
- **Agents** — skills + project docs + model + prompt + optional schedule + optional `prerequisiteCommand`. Built-in catalog entries live in `lib/agents/catalog.ts` and cover both auto-seeded internal handlers and CLI templates. Intake runs through `runAgentIntakeWorkflow()` in `lib/agents/intake-workflow.ts` and hands off to `startInProcessAgentJob` in `lib/jobs/inline-agent.ts`; this repo pins the local workflow world by default (`WORKFLOW_TARGET_WORLD=local`, `WORKFLOW_LOCAL_DATA_DIR=data/workflow-data`). See `docs/AGENT.md`.
- **Per-project dev servers** — optional `dev_server_start_command`, `dev_server_stop_command`, and `dev_server_ready_url` fields let TamTam start and stop a project's local app around agent runs. See `lib/dev-server/lifecycle.ts`.
- **Runs** — individual executions, surfaced per project under the history tab (`/project/[name]/history`).
- **Custom Actions** — per-project bash commands with configurable button color.
- **Retrieval** — optional pgvector-backed context from committed project docs, DB skills, synthesized project config guidance, and completed agent reports. Toggled via `retrieval_enabled`.

## Tech Stack

Next.js 16 (App Router), React 19, TypeScript 6 strict, Tailwind v4, Drizzle ORM + `pg` (Postgres 18 with `vector` extension; `DATABASE_URL` required), vitest + Playwright, pnpm 11.1.2. Providers: Claude / Gemini / LM Studio / Codex / Deep Agents via bundled CLI shims, plus custom Claude-compatible wrappers.

## Commands

Canonical post-edit command: **`pnpm run rebuild`** (build + idempotent PM2 restart). `pnpm dev` is foreground-only and never the long-lived server. Full reference: `docs/COMMANDS.md`.

The build now defaults to the **webpack** bundler (`scripts/build-with-metrics.mjs`), which is ~4–5× faster here than Turbopack and no longer hangs the rebuild — `pnpm run rebuild` completes reliably end-to-end. Set `TAMTAM_BUILD_BUNDLER=turbopack` to revert; the Turbopack NFT-comment rules below still apply because Turbopack remains the dev bundler and an opt-in build path.

The `rebuild` script is now graceful by default (`scripts/rebuild-safe.sh`): it acquires a repo-scoped TMPDIR mutex first (default wait 15 min, override via `TAMTAM_REBUILD_LOCK_WAIT`) so two rebuilds cannot race `.next/`, then pauses jobs via `PATCH /api/settings {jobs_paused:true,rebuild_in_progress:true}`, polls `/api/jobs?status=running&limit=200&offset=...` until blocking pipeline-step/fix-ci/agent/run jobs drain (default 10 min, override via `TAMTAM_REBUILD_DRAIN_TIMEOUT`), stops the PM2 `tamtam` server before building so the live server cannot race `.next/` writes, serves a temporary rebuild placeholder page on the TamTam port while the server is stopped, then builds, runs `pnpm db:migrate` so a renamed/added settings key lands before the new code reads it (a failed migrate aborts before restart), restarts via `pm2-start.sh`, smoke-probes `/`, `/workflow-runs`, `/agents`, and `/settings/general`, and unpauses. A wall-clock watchdog aborts hung rebuilds after 30 min by default (`TAMTAM_REBUILD_WALL_CLOCK_TIMEOUT`). If the smoke probe fails after restart, it does a clean `.next/` rebuild/restart before unpausing. `pr-wait` is excluded from the drain set because its on-boot resume handles mid-poll interruption. If build, migrate, restart, or smoke recovery fails after jobs were paused, the pause is *kept* on so work does not resume into a stopped, unmigrated, or half-restarted server — clear it manually via `/settings` after recovery. Bare `pnpm rebuild` still runs pnpm's built-in native-deps rebuild; for the legacy no-drain behavior, use `pnpm run rebuild:force`.

**Never pipe `build`/`rebuild` through `tail`/`head`/`grep`.** `pnpm run build` (`scripts/build-with-metrics.mjs`) and `pnpm run rebuild` already stream live phase/progress output. Piping into `tail -N` buffers stdout until the process exits, so a slow-but-healthy build looks hung with zero output for minutes. Run them bare and let output stream; if you must capture, use `… 2>&1 | tee /tmp/rebuild.log` (which still streams) or run with `run_in_background: true` and watch the live output file — never `| tail`.

**Codex sandbox exception**: do not run `pnpm build`, `pnpm restart`, or `pnpm run rebuild` from Codex sandboxed sessions. The `prebuild` workflow graph render uses Mermaid CLI → Puppeteer/Chrome, and browser process launch is unavailable in the sandbox. Use `pnpm type-check`, `pnpm lint`, and targeted tests for verification, and clearly state that production build was not run.

## Architecture

- `app/` — pages and API route handlers.
- `components/` — React client components; large pages have a co-located subfolder (`components/monitoring/`, `components/settings/`, …).
- `hooks/` — custom React hooks.
- `lib/` — business logic in domain folders: `workflows/`, `pipeline/`, `scheduling/`, `git/`, `jobs/`, `terminal/`, `agents/`, `skills/`, `recommendations/`, `shared/`, `usage/`, `db/`, `github/`, `client/`, `dev-server/`, `orchestrator/`, `browser-broker/`, `auth/`, `security/`. `lib/client-api.ts` is the only top-level barrel.
- `scripts/` — server startup + CLI shims.
- `skills/` — vendored file-based skill library (curated, not a submodule).
- `data/` — runtime artifacts (logs, `pg_dump` backups; gitignored). Live DB is Postgres via `DATABASE_URL`.
- `__tests__/` — vitest. `e2e/` — Playwright. `docs/` — architecture docs (see table below).

**File size caps** (convention, not tooling):
- No new top-level files in `lib/` — every new module goes in a domain subfolder.
- `lib/`: target < 300 lines, hard cap 500.
- `components/`: target < 400, hard cap 600. Past 600, extract into `components/<page-name>/`.

**Server vs Client Components:**
- Files in `components/` that use hooks, event handlers, or browser-only APIs must start with `'use client'` (single quotes, first line). Pure presentational, Server-compatible components and co-located type/constant/utility modules may omit it.
- Pages in `app/` are Server Components by default; don't add `'use client'` unless the page needs hooks directly.
- Never use browser-only APIs (`window`, `document`, `localStorage`) in `app/` page/layout files.

**Adding an API route:**
1. Create `app/api/<path>/route.ts`.
2. Add `__tests__/api/<route-name>.test.ts`.
3. Document in `docs/API.md`.
4. New DB tables: edit `lib/db/schema.ts`, then `pnpm db:generate && pnpm db:migrate`. Never edit migration files by hand.

## Pages

`/` projects, `/agents`, `/agent`, `/inbox` (aggregated signals feed), `/runs`, `/library`, `/monitoring`, `/recommendations` (with `Unresolved`, `Initiatives`, and `History` tabs; `?tab=initiatives` deep-links the backlog), `/stats` (with `Usage` + `Pipeline` tabs; `?tab=pipeline` deep-links the latter), `/workflow-runs`, `/workflow-runs/[runId]`, `/logs`, `/login` (token-auth gate; see the auth pattern below), `/pipeline` (legacy redirect to `/stats?tab=pipeline`), `/initiatives` (legacy redirect to `/recommendations?tab=initiatives`), `/skills` (legacy redirect to `/library?tab=skills`), `/settings` → `/settings/general`, `/settings/[tab]`. Per-project: `/project/[name]`, `/project/[name]/[tab]` where tab ∈ `{overview, config, history, terminal, changes, issues, docs, agents}`, plus `/project/[name]/setup` (setup wizard), `/project/[name]/terminal/[sessionId]`, `/project/[name]/release/[releaseId]`, `/project/[name]/task/[task]`.

## Testing

- **All new API routes need vitest tests.** See `docs/TESTING.md` for the PGlite test-db pattern and mock rules.
- **Do not mock the database** — use `createTestPgDbEmpty()` or `createTestPgDb()` from `__tests__/helpers/test-db.ts`.
- Run `pnpm test` after every non-trivial change.

## Dependency Security

- Prefer existing dependencies and platform APIs over adding new packages.
- Before adding or upgrading a package, read `docs/SECURITY.md` and verify the dependency is necessary for TamTam's self-hosted threat model.
- Keep dependency changes minimal and documented in the relevant subsystem doc when they change runtime or trust boundaries.

## Scope and Safety

- Make the smallest change that fully solves the task; do not rewrite settled guidance or unrelated code paths.
- Preserve runtime safety rails: job pause gates, budget gates, release locks, and default-branch pinning stay intact unless the task explicitly requires changing them.
- Stop and surface conflicts when a requested change would weaken shared-infra safety assumptions or silently broaden trust.

## Definition of Done for UI/Frontend Changes

- Verify with `pnpm type-check`, `pnpm lint`, and targeted tests. After changes you may run `pnpm run rebuild` ad-hoc to make them live — the graceful rebuild script (`scripts/rebuild-safe.sh`) pauses jobs, drains running work, serves a placeholder on the TamTam port, builds, runs `pnpm db:migrate`, restarts, smoke-probes, and unpauses, so an ad-hoc rebuild from an interactive/dev session is safe and self-recovering. Then do visual checks against the freshly-rebuilt app. **Exception — never rebuild from inside a TamTam-spawned in-process agent job**: the drain step waits for that very job to finish (deadlock) and `pm2 stop tamtam` would kill the server the job runs under. In that context, leave the rebuild to an out-of-band session.
- Use Playwright only via MCP (`mcp__playwright__*` / Playwright MCP tools) to navigate and screenshot. Do not launch Playwright, Puppeteer, Chrome, or Chromium from shell in Codex sandboxed sessions; browser process launch is blocked there. Chrome DevTools MCP is unreliable — prefer Playwright MCP.
- Test golden path + key edge cases visually; check adjacent features for regressions.
- Do **NOT** claim frontend work complete without the Playwright screenshot step.

## Key Patterns

- **Runtime state lives in DB.** Agents are DB-only. Shared per-project config also lives in committed `.tamtam/config.yml` (see `docs/TAMTAM-DIR.md`).
- **DB access** imports `db` / `schema` from `@/lib/db` for TamTam-owned tables. Direct `pg.Pool`/`pg.Client` is reserved for explicit special cases such as workflow-world inspection or graphile-worker helpers; don't add ad-hoc pools for ordinary app data in `app/`, `components/`, or general `lib/` code.
- **CLI calls go through `lib/shared/shell.ts`.** Direct `child_process` is the exception, allowed only in runner/shim/streaming paths that already need it.
- **Client-side fetches** live under `lib/client/` and are surfaced through `lib/client-api.ts`. Extend existing helpers instead of duplicating request/response handling in components.
- **Terminal streaming** uses the provider's `stream-json` output piped to a log file + fs.watch + NDJSON parser, then SSE at `/api/streaming/[jobId]`. See `docs/STREAMING.md`.
- **One-shot job processes** are spawned **in-process** from Next.js (no PM2 per-job entries). Agent intake uses `runAgentIntakeWorkflow()` in `lib/agents/intake-workflow.ts` → `startInProcessAgentJob` in `lib/jobs/inline-agent.ts`. Pipeline + terminal jobs use `lib/jobs/spawn-claude-detached.ts startJobInProcess` (detached + unref'd, stdio to log fd) so they survive a PM2 restart of TamTam. `probeJobStatus` recovers state on next boot. PM2 only supervises the TamTam server itself.
- **Pipeline orchestrator** in `lib/workflows/release-orchestrator.ts` drives every release via the phase workflows (`test`, `review`, `fix`, `commit`, `push`, `mark-dod`, `pr-wait`, `soak`). Each phase wraps `startProject*` in `runWithParent(releaseJobId, ...)` so spawned children inherit `release_id`. Legacy completion-hook chain short-circuits on `releaseId`. Full reference: `docs/PIPELINE.md`.
- **Pipeline guardrails** (`lib/workflows/guards/`): `reviewIsStuck`, `fixContradictsReview`, `checkIterationCap`. Abort decisions persist `releaseStopReason` on the release meta-job's `contextMeta` for trace visibility.
- **Scheduled agent intervals** are handled by graphile-worker (`lib/workflows/cron/seed-agent-crons.ts`, `lib/workflows/cron/agent-cron-task.ts`, and `lib/workflows/cron/start-cron-worker.ts`), **not PM2 cron** (PM2 `cron_restart` + `--no-autostart` silently no-ops). The worker pool is pinned on `globalThis.__tamtamCronWorker` so Next.js's separate module realms share the same runner.
- **Per-project agent serialization** (`lib/agents/pending-agent-run.ts`): only one agent runs at a time per project; concurrent calls return HTTP 202 `queued`. Same-agent duplicates return 409.
- **Background probe sweep** runs every 30s in `instrumentation-node.ts`, resolving hung Claude-CLI jobs and aborting releases past their deadline. `drainBootRecoveryWork` fires once at boot for cross-restart cleanup. Wall-clock liveness for detached jobs is a single generalized reaper (`lib/jobs/test-timeout-reaper.ts`, `reapTimedOutClaudeJobs`) with a per-kind cap map (`test` → 10 min, `mark-dod-verify` → `mark_dod_verify_timeout_ms`); it reads job rows so it survives a restart. Pipeline Claude work (review/fix/mark-dod-verify/terminal) spawns through `startJobInProcess` and is supervised by this one path — no per-phase kill-switches (`runSubprocess` remains only for inline-agent intake).
- **Global pause + budget gates** (`lib/shared/job-control.ts`): when `jobs_paused`, pipeline routes return 409 and the scheduler pauses. When `budget_block_runs_enabled` is on, TamTam routes around enabled quota-backed providers at or above `budget_block_at_pct`; if every enabled provider is blocked, job starts return 429.
- **Token auth** (`middleware.ts`, `lib/auth/token.ts`, `app/api/auth/{check,login,logout}/route.ts`): `middleware.ts` gates every non-public path by calling `/api/auth/check`. The token is stored hashed in the `auth_token` setting; when it is unset, auth is disabled (`configured:false`). Unauthenticated API requests get 401; page requests redirect to `/login?next=…`. Public paths: `/login`, `/api/health`, `/api/auth/{check,login,logout}`, static assets.
- **Auto-attach docs** (`lib/skills/auto-attach-docs.ts`): keyword → project doc, injected on first invocation per session. Wired into terminal run, pipeline review, and agent intake — see `docs/TAMTAM-DIR.md`.
- **Permission mode** for headless jobs defaults to `auto` — the bundled Claude, Gemini, and Codex shims translate `auto` to provider-native non-interactive flags so writes don't hang. `acceptEdits` and `bypassPermissions` remain available; `plan` is read-only.
- **QA targets** are DB-backed: `website` is production; `qa_url` is the explicit QA override. Always prefer `qa_url` when both exist. If neither exists, QA flows should stop, not invent a target.
- **Outbound webhooks** (`lib/shared/notifications.ts`): Slack / Discord / ntfy / generic JSON POST; HMAC-SHA256 signed when `notification_webhook_secret` is set. Events: `release_success`, `release_fail`, `release_aborted`, `fix_loop_exhausted`, `review_do_not_ship`, `agent_run_fail`, `budget_blocked`, `budget_exceeded`, `flaky_test_detected`, `circuit_breaker_tripped`, `post_merge_revert`.
- **Retention** (`lib/jobs/retention.ts`): per-run log prune (`log_retention_count` / `log_retention_days`, defaults 200/30); nightly cleanup deletes finished `jobs` rows older than `job_row_retention_days` (default 180).
- **Initiative engine** (`lib/orchestrator/initiative-*`): grounded Miner + serialized dispatcher run as default-off orchestrator-tick phases that discover chores and drive them through the release pipeline. The operator backlog lives in `/recommendations?tab=initiatives`; legacy `/initiatives` redirects there. See `docs/ORCHESTRATOR.md`.
- **Singletons on `globalThis`** are intentional in a few places: `__tamtamCronWorker`, `__tamtamJobCancellation`, `__tamtamStartingAgents`, `__tamtamSpawnedClosePending`, `__tamtamAgentLastSkip`, `__tamtamProjectRecoveryDrains`, `__tamtamWorkflowRunsPool`, `__tamtamBrowserBroker`, `__tamtamBrowserBrokerStarting`, `__tamtamBrowserBrokerShutdownHookInstalled`, `__tamtamBrowserBrokerShutdownHooks`, `__tamtamAgentLastDispatch`, `__tamtamAgentHealthAnalyzed`, `__tamtamAgentHealthInFlight`, `__tamtamOrchestratorHistory`, `__tamtamQuotaPersistedAt`, `__tamtamQuota`, `__tamtamCodexQuota`, `__tamtamJobsCache`, `__tamtamJobsCacheLoaded`, the git-branch caches `__tamtamDefaultBranchCache`, `__tamtamCurrentBranchCache`, `__tamtamChangesBranchInfoCache`, `__tamtamBehindCache`, `__tamtamBehindInflight` (`lib/git/git-branch.ts`), `__tamtamScheduler`, `__tamtamTestScheduler`, `__tamtamStartingPipelineSteps` (atomic per-(release,phase) start claim — `lib/pipeline/pipeline-start-slot.ts`, prevents duplicate phase dispatch), `__tamtamSystemMetricsSampler`, `__tamtamSystemMetricsState`, `__tamtamReinforceState` (ephemeral per-project reinforce-loop counters for the release-after-run line-threshold gate — `lib/workflows/triggers/reinforce-state.ts`), `__tamtamInitiativeLastMine` (ephemeral per-project last-mine timestamps that throttle the initiative-engine miner — `lib/orchestrator/mining-throttle.ts`), and `__tamtamAutoFixCiState` (ephemeral per-project bound for the sweep's auto fix-ci-on-red-default-branch trigger — one attempt per failing-run URL, capped consecutive attempts — `lib/jobs/auto-fix-ci-state.ts`). Only add another when cross-route coordination truly requires it; pin to `globalThis` because Next.js duplicates modules; document in the relevant `docs/*.md`.

## Coding Conventions

- **Stay project-generic in source.** TamTam is shared infra. Don't reference specific project slugs, GitHub owner/repo, PR numbers, or issue numbers in code, comments, log strings, variable names, or commit messages within source. Describe the symptom, not the ticket. Discovery context belongs in chat / PR descriptions.
- **Path imports**: always `@/`, never relative `../../`.
- **File naming**: kebab-case (`start-fix.ts`); PascalCase only for React component files.
- **Symbols**: `camelCase` for functions/variables/hooks; `PascalCase` for components/types/interfaces; `snake_case` only when matching persisted settings keys, DB columns, or external API payloads.
- **No new barrel files.** Existing exceptions: `lib/client-api.ts`, `lib/jobs/job-storage.ts`, `lib/db/index.ts`. Import directly otherwise.
- **TypeScript strict.** Avoid `any`. Never `// @ts-ignore` — fix the type.
- **Error handling**: throw for unexpected; return `{ ok, error }` only where callers must branch without crashing. `console.error` before re-throw in API routes.
- **UI styling**: use tokens and patterns from `docs/UI.md`. No one-off color scales, spacing systems, or global CSS outside the existing Tailwind v4 token setup.
- **Turbopack NFT comments**: Next.js 16 Turbopack traces server-route deps at build time. When a route's dep tree calls `path.join(dynamicVar, …)` or any `fs` call (`existsSync`, `readFileSync`, `readFile`, `openSync`, `statSync`, `watch`, `readdirSync`) with a **runtime-dynamic** path (settings/project/log paths, `homedir()`, `process.cwd() + userVar`), the static analyzer can't bound it and traces the whole project, dragging `next.config.ts` into every route bundle (`Encountered unexpected file in NFT list`). Annotate the dynamic argument inline at each call site:
  ```ts
  existsSync(/*turbopackIgnore: true*/ p)
  readFile(/*turbopackIgnore: true*/ path, 'utf8')
  ```
  Statically-scoped joins like `join(process.cwd(), 'data', name)` are fine.
- **Lint coverage**: `pnpm lint` only checks `app`, `components`, `lib`, `hooks`. Edits to `scripts/`, `__tests__/`, `e2e/`, or repo config are not lint-covered — review manually.

## Docs Reference

Read the relevant file before touching the subsystem it covers.

| File | Topic | Load when |
|------|-------|-----------|
| `docs/AGENT.md` | Agents: composition, scheduling, intake workflow, concurrency rules | Creating, debugging, or changing agent behavior, attached docs, schedules, or intake orchestration |
| `docs/API.md` | HTTP API route reference | Adding, changing, or testing any `app/api/*` route or response contract |
| `docs/BACKUP.md` | Postgres backup and restore runbook | Touching backup/restore flows, DB maintenance scripts, or retention behavior for dumps |
| `docs/BROWSER-BROKER.md` | Sandboxed Playwright access for agent runs (broker container + seatbelt profile) | Changing browser-broker container lifecycle, MCP injection, or the macOS sandbox profile; debugging QA agent Playwright failures |
| `docs/CACHING.md` | In-memory and DB-backed cache strategy | Adding polling endpoints, debugging stale reads, or changing cache invalidation/TTL behavior |
| `docs/COMMANDS.md` | Server lifecycle, tests, DB, and profiling commands | Running TamTam, choosing the right rebuild/dev/test command, or updating command guidance |
| `docs/DATABASE.md` | Drizzle/Postgres schema reference | Editing schema, writing queries, or reasoning about persisted runtime state |
| `docs/E2E.md` | Playwright pipeline e2e harness | Deciding between unit vs pipeline e2e coverage or extending `e2e/pipeline/` |
| `docs/ORCHESTRATOR.md` | Boost/health tick loop, recommendation types, AUTO-vs-MANUAL meaning, resolved/History lifecycle | Changing the orchestrator tick, fruitfulness/health signals, recommendation creation/auto-resolution, or the recommendations UI |
| `docs/PIPELINE.md` | Release pipeline state machine and fix-loop rules | Changing release orchestration, phase transitions, retry caps, or guard behavior |
| `docs/PROFILING.md` | Server, client, and Turbopack profiling workflow | Investigating CPU, HMR, or browser performance problems before making perf changes |
| `docs/PROMPT-SIZE.md` | Prompt composition and cache-read cost analysis | Changing prompt assembly, retrieval/context injection, or diagnosing token/cost growth |
| `docs/SECURITY.md` | File-agent trust model and untrusted input handling | Changing `.tamtam/` reads, trust boundaries, safe-user logic, or dependency-sensitive behavior |
| `docs/SETTINGS.md` | Settings keys, defaults, and effects | Adding/changing config keys or wiring UI/API behavior to settings |
| `docs/SHIM.md` | Claude-compatible CLI shim behavior | Updating provider shims, argument mapping, or stream-json compatibility |
| `docs/STREAMING.md` | Job lifecycle, logs, and SSE streaming | Debugging blank/stalled streams or implementing real-time output for a job kind |
| `docs/superpowers/plans/2026-04-16-docs-picker.md` | Historical implementation plan for docs picker | Tracing why the docs picker exists or comparing current behavior to the original plan |
| `docs/superpowers/plans/2026-05-13-agent-retrieval.md` | Historical agent retrieval implementation plan | Reviewing the original retrieval rollout plan before changing retrieval ingestion or prompt-time lookup |
| `docs/superpowers/plans/2026-05-13-durable-agent-orchestration.md` | Historical evaluation of durable agent orchestration | Understanding the earlier workflow adoption tradeoff analysis and why it was superseded |
| `docs/superpowers/plans/2026-05-15-cron-migration-graphile.md` | Historical implementation plan for graphile-worker cron migration | Tracing why graphile-worker powers scheduled agents or comparing current scheduling behavior to the original plan |
| `docs/superpowers/plans/2026-05-31-agent-run-scoring-health-analysis.md` | Historical implementation plan for agent run scoring and orchestrator health analysis | Reviewing the intended rollout before changing run scoring or agent-health recommendation logic |
| `docs/superpowers/plans/2026-06-03-reinforce-to-threshold.md` | Historical implementation plan for reinforce-to-threshold before release | Tracing the rollout of the auto-release minimum-lines gate and reinforce re-dispatch loop |
| `docs/superpowers/plans/2026-06-20-initiative-engine-phase1.md` | Historical implementation plan for the initiative engine | Tracing the rollout of mined initiatives, queueing, and release dispatch |
| `docs/superpowers/plans/2026-06-21-initiative-operator-steering.md` | Historical implementation plan for initiative steering | Tracing promote/reject controls, pinned ordering, and backlog operator workflow |
| `docs/superpowers/specs/2026-04-16-docs-picker-design.md` | Approved design for docs picker | Changing docs picker API/UI behavior and needing the approved contract |
| `docs/superpowers/specs/2026-05-13-agent-retrieval-design.md` | Approved semantic retrieval design | Changing retrieval architecture, ranking, or storage assumptions |
| `docs/superpowers/specs/2026-05-14-postgres-workflow-cutover-design.md` | Approved Postgres/workflow cutover design | Touching Postgres-only assumptions, workflow-always-on intake, or cleanup of older SQLite-era patterns |
| `docs/superpowers/specs/2026-05-21-sandboxed-playwright-broker-design.md` | Approved design for sandboxed Playwright broker | Changing browser-broker container lifecycle, Playwright sandbox configuration, or QA agent MCP tool access under auto/acceptEdits permission modes |
| `docs/superpowers/specs/2026-05-31-agent-run-scoring-health-analysis-design.md` | Approved design for agent run scoring and orchestrator health analysis | Changing run-score persistence, orchestrator health analysis, or recommendation semantics for agent health findings |
| `docs/superpowers/specs/2026-06-03-reinforce-to-threshold-design.md` | Approved design for reinforce-to-threshold before release | Planning or implementing the auto-release minimum-lines gate, reinforce re-dispatch loop, or related settings |
| `docs/superpowers/specs/2026-06-12-queued-terminal-runs-design.md` | Approved design for queued terminal run durability and priority ordering | Changing blocked terminal-run behavior, queued terminal-run persistence/drain order, or user-run-vs-agent queue priority |
| `docs/superpowers/specs/2026-06-20-initiative-engine-design.md` | Approved design for the initiative engine | Changing initiative mining, scoring, dispatch, or release linkage |
| `docs/superpowers/specs/2026-06-21-initiative-operator-steering-design.md` | Approved design for initiative operator steering | Changing initiative promote/reject semantics, pinned ordering, or the initiatives tab UI/API |
| `docs/TAMTAM-DIR.md` | `.tamtam/config.yml` contract (agents are DB-only) | Changing committed per-project config or auto-attached docs behavior |
| `docs/TESTING.md` | Vitest/PGlite patterns and mock rules | Adding tests, especially API tests, or debugging test harness setup |
| `docs/UI.md` | Design tokens, component patterns, and visual rules | Changing UI styling, layout patterns, or deciding whether a visual choice fits TamTam |
