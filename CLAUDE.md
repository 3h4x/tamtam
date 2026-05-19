# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude-compatible CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Vision

A **quality-gated release pipeline** for each tracked repo: `test → review → (fix loop) → commit → push → dod → merge`. The **Release** button triggers it; with `auto_push_enabled`, the chain continues automatically. PR-vs-direct is decided at runtime from branch context (default branch → push direct; non-default → open or reuse a PR). Verdicts (`LGTM` / `NEEDS ATTENTION` / `DO NOT SHIP`) drive fix loops, capped at 3 verification iterations per release.

See `docs/PIPELINE.md` for the full state machine.

## Concepts

- **Skills** — reusable prompt blocks (DB-backed + file-based from `skills/docs/skills/` and `data/skills/`).
- **Agents** — skills + project docs + model + prompt + optional schedule + optional `prerequisiteCommand`. Intake runs through the `workflow` package's Postgres-backed world (`lib/agents/intake-workflow.ts`) and hands off to `lib/jobs/inline-agent.ts`; see `docs/AGENT.md`.
- **Runs** — individual executions; legacy `/jobs` redirects to `/runs`.
- **Custom Actions** — per-project bash commands with configurable button color.
- **Retrieval** — optional pgvector-backed context from committed docs, DB skills, and completed agent reports. Toggled via `retrieval_enabled`.

## Tech Stack

Next.js 16 (App Router), React 19, TypeScript 6 strict, Tailwind v4, Drizzle + node-postgres (Postgres 16 with `vector` extension; `DATABASE_URL` required), vitest + Playwright, pnpm 11.1.2. Providers: Claude / Gemini / LM Studio / Codex / custom via CLI shims.

## Commands

Canonical post-edit command: **`pnpm run rebuild`** (build + idempotent PM2 restart). `pnpm dev` is foreground-only and never the long-lived server. Full reference: `docs/COMMANDS.md`.

**`pnpm rebuild` is now graceful by default** (`scripts/rebuild-safe.sh`): it pauses jobs via `PATCH /api/settings {jobs_paused:true}`, polls `/api/jobs?running=1` until pipeline-step/agent/run jobs drain (default 10 min, override via `TAMTAM_REBUILD_DRAIN_TIMEOUT`), then builds + restarts via `pm2-start.sh` and unpauses. `pr-wait` is excluded from the drain set because its on-boot resume handles mid-poll interruption. If the build fails the pause is reverted; if the restart fails the pause is *kept* on so the half-restarted server doesn't pick up new work — clear it manually via `/settings`. For the legacy "kill everything immediately" behavior, use `pnpm rebuild:force` (equivalent to the old `pnpm build && pnpm start`).

**Codex sandbox exception**: do not run `pnpm build`, `pnpm restart`, or `pnpm run rebuild` from Codex sandboxed sessions. The `prebuild` workflow graph render uses Mermaid CLI → Puppeteer/Chrome, and browser process launch is unavailable in the sandbox. Use `pnpm type-check`, `pnpm lint`, and targeted tests for verification, and clearly state that production build was not run.

## Architecture

- `app/` — pages and API route handlers.
- `components/` — React client components; large pages have a co-located subfolder (`components/monitoring/`, `components/settings/`, …).
- `hooks/` — custom React hooks.
- `lib/` — business logic in domain folders: `workflows/`, `pipeline/`, `scheduling/`, `git/`, `jobs/`, `terminal/`, `agents/`, `skills/`, `recommendations/`, `shared/`, `usage/`, `db/`, `github/`, `client/`. `lib/client-api.ts` is the only top-level barrel.
- `scripts/` — server startup + CLI shims.
- `skills/` — vendored file-based skill library (curated, not a submodule).
- `data/` — runtime artifacts (logs, `pg_dump` backups; gitignored). Live DB is Postgres via `DATABASE_URL`.
- `__tests__/` — vitest. `e2e/` — Playwright. `docs/` — architecture docs (see table below).

**File size caps** (convention, not tooling):
- No new top-level files in `lib/` — every new module goes in a domain subfolder.
- `lib/`: target < 300 lines, hard cap 500.
- `components/`: target < 400, hard cap 600. Past 600, extract into `components/<page-name>/`.

