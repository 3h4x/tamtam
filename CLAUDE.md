# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Vision: CI/CD for code, driven by Claude

TamTam's north star is a **quality-gated release pipeline** for each tracked repo. Each project has two workflow modes (set in the project Config tab):

**Direct Branch**: `test → review → (fix loop) → commit → push`
**PR Workflow**: `test → review → (fix loop) → commit → push → dod → merge`

Steps are pluggable per project and coordinated by completion hooks in `lib/jobs/job-storage.ts`:

- **test** — runs the project's test command (auto-detected from `package.json`/`pyproject.toml`/`Package.swift`/`Cargo.toml`/`go.mod`/`Makefile:test` or user-configured). Skipped if none. If tests pass and there are no uncommitted changes, the pipeline short-circuits directly to push (skipping review).
- **review** — Claude reads the uncommitted diff and emits a verdict: `LGTM` / `NEEDS ATTENTION` / `DO NOT SHIP` (verdict rules are configurable in Settings).
- **fix** — on `NEEDS ATTENTION` / `DO NOT SHIP`, Claude resumes the review session and applies fixes. Capped at 3 iterations per 30-minute window to prevent loops. On success it chains back to review.
- **commit + push** — on `LGTM`, staged changes are committed with a Claude-generated message (respecting the `commit_style` setting) and pushed. All changes (including untracked files) are staged via `git add -A`; `.gitignore` is trusted to exclude secrets.
- **mark-dod** *(PR Workflow only)* — after push, Claude inspects the codebase with tool access (Read/Grep/Glob) to verify which acceptance-criteria checkboxes in the linked GitHub issue are actually implemented, then ticks only the verified ones. Best-effort and non-fatal.
- **merge** *(PR Workflow + auto-merge enabled)* — polls CI checks on the PR and merges once they pass. After merge, the working copy is returned to the default branch.

