# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Vision: CI/CD for code, driven by Claude

TamTam's north star is a **quality-gated release pipeline** for each tracked repo. Each project has two workflow modes (set in the project Config tab):

**Direct Branch**: `test → review → (fix loop) → commit → push`
**PR Workflow**: `test → review → (fix loop) → commit → push → dod → merge`

Steps are pluggable per project and coordinated by completion hooks in `lib/job-storage.ts`:

- **test** — runs the project's test command (auto-detected from `package.json`/`pyproject.toml`/`Package.swift`/`Cargo.toml`/`go.mod`/`Makefile:test` or user-configured). Skipped if none. If tests pass and there are no uncommitted changes, the pipeline short-circuits directly to push (skipping review).
- **review** — Claude reads the uncommitted diff and emits a verdict: `LGTM` / `NEEDS ATTENTION` / `DO NOT SHIP` (verdict rules are configurable in Settings).
- **fix** — on `NEEDS ATTENTION` / `DO NOT SHIP`, Claude resumes the review session and applies fixes. Capped at 3 iterations per 30-minute window to prevent loops. On success it chains back to review.
- **commit + push** — on `LGTM`, staged changes are committed with a Claude-generated message (respecting the `commit_style` setting) and pushed. All changes (including untracked files) are staged via `git add -A`; `.gitignore` is trusted to exclude secrets.
- **mark-dod** *(PR Workflow only)* — after push, Claude inspects the codebase with tool access (Read/Grep/Glob) to verify which acceptance-criteria checkboxes in the linked GitHub issue are actually implemented, then ticks only the verified ones. Best-effort and non-fatal.
- **merge** *(PR Workflow + auto-merge enabled)* — polls CI checks on the PR and merges once they pass. After merge, the working copy is returned to the default branch.