**Server vs Client Components:**
- Files in `components/` that render React must start with `'use client'` (single quotes, first line). Co-located type/constant/utility/hook modules may omit it.
- Pages in `app/` are Server Components by default; don't add `'use client'` unless the page needs hooks directly.
- Never use browser-only APIs (`window`, `document`, `localStorage`) in `app/` page/layout files.

**Adding an API route:**
1. Create `app/api/<path>/route.ts`.
2. Add `__tests__/api/<route-name>.test.ts`.
3. Document in `docs/API.md`.
4. New DB tables: edit `lib/db/schema.ts`, then `pnpm db:generate && pnpm db:migrate`. Never edit migration files by hand.

## Pages

`/` projects, `/runs` (legacy `/jobs` redirects), `/agents`, `/monitoring`, `/pipeline`, `/recommendations`, `/stats`, `/workflow-runs`, `/workflow-runs/[runId]`, `/logs`, `/skills`, `/settings` → `/settings/general`, `/settings/[tab]`. Per-project: `/project/[name]`, `/project/[name]/[tab]` where tab ∈ `{overview, config, history, terminal, changes, issues, docs, agents}`, plus `/project/[name]/terminal/[sessionId]`, `/project/[name]/release/[releaseId]`, `/project/[name]/task/[task]`.

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

- Server running (`pnpm run rebuild` if a build is needed) before testing. In Codex sandboxed sessions, do not rebuild; use the existing reachable app if available, otherwise do static verification plus `pnpm type-check`.
- Use Playwright only via MCP (`mcp__playwright__*` / Playwright MCP tools) to navigate and screenshot. Do not launch Playwright, Puppeteer, Chrome, or Chromium from shell in Codex sandboxed sessions; browser process launch is blocked there. Chrome DevTools MCP is unreliable — prefer Playwright MCP.
- Test golden path + key edge cases visually; check adjacent features for regressions.
- Do **NOT** claim frontend work complete without the Playwright screenshot step.

## Key Patterns