The **🚀 Release** button triggers the pipeline at the right starting step. When `auto_push_enabled` is on (per-project config, off by default), the chain continues automatically from one step to the next. The pipeline strip in the Terminal tab shows the live state of each step (`○` pending, spinner running, `✓` done, `!` needs attention, `✗` failed); clicking a step opens its log. The strip is **only visible while the pipeline is actively running** — it disappears when all steps finish. Each release starts with a clean strip: only jobs from the current run are shown. Steps that come after the currently-running step always render as `○` (they haven't executed yet in this run), and prior steps are only shown as `✓` if they started within 30 minutes of the running step (older jobs are from a previous release and are ignored).

**Helpers** (composable building blocks used by both the API routes and the auto-chain):
- `lib/pipeline/start-test.ts` → `startProjectTest`
- `lib/pipeline/start-review.ts` → `startProjectReview`
- `lib/pipeline/start-fix.ts` → `startFixFromJob`
- `lib/pipeline/start-fix-push.ts` → `startFixPush` (pre-commit/pre-push hook failure recovery)
- `lib/pipeline/start-commit.ts` → `startProjectCommit` (stage all changes + generate commit message via Claude; also exports `generateCommitMessage`, `issueBranchName`, `findIssueContext`, `detectMainBranch`)
- `lib/pipeline/start-push.ts` → `startProjectPush`
- `lib/pipeline/start-release.ts` → `startRelease` (pipeline entry point)
- `lib/pipeline/start-pr-review.ts` → `startPrReview` (AI review of a GitHub PR)
- `lib/pipeline/start-mark-dod.ts` → `startMarkDod` (DoD verification + GitHub issue checkbox update)
- `lib/pipeline/start-pr-wait.ts` → `launchPrWait` (background PR poller: polls CI checks, auto-merges once they pass, switches working copy back to default branch, then runs mark-dod)
- `lib/shared/notifications.ts` → `notify` / `sendTestNotification` (outbound webhook delivery)

Verdict detection (`getVerdict` in `lib/jobs/job-storage.ts`) reads the **last 2000 chars** of the parsed Claude log and looks for an explicit "Verdict: X" marker or a bare token on the final line — deliberately lenient across markdown formatting (`## Verdict\n**NEEDS ATTENTION**`) but robust against false positives from code snippets higher up in the log.

## Concepts
- **Skills** — reusable prompt/instruction blocks (DB-backed + file-based from `skills/docs/skills/`)
- **Agents** — composed from skills + model + prompt (optional when skills are set) + schedule + runner. Only `pm2` runner is supported; `launchctl` is **deprecated** (legacy DB rows still load with a `[agent-scheduler] launchctl runner is deprecated` warning, but new agents should always use `pm2`).
- **Runs** — individual executions of an agent (what was previously called "jobs")
- **Custom Actions** — per-project bash commands (e.g. deploy) with configurable button color
- **Release Pipeline** — two modes: *Direct Branch* (`test → review → fix → commit → push`) or *PR Workflow* (adds `dod → merge`), driven by Claude and configurable per project

## Tech Stack
- **Framework**: Next.js 16 (App Router) — both frontend and backend
- **Database**: Drizzle ORM + better-sqlite3, WAL mode, DB at `data/db/tamtam.db` (gitignored)
- **Streaming**: SSE via route handlers for real-time run output
- **Styling**: Tailwind CSS v4
- **Skills**: `skills/` submodule (claude-skills) — engineering skills scanned from `skills/docs/skills/`; user-defined skills in `data/skills/`
- **Testing**: vitest + Playwright (e2e)
- **Package Manager**: pnpm
- **Release**: semantic-release on push to master (GitHub releases only, no npm)

## Commands
- `pnpm dev` — run `next dev` directly in the foreground on port 1337 (HMR enabled, no PM2). Use only for active local development; never for the long-lived TamTam server.
- `pnpm start` — start (or idempotently restart) the production server via PM2 on port 1337. Delegates to `scripts/pm2-start.sh`, which spawns `next` directly under PM2 (`--interpreter node`, no shell wrapper) so PM2 tracks the actual server PID — no orphans on stop/restart. Self-heals if a previous orphan is still squatting on port 1337. This is the canonical way to run TamTam.
- `pnpm rebuild` — `pnpm build && pnpm start` — production mode has no HMR, so rebuild always rebuilds first to pick up code changes. This is the canonical post-edit command.
- `pnpm restart` — equivalent to `pnpm rebuild` (alias). Note: bare `pnpm rebuild` (without `run`) invokes pnpm's built-in native-deps rebuild instead — use `pnpm run rebuild` or `pnpm restart`.
- `pnpm stop` — stop the PM2 server.
- `pnpm logs` — view PM2 logs.
- `pnpm build` — production build.
- `pnpm test` — run unit tests
- `pnpm test:watch` — run vitest in watch mode
- `pnpm test:e2e` — run Playwright e2e tests (requires dev server running on port 1337)
- `pnpm test:e2e:pipeline` — run pipeline e2e tests (`e2e/pipeline/`); spins up an isolated Next.js dev server on port 1338 with a temp DB at `/tmp/tamtam-e2e-pipeline/` — does NOT require the production server to be running
- `pnpm lint` — ESLint on app, components, lib, hooks
- `pnpm type-check` — TypeScript check
- `pnpm check` — lint + type-check + test (all in one)
- `pnpm db:generate` — generate Drizzle migration files from schema changes
- `pnpm db:migrate` — apply pending Drizzle migrations
- `pnpm dev:profile` — start dev server with Turbopack tracing enabled; stop server to flush trace to `.next/dev/trace-turbopack`, then open via `npx next internal trace` or https://trace.nextjs.org/
- `pnpm dev:flamegraph` — start dev server with V8 CPU profiling; stop server to flush `.profiles/CPU.*.cpuprofile`, then open in Chrome DevTools or https://www.speedscope.app/

**Always run TamTam under PM2 via `pnpm start` / `pnpm rebuild`.** `pnpm dev` is foreground-only and intended for ad-hoc local debugging — it does not register with PM2, so the rest of the harness (logs, restart, stop scripts) won't see it.

### Applying code changes

TamTam runs in **production mode** (`next start`) under PM2 — no HMR, no auto-reload. After any code change:

1. `pnpm rebuild` — builds and restarts the PM2 server in one step (preferred)
2. Or: `pnpm build` then `pnpm start`

`pnpm start` is idempotent: if a `tamtam` PM2 entry already exists it is restarted in place (no port kill, no dropped in-flight requests); otherwise a new entry is created.

If you genuinely need HMR for an interactive session, run `pnpm dev` in a separate terminal — but stop the PM2 server first (`pnpm stop`) so the two don't fight over port 1337. **Never leave `pnpm dev` running as the long-lived server**: HMR file watchers can restart the process mid-operation (e.g. while a git push hook runs), orphaning in-flight jobs and marking them `exit -1`.

## Architecture
- `app/` — Next.js pages and API route handlers
- `components/` — React client components; large pages have a co-located subfolder (e.g. `components/monitoring/`, `components/settings/`, `components/project-detail/`, `components/project-runs/`, `components/terminal/`)
- `hooks/` — Custom React hooks
- `lib/` — Server-side business logic, organised into domain folders:
  - `lib/pipeline/` — release pipeline orchestration (`start-*`, `pipeline-lock`, `pipeline-status`, `pipeline-steps`, `mark-dod-branch`, `pr-create`, `pending-release`)
  - `lib/scheduling/` — agent/test scheduling (`agent-scheduler`, `internal-scheduler`, `test-scheduler`, `scheduling`, `fire-times`, `launchagent`)
  - `lib/git/` — git operations (`git-branch`, `git-utils`, `diff-context`)
  - `lib/jobs/` — job lifecycle (`job-storage` barrel + `storage`, `lifecycle`, `verdict`, `probe`, `types`, `parent-context`; also `pm2-jobs`, `run-history`, `log-persistence`, `retention`, `claude-stream-parser`)
  - `lib/terminal/` — terminal streaming (`terminal-session-store`, `ansi-render`)
  - `lib/agents/` — agent management (`agent-memory`, `agents-cache`, `default-agent-skills`, `file-agent-overrides`, `tamtam-file-agents`)
  - `lib/skills/` — skills (`skills`, `tamtam-file-config`)
  - `lib/shared/` — cross-cutting utilities (`shell`, `types`, `format`, `config`, `untrusted`, `usage-pricing`, `notifications`, `job-control`, `statusConstants`, `gh-status`, `project-data`, `project-branch-lock`)
  - `lib/db/` — Drizzle schema and connection (tables: settings, projects, jobs, gh_status, gh_issues_cache, skills, agents, pipeline_locks)
  - `lib/client-api.ts` — barrel re-exporting from `lib/client/` (split by resource: `projects`, `jobs`, `agents`, `skills`, `types`)
- `scripts/` — server startup, job runners, and CLI shims (`pm2-start.sh`, `job-runner.js`, `gemini-shim.js`, `lmstudio-shim.js`)
- `skills/` — claude-skills submodule
- `data/` — SQLite database (gitignored)
- `__tests__/` — vitest unit tests
- `e2e/` — Playwright integration tests
- `docs/` — architecture docs (see **Docs Reference** section below)

**File size conventions (enforced by convention, not tooling):**
- No new top-level files directly in `lib/` — all new lib modules must go in a domain subfolder
- New lib files: target under 300 lines, hard cap 500 lines
- New component files: target under 400 lines, hard cap 600 lines; if a page component grows past 600 lines, extract subcomponents into a co-located `components/<page-name>/` folder

**React Server vs Client Components (Next.js App Router):**
- All files in `components/` are Client Components — every file must start with `'use client'` (single quotes, first line).
- Pages in `app/` are Server Components by default; do not add `'use client'` to a page file unless the page itself needs React hooks directly (rare — usually the page just imports a client component).
- Never use browser-only APIs (`window`, `document`, `localStorage`) in `app/` page/layout files.

**Adding a new API route:**
1. Create `app/api/<path>/route.ts` — export named functions (`GET`, `POST`, etc.).
2. Add a matching test at `__tests__/api/<route-name>.test.ts`.
3. Document the route in the API Routes section of this file.
4. If the route needs a new DB table, follow the schema change procedure in Commit & Branch Rules.

## Pages
- `/` — Projects list with status, changes, CI
- `/project/[name]` — Project overview with agents, status bar (changes/review/tests)
- `/project/[name]/config` — Test command, pipeline mode (Direct Branch / PR Workflow), automation flags, custom actions editor; single **Save** button at top covers all sections (config + custom actions saved together)
- `/project/[name]/history` — Project runs with filter tabs (all/running/failed/done)
- `/project/[name]/changes` — Git diff viewer for uncommitted changes
- `/project/[name]/issues` — GitHub PRs and issues viewer (open PRs with review status, open issues)
- `/project/[name]/terminal/[sessionId]` — Interactive Claude runner with model selector (haiku/sonnet/opus), skill picker, and real-time token streaming via SSE (see `docs/STREAMING.md`)
- `/project/[name]/docs` — Project documentation files viewer
- `/project/[name]/task/[task]` — Task detail view
- `/project/[name]/release/[releaseId]` — Release trace view: pipeline steps, per-step verdicts and log excerpts for a specific release run
- `/agents` — Agents management page
- `/monitoring` — Prometheus + Loki health dashboard (alerts, service up/down, log errors)
- `/pipeline` — Pipeline health metrics dashboard (verdict distribution, fix-loop stats, step durations, MTTR, per-project breakdown; filterable by 24h/7d/30d/all)
- `/stats` — Token usage dashboard (runs, input/output/cache tokens, cost per project and per agent kind, filterable by 24h/7d/30d/all)
- `/runs` — All runs across projects (replaces `/jobs`, which now redirects here)
- `/logs` — Log viewer
- `/skills` — Skill editor (CRUD for DB-backed skills)
- `/settings` — Workspace path, frequency, claude binary, DB backup

## API Routes
- `/api/agents` — CRUD for agents (GET: accepts `?project=` and `?name=` filters, POST)
- `/api/agents/[agentId]` — Agent detail (GET, PATCH, DELETE)
- `/api/agents/[agentId]/run` — Run agent (POST) — composes skills into prompt
- `/api/agents/by-name` — Update agent by project+name without knowing its UUID (PATCH: `{ project, name, ...fields }`) — enables agents to self-improve
- `/api/agents/scheduler-health` — Verify the internal scheduler matches the DB (GET returns `{ ok, expected, actual, missing, orphans, errors, internal: { started, entries: [{ agentId, project, name, schedule, nextFireMs, lastFireMs, fireCount, errorCount, lastError }] } }`); POST reinstalls anything missing and sweeps legacy PM2 cron orphans, then returns `{ before, after, installed, installFailures }`. Surfaced on the `/monitoring` page.
- `/api/skills` — CRUD for skills (GET, POST)
- `/api/skills/[skillId]` — Skill detail (GET, PATCH, DELETE)
- `/api/projects` — All projects list (GET)
- `/api/projects/personas` — File-based skills from `skills/docs/skills/` (GET)
- `/api/projects/[schedId]/priority` — Set project scheduling priority (PATCH)
- `/api/projects/[schedId]/pause` — Pause project scheduling (POST)
- `/api/projects/[schedId]/resume` — Resume project scheduling (POST)
- `/api/projects/[schedId]/detail` — Project scheduling detail (GET)
- `/api/projects/by-project/[name]/action` — Custom actions (GET, PUT, POST)
- `/api/projects/by-project/[name]/config` — Project test command config (GET, PATCH)
- `/api/projects/by-project/[name]/run` — Run Claude on project (POST, accepts `model` param)
- `/api/projects/by-project/[name]/review` — Start AI code review (POST)
- `/api/projects/by-project/[name]/review-pr` — Start AI review of a GitHub PR (POST)
- `/api/projects/by-project/[name]/fix-ci` — Start AI CI fix run (POST)
- `/api/projects/by-project/[name]/test` — Run project test command (POST)
- `/api/projects/by-project/[name]/changes` — Uncommitted changes summary (GET, returns `defaultBranch` in addition to `branch`/`ahead`/`behind`/`files`); git pull with configurable strategy (POST: ff-only/merge/rebase)
- `/api/projects/by-project/[name]/changes/diff` — Full git diff content (GET)
- `/api/projects/by-project/[name]/checkout-default` — Switch working copy to the project's default branch; refuses if there are uncommitted changes (POST, returns `{ status: 'switched'|'already-on-branch', branch }`)
- `/api/projects/by-project/[name]/push` — Push changes to git (POST)
- `/api/projects/by-project/[name]/create-pr` — Push current branch + create GitHub PR with a generated title (derived from the linked GitHub issue title or commit log; falls back to `gh pr create --fill`) (POST); returns `{ url }` — refuses if on default branch
- `/api/projects/by-project/[name]/release` — Trigger release pipeline (POST)
- `/api/projects/by-project/[name]/release/[releaseId]` — Release detail: meta-job + ordered pipeline step jobs with verdicts and log excerpts (GET)
- `/api/projects/by-project/[name]/release/abort` — Abort the active release pipeline: marks the release job aborted, kills the running step job, and releases the pipeline lock (POST)
- `/api/projects/by-project/[name]/issues` — GitHub PRs and issues for the project (GET, POST to force refresh); merge POST switches working copy to default branch after merge
- `/api/projects/by-project/[name]/issue-branch` — Create or checkout `fix/issue-<n>-<slug>` before Claude edits (POST); called automatically from TerminalTab when opening from an issue
- `/api/projects/by-project/[name]/continue-issue` — Build a "Continue work" payload for an issue (GET: `?issue_number=N`); returns `{ sessionId, prompt, unverifiedCount, hasContext }` — finds the most recent Claude run tagged with the issue and the most recent mark-dod log, then composes a focused prompt listing only the unverified acceptance criteria
- `/api/projects/by-project/[name]/mark-dod` — Run DoD verification for latest issue-linked run (POST); also triggered automatically after review→LGTM
- `/api/projects/by-project/[name]/pr-branch` — Fetch and checkout a PR's head branch so Terminal opens on the right branch (POST: `{ branch }`)
- `/api/projects/by-project/[name]/pr-gates` — TamTam-side gate state for a PR: tests/review/DoD badges (GET); used by IssuesTab
- `/api/projects/by-project/[name]/branch` — Current branch name + default branch (GET); returns `{ branch, defaultBranch, commitsAhead }` (`commitsAhead` is the count of local commits not yet in `origin/<default>`, or `null` when on the default branch; no `git fetch` is issued)
- `/api/projects/by-project/[name]/behind` — Ahead/behind commit counts vs remote (GET)
- `/api/projects/by-project/[name]/logs` — Project run log files (GET)
- `/api/projects/by-project/[name]/docs` — Project documentation files (GET)
- `/api/config/projects` — Scan workspace for git repos and configure projects (GET, PATCH)
- `/api/jobs` — All runs across projects (GET)
- `/api/jobs/[jobId]` — Job detail (GET, DELETE)
- `/api/jobs/[jobId]/logs` — Job log content (GET)
- `/api/jobs/[jobId]/rerun` — Re-run a job (POST)
- `/api/jobs/[jobId]/fix` — Start AI fix run for a failed job (POST)
- `/api/jobs/[jobId]/seen` — Mark job as seen (POST)
- `/api/jobs/notifications` — Unseen job notifications (GET)
- `/api/jobs/notifications/mark-seen` — Mark all notifications seen (POST)
- `/api/streaming/[jobId]` — SSE stream of parsed text deltas from NDJSON log (`?raw=1` for raw lines)
- `/api/settings` — Settings CRUD (GET, PATCH) — includes `base_prompt` for global agent instructions and all `notification_*` keys
- `/api/settings/test-notification` — Send a test webhook payload to verify connectivity (POST)
- `/api/settings/backup` — SQLite hot backup (POST)
- `/api/health` — Health check (GET)
- `/api/monitoring` — Prometheus + Loki status aggregation (GET); env: `PROMETHEUS_URL`, `LOKI_URL`
- `/api/monitoring/pm2-logs` — Tail tamtam PM2 log files (error + out from `~/.pm2/logs/`), last 64 KB; accepts `?limit=` (max 500) and `?out=0` to suppress stdout log (GET)
- `/api/stats/usage` — Token usage statistics per project and per agent kind (GET, accepts `?window=24h|7d|30d|all`)
- `/api/stats/pipeline` — Pipeline health metrics: verdict distribution, fix-loop stats, step durations, MTTR, per-project breakdown (GET, accepts `?window=24h|7d|30d|all` and `?project=`; 60s cache)

## Testing Requirements
- **All new API routes must have vitest tests** in `__tests__/api/`; lib logic tests go in `__tests__/lib/` or alongside the file.
- Follow existing test patterns (in-memory SQLite, mocked shell/PM2 calls).
- **Do not mock the database** — use an in-memory `better-sqlite3` instance with the real Drizzle schema instead. Mock only external side-effects: `lib/shared/shell.ts` `exec`, PM2, Claude CLI spawning.
- Run `pnpm test` after every non-trivial code change, not only after writing new tests. All tests must pass before committing.
- Test naming: `__tests__/api/<route-name>.test.ts` mirroring `app/api/<route-name>/route.ts`.
- **`createTestDb()` pattern**: each test file defines its own local `createTestDb()` that opens `new Database(':memory:')` with `pragma journal_mode = WAL` and creates only the tables that test actually needs via raw SQL. There is no shared helper — copy the pattern from the nearest similar test file. Never import the real DB connection in tests.
- **E2e vs unit**: three kinds of Playwright tests exist — (1) browser tests in `e2e/` for UI-only rendering and component state; (2) pipeline e2e tests in `e2e/pipeline/` for full pipeline chains (review → fix → commit → push) where completion hooks and PM2 job lifecycle must be exercised end-to-end; (3) API integration tests via `request` fixture. Write a pipeline e2e test when you need to verify that completion hooks chain correctly across multiple steps, or that the probe sweep picks up a PM2 job's exit code and triggers the right follow-on step — unit tests cannot catch these because they mock the async job lifecycle. See `docs/E2E.md` for the full pipeline harness guide (mocks, scenarios, helpers, how to add a new spec). All API routes and lib logic must have vitest unit tests. Component tests with `@testing-library/react` are available but optional — prefer testing behaviour through the API layer instead.
- **What must be tested**: new API route handlers (happy path + error cases), new lib functions that contain branching logic or state mutations. Skip trivial passthrough functions and pure type definitions.
- **Pipeline e2e isolation**: `pnpm test:e2e:pipeline` launches a dedicated Next.js dev server on port 1338, uses a temp SQLite DB (`/tmp/tamtam-e2e-pipeline/data/db/tamtam.db`), and intercepts all `git`/`gh` CLI calls via shims in `e2e/pipeline/mocks/bin/`. Tests run sequentially (`workers: 1`) to prevent shim-state collisions. Never run pipeline e2e against the production server or DB.
- **Pre-push hook** (`.husky/pre-push`): runs `pnpm lint && pnpm type-check && pnpm test` before every push. If the hook fails, fix the root cause — do not bypass with `--no-verify`.

## Definition of Done for UI/Frontend Changes
- Server must be running (`pnpm start` — or `pnpm rebuild` if a build is needed) before testing frontend changes
- Use Chrome DevTools MCP (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`) to navigate to the relevant page and take a screenshot verifying the UI renders correctly
- Test the golden path and key edge cases visually in the browser
- Check for regressions in adjacent features
- Do NOT claim frontend work is complete without the Chrome MCP screenshot step

## Key Patterns
- All config stored in DB (`settings`, `projects`, `skills`, `agents` tables)
- Workspace path configured in Settings UI, projects discovered by scanning for git repos
- All CLI calls (git, gh, launchctl, pm2) go through `lib/shared/shell.ts`
- `lib/shared/project-data.ts` assembles project data with 10s TTL cache
- Terminal runs use `claude --output-format stream-json` for token-by-token streaming via PM2 + log file + fs.watch + NDJSON parser (see `docs/STREAMING.md`)
- SSE at `/api/streaming/[jobId]` parses NDJSON and sends text deltas + `done` event (`?raw=1` for raw mode)
- Agent runs compose skill content into the prompt before sending to Claude CLI
- `commit_style` setting injects a style guide into the commit-message generation prompt; `review_verdict_rules` setting drives LGTM/NEEDS ATTENTION/DO NOT SHIP decisions in code reviews — both configurable in Settings UI (Behavior tab)
- File-based skills scanned from `skills/docs/skills/` and `data/skills/` (category subdirs, any `.md` file with optional YAML frontmatter: `title`, `description`)
- DB-backed skills created via `/skills` page or API; a set of built-in agent skills (cto, security-review, dependency-check, blog, ci-monitor, release-ready, tests, gha-audit, docs-claude, readme-sync, self-improve, manage-agents, senior-fullstack) is seeded from `lib/default-agent-skills.ts` on first `GET /api/skills`
- GitHub owner fallback configurable via `GITHUB_OWNER` env var or Settings UI
- Issue-driven runs auto-checkout `fix/issue-<n>-<slug>` branch before Claude edits (via `issue-branch` route called from TerminalTab); in PR Workflow mode, after the PR is merged the working copy is returned to the default branch
- Pipeline workflow mode per project: *Direct Branch* (commit+push to current branch) or *PR Workflow* (push to feature branch → DoD → optional auto-merge); configured via project Config tab; `pr_workflow_enabled` + `auto_pr_merge_enabled` flags on the `projects` table
- Outbound webhook notifications (`lib/shared/notifications.ts`): Slack block kit, Discord embeds, or generic JSON POST; HMAC-SHA256 signed when `notification_webhook_secret` is set; events: `release_success`, `release_fail`, `release_aborted`, `fix_loop_exhausted`, `review_do_not_ship`, `agent_run_fail`; configured via Settings → Notifications tab; `TAMTAM_BASE_URL` env var sets the log link base
- Log and row retention (`lib/jobs/retention.ts`): `pruneProjectLogs` deletes on-disk log files after each run (controlled by `log_retention_count` and `log_retention_days` settings; defaults 200 / 30 days); `runNightlyCleanup` deletes finished `jobs` DB rows older than `job_row_retention_days` (default 180 days) — called once at startup then every 24h from `instrumentation.ts`
- **Global job pause**: `lib/shared/job-control.ts` exposes `isJobsPaused()` / `syncJobsPauseState(paused)`. When the `jobs_paused` setting is `true` (toggled via the Settings UI or the pause toggle in the Jobs header), all pipeline routes (`run`, `review`, `fix`, `push`, `release`, `rerun`, `fix-ci`, `agent run`) return HTTP 409 and the internal scheduler is paused. State is held in a module-level boolean — `syncJobsPauseState` is called on settings write and on boot from `instrumentation-node.ts`.
- Background probe sweep: `instrumentation.ts` runs `runProbeSweep` every 30 seconds — detects Claude CLI processes that hang after emitting their final result event (holding a job "running" indefinitely) and resolves them via `probeJobStatus` in `lib/jobs/job-storage.ts`
- **Issue-branch lock** (`lib/shared/project-branch-lock.ts`): when a project's working tree is checked out on a `fix/issue-N-…` branch, the internal scheduler skips any scheduled agent fire for that project. Prevents unrelated agent commits landing on an in-progress feature branch. The lock state is cached for 5 s (TTL) and cleared by `checkout-default` and `issue-branch` routes after branch switches. Exposed as `getIssueBranchLock(projectName)` / `clearIssueBranchLockCache(projectName)` from `lib/shared/project-branch-lock.ts`.
- **Scheduled agent cron**: handled in-process by `lib/scheduling/internal-scheduler.ts`, NOT by PM2 cron. PM2's `cron_restart` combined with `--no-autostart` silently no-ops (PM2 updates `pm_uptime` at the cron tick but never starts the stopped process), so registering agents that way leaves them as zombies that never fire — that bug went unnoticed for a long time. The internal scheduler reads enabled agents from the DB on boot (`reinstallAgents` in `instrumentation-node.ts`), arms a `setTimeout` per agent based on its `Nh`/`Nm` interval + a stableHash phase offset, and on fire POSTs to `/api/agents/{id}/run`. State is pinned on `globalThis.__tamtamScheduler` so instrumentation and route handlers share the singleton across Next.js's separate module realms. Agent CRUD routes still call `installAgentSchedule` / `uninstallAgentSchedule` from `lib/scheduling/agent-scheduler.ts`, which now delegate to `upsertAgentSchedule` / `removeAgentSchedule`. The `launchctl` runner is **deprecated** (warning logged on use); only `pm2` is supported going forward.
- **One-shot job processes**: every job (review, fix, fix-push, mark-dod, agent run, rerun) is spawned by `lib/jobs/pm2-jobs.ts startJob` via PM2 → `scripts/job-runner.js` (a single node entrypoint) → the actual command. PM2 invokes the runner with `--interpreter node`, so PM2 tracks the runner's PID directly — no bash-wrapper layer. The runner forwards SIGTERM/SIGINT/SIGHUP to its child so `pm2 stop`/`pm2 delete` actually kills the work (this is what eliminated the orphan-process accumulation we used to see in `pm2 list`). The runner pipes the `${jobId}.prompt` file into the child's stdin (matching the old `cat prompt | command` behaviour) and writes `[tamtam] launching: ...` / `[tamtam] exited with code N` breadcrumbs to the same log file `app/api/streaming/[jobId]/route.ts` filters out of the user-facing stream. The `${jobId}.prompt` file is still written so `/api/jobs/[jobId]/rerun` can restore the original prompt; the per-job `.sh` wrapper is gone.
- Dependabot with grouped PRs (production deps, dev deps, actions)

## `.tamtam/` Directory (per-project, committed to version control)

Each tracked workspace project can have a `.tamtam/` directory in its root for version-controlled TamTam config. TamTam reads these files on every request; writes from the UI are saved back automatically.

### `.tamtam/config.yml`
The team contract — committed to version control and shared by everyone working on the repo. Captures shared-by-all settings only. All fields are optional.

```yaml
# .tamtam/config.yml
pipeline:
  test_command: pnpm test         # overrides auto-detected command

actions:
  custom_actions:                 # buttons shown on the project page
    - name: Deploy
      command: pnpm deploy
      color: green

security:
  safe_users:                     # GitHub logins whose PR comments are not wrapped as untrusted
    - octocat
```

Supported keys: `test_command`, `custom_actions`, `safe_users`. **Workflow flags** (`pr_workflow_enabled`, `auto_commit_enabled`, `auto_push_enabled`, `auto_pr_merge_enabled`, `release_after_run`, `test_cron_enabled`, `test_cron_schedule`, `tests_disabled`, `review_disabled`, `issue_auto_branch`) are **DB-only** — each developer opts in individually. Older `.tamtam/config.yml` files may still contain those keys; TamTam migrates them to the DB on startup and ignores them on subsequent reads.

On a feature/PR branch, config is read from `origin/<defaultBranch>` (not the working tree) to prevent privilege escalation from untrusted branches.

Reader: `lib/skills/tamtam-file-config.ts` → `loadFileConfig(projectPath)` / `writeFileConfig(projectPath, updates)`.
The Config tab shows a banner listing which keys come from the file; saving writes back to `.tamtam/config.yml`.

### `.tamtam/agents/*.md`
Each `.md` file defines one read-only agent scoped to the project. Filename (minus `.md`) is the agent name. YAML frontmatter sets metadata; body is the prompt.

```markdown
---
model: sonnet          # sonnet | opus | haiku
schedule: 4h           # optional: 15m 30m 1h 2h 4h 8h 12h 24h
skillIds: ["agent-tests"]   # JSON array or space-separated skill IDs
runner: pm2            # pm2 | launchctl
enabled: true
---

Prompt content here. This is sent verbatim as the agent's task instructions.
```

File agents appear in the Agents tab with a `file` badge and are read-only — edit/delete are disabled in the UI. To override a file agent, create a DB agent with the same name (DB takes precedence).

Reader: `lib/agents/tamtam-file-agents.ts` → `scanFileAgents(projectPath, projectName)` / `loadFileAgent(...)`.
File agent IDs use the format `file:<project>:<name>` and are handled transparently in all agent API routes.

## Docs Reference

Detailed architecture documentation lives in `docs/`. Read the relevant file before touching the subsystem it covers.

| File | Topic | Load when… |
|------|-------|------------|
| `docs/STREAMING.md` | Job lifecycle + SSE streaming infrastructure | Touching terminal runs, log tailing, SSE endpoints, or NDJSON parsing |
| `docs/PIPELINE.md` | Release pipeline state machine (test→review→fix→commit→push→dod→merge) | Modifying any pipeline step, completion hooks, or pipeline orchestration |
| `docs/DATABASE.md` | Drizzle schema reference — all tables, columns, indices | Adding/changing DB tables, writing migrations, or working with `lib/db/` |
| `docs/SETTINGS.md` | All `settings` table keys, their types, and defaults | Adding a new setting, reading config in a new place, or changing defaults |
| `docs/AGENT.md` | Agent concepts: skills composition, scheduling, runner lifecycle | Working on agents, the internal scheduler, or skill composition |
| `docs/CACHING.md` | Layered TTL cache strategy (in-memory + SQLite) | Adding a new cache layer, changing TTLs, or debugging stale data |
| `docs/PROFILING.md` | Server/client/Turbopack profiling guide | Investigating perf regressions or high CPU/memory |
| `docs/SECURITY.md` | Security model: file-agent trust, untrusted input handling, threat surface | Any security-sensitive change: auth, file-agent parsing, untrusted content |
| `docs/SHIM.md` | Gemini/LM Studio CLI shim compatibility layer | Touching `scripts/gemini-shim.js`, `lmstudio-shim.js`, or shim configuration |
| `docs/UI.md` | Design system: tokens, typography, components, voice | Any visual/UI change — read before touching CSS or components; canonical previews in `docs/ui-preview/*.html` |
| `docs/PROMPT-SIZE.md` | Prompt size & cache-read cost analysis | Changing skill/prompt composition, adding skills, or investigating token cost |
| `docs/E2E.md` | Playwright pipeline e2e harness: mocks, scenarios, helpers | Writing or debugging pipeline e2e tests in `e2e/pipeline/` |

## Coding Conventions
- **Runtime versions**: Next.js 16 (App Router), React 19, TypeScript 6 (strict), Tailwind CSS v4, pnpm 10. Do not use APIs or syntax that requires a higher version than what is pinned in `package.json`.
- **Path imports**: always use the `@/` alias (e.g. `import { exec } from '@/lib/shared/shell'`), never relative `../../` paths.
- **File naming**: kebab-case for all files (`start-fix.ts`, `project-data.ts`); PascalCase only for React component files (`AgentsTab.tsx`).
- **Components**: PascalCase, one component per file, `.tsx` extension. No class components.
- **Barrel files**: `lib/client-api.ts` is the only barrel; do not create new barrel `index.ts` files — import directly from the module file.
- **TypeScript**: strict mode is on. Avoid `any`; ESLint allows it but prefer explicit types. Never use `// @ts-ignore` — fix the type instead.
- **Error handling**: throw exceptions for unexpected failures; return typed result objects (`{ ok, error }`) only where callers need to branch on failure without crashing. Log errors to `console.error` before re-throwing in API routes.
- **Async**: use `async/await` throughout. No raw `.then()` chains. Parallelise independent async work with `Promise.all`.
- **Linting**: `pnpm lint` runs ESLint on `app/`, `components/`, `lib/`, `hooks/`. Auto-fix with `--fix` is acceptable. Run after significant edits.
- **Type checking**: `pnpm type-check` runs `tsc --noEmit`. Run before committing any TypeScript change.

## Dependency & Supply-Chain Security
- **Lock file**: always commit `pnpm-lock.yaml`. Never install packages with `--no-lockfile` or `--frozen-lockfile` bypassed.
- **Allowed build scripts**: `package.json` pins `pnpm.onlyBuiltDependencies` to `[better-sqlite3, esbuild, sharp, unrs-resolver]`. Do not add a new package to this list without explicit user approval; postinstall scripts run arbitrary code.
- **No silent additions**: never add a new dependency not already in `package.json` without explicit user approval. Justify every new dep in the commit message (why it's needed, why no existing dep covers it).
- **Verify before adding**: check new packages on npmjs.com for download count, publish date, and maintainer history before adding. Prefer packages with >1 M weekly downloads and >1 year of history.
- **Audit after changes**: run `pnpm audit` after any `pnpm add`/`pnpm remove` and fix or document any high-severity findings before committing.

## Commit & Branch Rules
- **Conventional commits**: use the format `type(scope): message` — types observed in this repo: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`. Keep the subject line under 72 characters.
- **Direct to master**: this is a solo project; direct commits to `master` are fine. No PR required for local changes.
- **DB schema changes**: always pair a schema edit in `lib/db/schema.ts` with `pnpm db:generate` (creates migration file) and `pnpm db:migrate` (applies it). Never edit migration files by hand; never delete them.
- **Never bypass hooks**: do not pass `--no-verify` to `git commit`. If a hook fails, fix the underlying issue.
- **No secrets in code**: use environment variables for all credentials. Never commit `.env` files or hardcode tokens/keys.