The **🚀 Release** button triggers the pipeline at the right starting step. When `auto_push_enabled` is on (per-project config, off by default), the chain continues automatically from one step to the next. The pipeline strip in the Terminal tab shows the live state of each step (`○` pending, spinner running, `✓` done, `!` needs attention, `✗` failed); clicking a step opens its log. The strip is **only visible while the pipeline is actively running** — it disappears when all steps finish. Each release starts with a clean strip: only jobs from the current run are shown. Steps that come after the currently-running step always render as `○` (they haven't executed yet in this run), and prior steps are only shown as `✓` if they started within 30 minutes of the running step (older jobs are from a previous release and are ignored).

**Helpers** (composable building blocks used by both the API routes and the auto-chain):
- `lib/start-test.ts` → `startProjectTest`
- `lib/start-review.ts` → `startProjectReview`
- `lib/start-fix.ts` → `startFixFromJob`
- `lib/start-fix-push.ts` → `startFixPush` (pre-commit/pre-push hook failure recovery)
- `lib/start-commit.ts` → `startProjectCommit` (stage all changes + generate commit message via Claude; also exports `generateCommitMessage`, `issueBranchName`, `findIssueContext`, `detectMainBranch`)
- `lib/start-push.ts` → `startProjectPush`
- `lib/start-release.ts` → `startRelease` (pipeline entry point)
- `lib/start-pr-review.ts` → `startPrReview` (AI review of a GitHub PR)
- `lib/start-mark-dod.ts` → `startMarkDod` (DoD verification + GitHub issue checkbox update)
- `lib/start-pr-wait.ts` → `launchPrWait` (background PR poller: polls CI checks, auto-merges once they pass, switches working copy back to default branch, then runs mark-dod)
- `lib/notifications.ts` → `notify` / `sendTestNotification` (outbound webhook delivery)

Verdict detection (`getVerdict` in `job-storage.ts`) reads the **last 2000 chars** of the parsed Claude log and looks for an explicit "Verdict: X" marker or a bare token on the final line — deliberately lenient across markdown formatting (`## Verdict\n**NEEDS ATTENTION**`) but robust against false positives from code snippets higher up in the log.

## Concepts
- **Skills** — reusable prompt/instruction blocks (DB-backed + file-based from `skills/docs/skills/`)
- **Agents** — composed from skills + model + prompt + schedule + runner (pm2/launchctl)
- **Runs** — individual executions of an agent (what was previously called "jobs")
- **Custom Actions** — per-project bash commands (e.g. deploy) with configurable button color
- **Release Pipeline** — two modes: *Direct Branch* (`test → review → fix → commit → push`) or *PR Workflow* (adds `dod → merge`), driven by Claude and configurable per project

## Tech Stack
- **Framework**: Next.js 16 (App Router) — both frontend and backend
- **Database**: Drizzle ORM + better-sqlite3, WAL mode, DB at `data/tamtam.db` (gitignored)
- **Streaming**: SSE via route handlers for real-time run output
- **Styling**: Tailwind CSS v4
- **Skills**: `skills/` submodule (claude-skills) — engineering skills scanned from `skills/docs/skills/`; user-defined skills in `data/skills/`
- **Testing**: vitest + Playwright (e2e)
- **Package Manager**: pnpm
- **Release**: semantic-release on push to master (GitHub releases only, no npm)

## Commands
- `pnpm dev` — start dev server via PM2 on port 1337 (streams logs)
- `pnpm stop` — stop dev server
- `pnpm restart` — restart dev server
- `pnpm logs` — view PM2 logs
- `pnpm build` — production build
- `pnpm start` — start production server via PM2
- `pnpm test` — run unit tests
- `pnpm test:e2e` — run Playwright e2e tests (requires dev server running)
- `pnpm type-check` — TypeScript check
- `pnpm check` — lint + type-check + test (all in one)

**Never run `next dev` directly — always use PM2 via the scripts above.**

### Hot reload vs. restart

Dev is `next dev --port 1337` under PM2 — **Turbopack HMR is on**. Do **not** `pnpm restart` for code changes; it's not only unnecessary, it's a trap: if a stray `next-server` child survives the SIGTERM, the new PM2 process hits `EADDRINUSE`, goes `errored`, and the orphan keeps serving *stale* code. That's the #1 source of "why isn't my edit showing up?" pain in this repo.

- **No restart needed**: component edits, hook edits, utility edits, API route *body* changes, `lib/*` changes — HMR picks them up on the next request.
- **Restart IS needed**: brand-new route files (Turbopack doesn't always register new `app/**/route.ts` without a restart), new DB migrations in `lib/db/index.ts`, env var changes, `package.json` scripts.

If you do restart and run into the EADDRINUSE loop, see `## Investigating a misbehaving dev server` below.

## Architecture
- `app/` — Next.js pages and API route handlers
- `components/` — React client components
- `hooks/` — Custom React hooks
- `lib/` — Server-side business logic
- `lib/db/` — Drizzle schema and connection (tables: settings, projects, jobs, gh_status, gh_issues_cache, skills, agents, pipeline_locks)
- `skills/` — claude-skills submodule
- `data/` — SQLite database (gitignored)
- `__tests__/` — vitest unit tests
- `e2e/` — Playwright integration tests
- `docs/` — architecture docs: `STREAMING.md` (job lifecycle + SSE), `PIPELINE.md` (release pipeline state machine), `DATABASE.md` (schema reference), `SETTINGS.md` (all config keys), `AGENT.md` (agent concepts), `CACHING.md` (layered TTL cache strategy)

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
- `/agents` — Agents management page
- `/monitoring` — Prometheus + Loki health dashboard (alerts, service up/down, log errors)
- `/stats` — Token usage dashboard (runs, input/output/cache tokens, cost per project, filterable by 24h/7d/30d/all)
- `/runs` — All runs across projects (replaces `/jobs`, which now redirects here)
- `/logs` — Log viewer
- `/skills` — Skill editor (CRUD for DB-backed skills)
- `/settings` — Workspace path, frequency, claude binary, DB backup

## API Routes
- `/api/agents` — CRUD for agents (GET, POST)
- `/api/agents/[agentId]` — Agent detail (GET, PATCH, DELETE)
- `/api/agents/[agentId]/run` — Run agent (POST) — composes skills into prompt
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
- `/api/projects/by-project/[name]/changes` — Uncommitted changes summary (GET); git pull with configurable strategy (POST: ff-only/merge/rebase)
- `/api/projects/by-project/[name]/changes/diff` — Full git diff content (GET)
- `/api/projects/by-project/[name]/push` — Push changes to git (POST); sub-routes: `/preview`, `/execute`, `/generate`
- `/api/projects/by-project/[name]/release` — Trigger release pipeline (POST)
- `/api/projects/by-project/[name]/issues` — GitHub PRs and issues for the project (GET, POST to force refresh); merge POST switches working copy to default branch after merge
- `/api/projects/by-project/[name]/issue-branch` — Create or checkout `fix/issue-<n>-<slug>` before Claude edits (POST); called automatically from TerminalTab when opening from an issue
- `/api/projects/by-project/[name]/mark-dod` — Run DoD verification for latest issue-linked run (POST); also triggered automatically after review→LGTM
- `/api/projects/by-project/[name]/pr-branch` — Fetch and checkout a PR's head branch so Terminal opens on the right branch (POST: `{ branch }`)
- `/api/projects/by-project/[name]/pr-gates` — TamTam-side gate state for a PR: tests/review/DoD badges (GET); used by IssuesTab
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
- `/api/stats/usage` — Token usage statistics per project (GET, accepts `?window=24h|7d|30d|all`)

## Testing Requirements
- **All new API routes must have vitest tests** in `__tests__/`
- Follow existing test patterns (in-memory SQLite, mocked shell/PM2 calls)
- Run `pnpm test` after writing tests to verify they pass

## Definition of Done for UI/Frontend Changes
- Dev server must be running (`pnpm dev`) before testing frontend changes
- Use Chrome DevTools MCP (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`) to navigate to the relevant page and take a screenshot verifying the UI renders correctly
- Test the golden path and key edge cases visually in the browser
- Check for regressions in adjacent features
- Do NOT claim frontend work is complete without the Chrome MCP screenshot step

## Key Patterns
- All config stored in DB (`settings`, `projects`, `skills`, `agents` tables)
- Workspace path configured in Settings UI, projects discovered by scanning for git repos
- All CLI calls (git, gh, launchctl, pm2) go through `lib/shell.ts`
- `lib/project-data.ts` assembles project data with 10s TTL cache
- Terminal runs use `claude --output-format stream-json` for token-by-token streaming via PM2 + log file + fs.watch + NDJSON parser (see `docs/STREAMING.md`)
- SSE at `/api/streaming/[jobId]` parses NDJSON and sends text deltas + `done` event (`?raw=1` for raw mode)
- Agent runs compose skill content into the prompt before sending to Claude CLI
- `commit_style` setting injects a style guide into the commit-message generation prompt; `review_verdict_rules` setting drives LGTM/NEEDS ATTENTION/DO NOT SHIP decisions in code reviews — both configurable in Settings UI (Behavior tab)
- File-based skills scanned from `skills/docs/skills/` and `data/skills/` (category subdirs, any `.md` file with optional YAML frontmatter: `title`, `description`)
- DB-backed skills created via `/skills` page or API; a set of built-in agent skills (cto, security-review, dependency-check, blog, ci-monitor, release-ready, gha-audit, readme-sync) is seeded from `lib/default-agent-skills.ts` on first `GET /api/skills`
- GitHub owner fallback configurable via `GITHUB_OWNER` env var or Settings UI
- Issue-driven runs auto-checkout `fix/issue-<n>-<slug>` branch before Claude edits (via `issue-branch` route called from TerminalTab); in PR Workflow mode, after the PR is merged the working copy is returned to the default branch
- Pipeline workflow mode per project: *Direct Branch* (commit+push to current branch) or *PR Workflow* (push to feature branch → DoD → optional auto-merge); configured via project Config tab; `pr_workflow_enabled` + `auto_pr_merge_enabled` flags on the `projects` table
- Outbound webhook notifications (`lib/notifications.ts`): Slack block kit, Discord embeds, or generic JSON POST; HMAC-SHA256 signed when `notification_webhook_secret` is set; events: `release_success`, `release_fail`, `fix_loop_exhausted`, `review_do_not_ship`, `agent_run_fail`; configured via Settings → Notifications tab; `TAMTAM_BASE_URL` env var sets the log link base
- Dependabot with grouped PRs (production deps, dev deps, actions)