- **Runtime state lives in DB.** Shared per-project config and file-agent prompts also live in committed `.tamtam/` files (see `docs/TAMTAM-DIR.md`).
- **DB access** imports `db` / `schema` from `@/lib/db`. Don't open ad-hoc `pg.Pool`/`pg.Client` in `app/`, `components/`, or `lib/`; reserve direct pg for explicit maintenance scripts.
- **CLI calls go through `lib/shared/shell.ts`.** Direct `child_process` is the exception, allowed only in runner/shim/streaming paths that already need it.
- **Client-side fetches** live under `lib/client/` and are surfaced through `lib/client-api.ts`. Extend existing helpers instead of duplicating request/response handling in components.
- **Terminal streaming** uses the provider's `stream-json` output piped to a log file + fs.watch + NDJSON parser, then SSE at `/api/streaming/[jobId]`. See `docs/STREAMING.md`.
- **One-shot job processes** are spawned **in-process** from Next.js (no PM2 per-job entries). Agent intake uses `lib/agents/intake-workflow.ts` → `lib/jobs/inline-agent.ts`. Pipeline + terminal jobs use `lib/jobs/spawn-claude-detached.ts startJobInProcess` (detached + unref'd, stdio to log fd) so they survive a PM2 restart of TamTam. `probeJobStatus` recovers state on next boot. PM2 only supervises the TamTam server itself.
- **Pipeline orchestrator** in `lib/workflows/release-orchestrator.ts` drives every release via 7 phase workflows. Each phase wraps `startProject*` in `runWithParent(releaseJobId, ...)` so spawned children inherit `release_id`. Legacy completion-hook chain short-circuits on `releaseId`. Full reference: `docs/PIPELINE.md`.
- **Pipeline guardrails** (`lib/workflows/guards/`): `reviewIsStuck`, `fixContradictsReview`, `checkIterationCap`. Abort decisions persist `stopReason` on the release meta-job's `contextMeta` for trace visibility.
- **Scheduled agent intervals** are handled by graphile-worker (`lib/workflows/cron/seed-agent-crons.ts`, `lib/workflows/cron/agent-cron-task.ts`, and `lib/workflows/cron/start-cron-worker.ts`), **not PM2 cron** (PM2 `cron_restart` + `--no-autostart` silently no-ops). The worker pool is pinned on `globalThis.__tamtamCronWorker` so Next.js's separate module realms share the same runner.
- **Per-project agent serialization** (`lib/agents/pending-agent-run.ts`): only one agent runs at a time per project; concurrent calls return HTTP 202 `queued`. Same-agent duplicates return 409.
- **Background probe sweep** runs every 30s in `instrumentation-node.ts`, resolving hung Claude-CLI jobs and aborting releases past their deadline. `drainBootRecoveryWork` fires once at boot for cross-restart cleanup.
- **Global pause + budget gates** (`lib/shared/job-control.ts`): when `jobs_paused`, pipeline routes return 409 and the scheduler pauses. When `budget_block_runs_enabled` and active quota > `budget_block_at_pct`, job starts return 429.
- **Auto-attach docs** (`lib/skills/auto-attach-docs.ts`): keyword → project doc, injected on first invocation per session. Wired into terminal run, pipeline review, and agent intake — see `docs/TAMTAM-DIR.md`.
- **Permission mode** for headless jobs defaults to `auto` — the bundled Claude, Gemini, and Codex shims translate `auto` to provider-native non-interactive flags so writes don't hang. `acceptEdits` and `bypassPermissions` remain available; `plan` is read-only.
- **QA targets** are DB-backed: `website` is production; `qa_url` is the explicit QA override. Always prefer `qa_url` when both exist. If neither exists, QA flows should stop, not invent a target.
- **Outbound webhooks** (`lib/shared/notifications.ts`): Slack / Discord / ntfy / generic JSON POST; HMAC-SHA256 signed when `notification_webhook_secret` is set. Events: `release_success`, `release_fail`, `release_aborted`, `fix_loop_exhausted`, `review_do_not_ship`, `agent_run_fail`, `budget_blocked`.
- **Retention** (`lib/jobs/retention.ts`): per-run log prune (`log_retention_count` / `log_retention_days`, defaults 200/30); nightly cleanup deletes finished `jobs` rows older than `job_row_retention_days` (default 180).
- **Singletons on `globalThis`** are intentional in a few places (`__tamtamCronWorker`, `__tamtamJobCancellation`, `__tamtamStartingAgents`, `__tamtamSpawnedClosePending`). Only add another when cross-route coordination truly requires it; pin to `globalThis` because Next.js duplicates modules; document in the relevant `docs/*.md`.

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
| `docs/CACHING.md` | In-memory and DB-backed cache strategy | Adding polling endpoints, debugging stale reads, or changing cache invalidation/TTL behavior |
| `docs/COMMANDS.md` | Server lifecycle, tests, DB, and profiling commands | Running TamTam, choosing the right rebuild/dev/test command, or updating command guidance |
| `docs/DATABASE.md` | Drizzle/Postgres schema reference | Editing schema, writing queries, or reasoning about persisted runtime state |
| `docs/E2E.md` | Playwright pipeline e2e harness | Deciding between unit vs pipeline e2e coverage or extending `e2e/pipeline/` |
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
| `docs/superpowers/specs/2026-04-16-docs-picker-design.md` | Approved design for docs picker | Changing docs picker API/UI behavior and needing the approved contract |
| `docs/superpowers/specs/2026-05-13-agent-retrieval-design.md` | Approved semantic retrieval design | Changing retrieval architecture, ranking, or storage assumptions |
| `docs/superpowers/specs/2026-05-14-postgres-workflow-cutover-design.md` | Approved Postgres/workflow cutover design | Touching Postgres-only assumptions, workflow-always-on intake, or cleanup of older SQLite-era patterns |
| `docs/TAMTAM-DIR.md` | `.tamtam/config.yml` and file-agent contract | Changing committed per-project config, agent files, or auto-attached docs behavior |
| `docs/TESTING.md` | Vitest/PGlite patterns and mock rules | Adding tests, especially API tests, or debugging test harness setup |
| `docs/UI.md` | Design tokens, component patterns, and visual rules | Changing UI styling, layout patterns, or deciding whether a visual choice fits TamTam |
