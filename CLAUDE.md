# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Vision: CI/CD for code, driven by Claude

TamTam's north star is a **quality-gated release pipeline** for each tracked repo:

```
   test → review → (fix loop) → commit → push
```

Each step is pluggable per project and coordinated by completion hooks in `lib/job-storage.ts`:

- **test** — runs the project's test command (auto-detected from `package.json`/`pyproject.toml`/`Package.swift`/`Cargo.toml`/`go.mod`/`Makefile:test` or user-configured). Skipped if none. If tests pass and there are no uncommitted changes, the pipeline short-circuits directly to push (skipping review).
- **review** — Claude reads the uncommitted diff and emits a verdict: `LGTM` / `NEEDS ATTENTION` / `DO NOT SHIP` (verdict rules are configurable in Settings).
- **fix** — on `NEEDS ATTENTION` / `DO NOT SHIP`, Claude resumes the review session and applies fixes. Capped at 3 iterations per 30-minute window to prevent loops. On success it chains back to review.
- **commit + push** — on `LGTM`, staged changes are committed with a Claude-generated message (respecting the `commit_style` setting) and pushed. Only tracked file modifications are staged automatically (untracked files are left alone to avoid sweeping up secrets).

The **🚀 Release** button triggers the pipeline at the right starting step. When `auto_push_enabled` is on (per-project config, off by default), the chain continues automatically from one step to the next. The pipeline strip in the Terminal tab shows the live state of each step (`○` pending, spinner running, `✓` done, `!` needs attention, `✗` failed); clicking a step re-triggers or opens its log.

**Helpers** (composable building blocks used by both the API routes and the auto-chain):
- `lib/start-test.ts` → `startProjectTest`
- `lib/start-review.ts` → `startProjectReview`
- `lib/start-fix.ts` → `startFixFromJob`
- `lib/start-fix-push.ts` → `startFixPush` (pre-commit/pre-push hook failure recovery)
- `lib/start-push.ts` → `startProjectPush`
- `lib/start-release.ts` → `startRelease` (pipeline entry point)
- `lib/start-pr-review.ts` → `startPrReview` (AI review of a GitHub PR)

Verdict detection (`getVerdict` in `job-storage.ts`) reads the **last 2000 chars** of the parsed Claude log and looks for an explicit "Verdict: X" marker or a bare token on the final line — deliberately lenient across markdown formatting (`## Verdict\n**NEEDS ATTENTION**`) but robust against false positives from code snippets higher up in the log.

## Concepts
- **Skills** — reusable prompt/instruction blocks (DB-backed + file-based from `skills/docs/skills/`)
- **Agents** — composed from skills + model + prompt + schedule + runner (pm2/launchctl)
- **Runs** — individual executions of an agent (what was previously called "jobs")
- **Custom Actions** — per-project bash commands (e.g. deploy) with configurable button color
- **Release Pipeline** — test → review → fix → commit → push, driven by Claude and configurable per project

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

## Architecture
- `app/` — Next.js pages and API route handlers
- `components/` — React client components
- `hooks/` — Custom React hooks
- `lib/` — Server-side business logic
- `lib/db/` — Drizzle schema and connection (tables: settings, projects, jobs, gh_status, gh_issues_cache, skills, agents)
- `skills/` — claude-skills submodule
- `data/` — SQLite database (gitignored)
- `__tests__/` — vitest unit tests
- `e2e/` — Playwright integration tests
- `docs/` — architecture docs: `STREAMING.md` (job lifecycle + SSE), `PIPELINE.md` (release pipeline state machine), `DATABASE.md` (schema reference), `SETTINGS.md` (all config keys), `AGENT.md` (agent concepts), `CACHING.md` (layered TTL cache strategy)

## Pages
- `/` — Projects list with status, changes, CI
- `/project/[name]` — Project overview with agents, status bar (changes/review/tests)
- `/project/[name]/config` — Test command + custom actions editor (name, command, color)
- `/project/[name]/history` — Project runs with filter tabs (all/running/failed/done)
- `/project/[name]/changes` — Git diff viewer for uncommitted changes
- `/project/[name]/issues` — GitHub PRs and issues viewer (open PRs with review status, open issues)
- `/project/[name]/terminal/[sessionId]` — Interactive Claude runner with model selector (haiku/sonnet/opus), skill picker, and real-time token streaming via SSE (see `docs/STREAMING.md`)
- `/project/[name]/docs` — Project documentation files viewer
- `/project/[name]/task/[task]` — Task detail view
- `/agents` — Agents management page
- `/monitoring` — Prometheus + Loki health dashboard (alerts, service up/down, log errors)
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
- `/api/projects/by-project/[name]/issues` — GitHub PRs and issues for the project (GET, POST to force refresh)
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
- `/api/settings` — Settings CRUD (GET, PATCH) — includes `base_prompt` for global agent instructions
- `/api/settings/backup` — SQLite hot backup (POST)
- `/api/health` — Health check (GET)
- `/api/monitoring` — Prometheus + Loki status aggregation (GET); env: `PROMETHEUS_URL`, `LOKI_URL`

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
- Dependabot with grouped PRs (production deps, dev deps, actions)
