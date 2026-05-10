# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude-compatible CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Vision: CI/CD for code, driven by the selected provider

TamTam's north star is a **quality-gated release pipeline** for each tracked repo: `test → review → (fix loop) → commit → push → dod → merge`.

Steps are pluggable per project. The **🚀 Release** button triggers the pipeline at the right starting step; with `auto_push_enabled` on, the chain continues automatically. PR-vs-direct behavior is decided at runtime from branch context: releases on the default branch push directly, while releases on any non-default branch open or reuse a PR so `dod` and `merge` can run when applicable. Verdicts (`LGTM` / `NEEDS ATTENTION` / `DO NOT SHIP`) are emitted by the selected provider during review and drive fix loops. Fixes themselves are unbounded — the cap (3 iterations per release) is enforced on the next verification step (re-test or re-review), so a final fix always lands but may go unverified. The pipeline strip in the Terminal tab shows live step state (`○` pending, spinner running, `✓` done, `!` needs attention, `✗` failed) and is only visible while a pipeline is actively running.

**See `docs/PIPELINE.md`** for the full state machine, completion-hook chain, helper modules (`lib/pipeline/start-*.ts`), verdict-detection rules, fresh-LGTM skip logic, and `mark-dod` / `pr-wait` behavior.

## Concepts
- **Skills** — reusable prompt/instruction blocks (DB-backed + file-based skills from `skills/docs/skills/` and `data/skills/`)
- **Agents** — composed from skills + model + prompt + interval schedule + runner. `pm2` is the default runner; `launchctl` is deprecated.
- **Runs** — individual executions of an agent; the legacy `/jobs` URL redirects to `/runs`
- **Custom Actions** — per-project bash commands (e.g. deploy) with configurable button color
- **Release Pipeline** — see Vision above

## Tech Stack
- **Framework**: Next.js 16 (App Router) — both frontend and backend
- **Database**: Drizzle ORM + better-sqlite3, WAL mode, DB at `data/db/tamtam.db` (gitignored)
- **Streaming**: SSE via route handlers for real-time run output
- **Styling**: Tailwind CSS v4
- **Agent providers**: Claude-compatible CLI shims for Claude, Gemini, LM Studio, Codex, and custom backends
- **Skills**: `skills/` submodule (claude-skills) — file-based skills; user-defined skills in `data/skills/`
- **Testing**: vitest + Playwright (e2e)
- **Package Manager**: pnpm
- **Release**: semantic-release on push to master (GitHub releases only, no npm)

## Commands
- `pnpm dev` — `next dev` foreground on port 1337 (HMR enabled, no PM2). Local debugging only.
- `pnpm start` — start (or idempotently restart) production server via PM2 on port 1337. Self-heals if a previous orphan is squatting on the port. Canonical way to run TamTam.
- `pnpm run rebuild` / `pnpm restart` — build then restart under PM2. `pnpm run rebuild` expands to `pnpm build && pnpm start`; `pnpm restart` expands to `pnpm build && bash scripts/pm2-start.sh`. Canonical post-edit command. (Note: bare `pnpm rebuild` triggers pnpm's native-deps rebuild instead — use `pnpm run rebuild`.)
- `pnpm stop` — stop the PM2 server.
- `pnpm logs` — view PM2 logs.
- `pnpm mcp:http <tool> [json_args]` — call local TamTam HTTP endpoints via the sibling `mcp-http-tools` checkout (`.tamtam/mcp-http-tools.yaml`). Prefer `tamtam_api_get` for path-only GET routes, e.g. `pnpm mcp:http tamtam_api_get '{"path":"jobs/notifications"}'`.
- `pnpm build` — production build.
- `pnpm test` / `pnpm test:watch` — vitest unit tests
- `pnpm test:e2e` — Playwright e2e (requires dev server on port 1337)
- `pnpm test:e2e:pipeline` — pipeline e2e (`e2e/pipeline/`); spins up an isolated Next.js dev server on port 1338 with a temp DB at `/tmp/tamtam-e2e-pipeline/`. See `docs/E2E.md`.
- `pnpm lint` / `pnpm type-check` / `pnpm check` — ESLint / `tsc --noEmit` / lint+type-check+test
- `pnpm db:generate` / `pnpm db:migrate` — Drizzle migrations
- `pnpm dev:profile` / `pnpm dev:flamegraph` — Turbopack tracing / V8 CPU profiling. See `docs/PROFILING.md`.

**Always run TamTam under PM2 via `pnpm start` / `pnpm run rebuild`.** `pnpm dev` is foreground-only — never use as the long-lived server (HMR file watchers can restart mid-operation, orphaning in-flight jobs).

### Applying code changes

TamTam runs in **production mode** (`next start`) under PM2 — no HMR. After any code change, run `pnpm run rebuild`. `pnpm start` is idempotent: existing entry is restarted in place; otherwise a new entry is created. If you genuinely need HMR, run `pnpm dev` after `pnpm stop` so the two don't fight over port 1337.

## Architecture
- `app/` — Next.js pages and API route handlers
- `components/` — React client components; large pages have a co-located subfolder (e.g. `components/monitoring/`, `components/settings/`, `components/project-detail/`, `components/project-runs/`, `components/terminal/`)
- `hooks/` — Custom React hooks
- `lib/` — Business logic and client helpers, organised into domain folders: `pipeline/`, `scheduling/`, `git/`, `jobs/` (`job-storage` compatibility barrel), `terminal/`, `agents/`, `skills/`, `recommendations/`, `shared/`, `usage/`, `db/` (`index.ts` domain barrel), `github/`, `client/`. `lib/client-api.ts` is the only top-level barrel.
- `scripts/` — server startup, job runners, CLI shims (`pm2-start.sh`, `job-runner.js`, `claude-shim.js`, `gemini-shim.js`, `lmstudio-shim.js`, `codex-shim.js`, `shim-utils.js`)
- `skills/` — claude-skills submodule
- `data/` — SQLite database (gitignored)
- `__tests__/` — vitest unit tests
- `e2e/` — Playwright integration tests
- `docs/` — architecture docs (see **Docs Reference** below)

**File size conventions (enforced by convention, not tooling):**
- No new top-level files directly in `lib/` — all new lib modules go in a domain subfolder
- New lib files: target under 300 lines, hard cap 500 lines
- New component files: target under 400 lines, hard cap 600 lines; if a page component grows past 600, extract subcomponents into `components/<page-name>/`

**React Server vs Client Components:**
- UI files in `components/` that render React must start with `'use client'` (single quotes, first line). Co-located type/constant/utility/hook modules may omit it when imported only from client components.
- Pages in `app/` are Server Components by default; do not add `'use client'` unless the page itself needs hooks directly.
- Never use browser-only APIs (`window`, `document`, `localStorage`) in `app/` page/layout files.

**Adding a new API route:**
1. Create `app/api/<path>/route.ts` — export named functions (`GET`, `POST`, etc.).
2. Add a matching test at `__tests__/api/<route-name>.test.ts`.
3. Document the route in `docs/API.md`.
4. If the route needs a new DB table, follow the schema change procedure in **Commit & Branch Rules**.

## Pages
- `/` — Projects list with status, changes, CI
- `/jobs` — Legacy runs redirect to `/runs`
- `/project/[name]` — Project overview; `/project/[name]/[tab]` — tabs (`overview`, `config`, `history`, `terminal`, `changes`, `issues`, `docs`, `agents`)
- `/project/[name]/terminal/[sessionId]` — Interactive selected-provider runner with model tier selector (fast/normal/smart; legacy haiku/sonnet/opus aliases still accepted), skill picker, real-time SSE streaming. See `docs/STREAMING.md`.
- `/project/[name]/task/[task]` — Task detail
- `/project/[name]/release/[releaseId]` — Release trace: pipeline steps, per-step verdicts, log excerpts
- `/agents` — Agents management
- `/monitoring` — Prometheus + Loki health dashboard
- `/pipeline` — Pipeline health metrics (filterable by 24h/7d/30d/all)
- `/recommendations` — Cross-project recommendations dashboard
- `/stats` — Token usage dashboard
- `/runs` — All runs across projects (`/jobs` redirects here)
- `/logs` — Log viewer
- `/skills` — Skill editor (CRUD for DB-backed skills)
- `/settings` → `/settings/general`; `/settings/[tab]` — `general`, `cli` (provider routing, binaries, model tiers, budget controls), `pipeline`, `notifications`, `projects`, `templates`, `database`

## API Routes

See `docs/API.md` for the full route reference. New routes must be documented there.

## Testing Requirements
- **All new API routes must have vitest tests** in `__tests__/api/`; lib logic tests go in `__tests__/lib/` or alongside the file.
- **Do not mock the database** — use an in-memory `better-sqlite3` instance with the real Drizzle schema. Mock only external side-effects: `lib/shared/shell.ts` `exec`, PM2, CLI spawning.
- Run `pnpm test` after every non-trivial code change. All tests must pass before committing.
- **Use the package scripts, not raw Vitest**: run `pnpm test` / `pnpm test:watch` instead of `vitest` directly so `scripts/ensure-better-sqlite3.js` runs first and verifies the native SQLite binding before the suite starts.
- Test naming: `__tests__/api/<route-name>.test.ts` mirroring `app/api/<route-name>/route.ts`.
- **`createTestDb()` pattern**: each test file defines its own local `createTestDb()` opening `new Database(':memory:')` with `pragma journal_mode = WAL` and creates only the tables that test needs via raw SQL. No shared helper — copy from the nearest similar test. Never import the real DB connection in tests.
- **Match the nearby test style**: this repo already mixes one-route-per-file tests with broader coverage files for closely related endpoints/components. Extend the nearest existing test when it already owns that behavior; do not introduce a new shared test utility layer just to avoid a little duplication.
- **E2e vs unit**: three kinds of Playwright tests — (1) browser tests in `e2e/` for UI rendering; (2) pipeline e2e in `e2e/pipeline/` for full pipeline chains where completion hooks and PM2 lifecycle must be exercised; (3) API integration tests via `request` fixture. Write a pipeline e2e when you need to verify cross-step hook chaining or probe-sweep-driven follow-ons. See `docs/E2E.md`.
- **What must be tested**: new API route handlers (happy + error), new lib functions with branching logic or state mutations. Skip trivial passthroughs.
- **Pipeline e2e isolation**: `pnpm test:e2e:pipeline` uses port 1338, temp DB at `/tmp/tamtam-e2e-pipeline/`, intercepts `git`/`gh` via shims in `e2e/pipeline/mocks/bin/`. Sequential workers. Never run pipeline e2e against production server or DB.
- **Pre-push hook** (`.husky/pre-push`): runs `pnpm lint && pnpm type-check && pnpm test`. If it fails, fix the root cause — do not bypass with `--no-verify`.
1. When testing route handlers or server modules that read settings, cache state, or other module-level singletons at import time, follow the existing pattern: `vi.resetModules()`, register mocks with `vi.doMock()`, then `await import(...)` the subject under test inside `beforeEach`. Do not statically import the module first and expect late mocks to apply.
2. For client-component tests, keep using `jsdom`, stub `next/navigation` and `fetch` at module scope, and use `vi.hoisted()` when a mock factory needs stable shared references across imports.

## Definition of Done for UI/Frontend Changes
- Server must be running (`pnpm start`, or `pnpm rebuild` if a build is needed) before testing
- Use Playwright MCP (`mcp__plugin_playwright_playwright__*`) to navigate to the relevant page and screenshot it. Chrome DevTools MCP is unreliable in this environment — prefer Playwright.
- Test the golden path and key edge cases visually; check for regressions in adjacent features
- Do NOT claim frontend work complete without the Playwright screenshot step

## Key Patterns
- Runtime config is stored in DB (`settings`, `projects`, `jobs`, `skills`, `agents`, `recommendations`, `ghStatus`, `ghIssuesCache`, `pipelineLocks`, `queuedAgentRuns`); shared per-project config and file-agent prompts can also live in committed `.tamtam/` files.
- Workspace path configured in Settings UI; projects discovered by scanning for git repos.
- Application/runtime DB access should import `db` / `schema` from `@/lib/db`. Do not open ad-hoc `better-sqlite3` connections in `app/`, `components/`, or `lib/`; reserve direct SQLite construction for tests and explicit bootstrap/maintenance scripts.
- Most CLI calls (git, gh, launchctl, pm2) go through `lib/shared/shell.ts`. `lib/shared/project-data.ts` assembles project data with 10s TTL cache.
- Client-side API helpers live under `lib/client/` and are surfaced through `lib/client-api.ts`. When a fetch pattern is reused across components, add or extend a helper there instead of duplicating request/response handling in the component.
- Direct `child_process` usage is the exception, not the default: keep ordinary shelling in `lib/shared/shell.ts`; only use raw spawn/process control in the runner/shim/streaming paths that already need it, and keep the reason obvious in code.
- Terminal runs use the selected provider's `stream-json` output for token-by-token streaming via PM2 + log file + fs.watch + NDJSON parser. SSE at `/api/streaming/[jobId]`. See `docs/STREAMING.md`.
- Agent runs compose skill content into the prompt before sending to the configured provider. An agent may declare an optional `prerequisiteCommand` shell command that runs before the CLI is spawned; its output (command, exit code, duration, stdout/stderr) is captured to `<logDir>/<jobId>.prereq.txt` and prepended to the agent's prompt. The Overview "Scheduled agents" block surfaces per-agent statistics — average run duration, success rate, total tokens (cache-aware), `cost_usd`, files touched, and (for review agents) the number of `fix` jobs sharing a `release_id` — fed by `/api/agents/stats`. The Agents tab opens a full-page editor with a ✨ Improve button next to the Prompt textarea, backed by `/api/agents/improve-prompt`. See `docs/AGENT.md` for skill composition, scheduling, runner lifecycle, the prerequisite hook, the stats aggregation, and the magic-wand prompt-rewrite endpoint.
- `commit_style` setting injects a style guide into commit-message generation; `review_verdict_rules` drives LGTM/NEEDS ATTENTION/DO NOT SHIP — both configurable in Settings → Pipeline. All settings keys/types/defaults: `docs/SETTINGS.md`.
- File-based skills scanned from `skills/docs/skills/` and `data/skills/` (category subdirs, any `.md` with optional YAML frontmatter: `title`, `description`). DB-backed skills via `/skills` page or API; built-in agent skills (cto, security-review, dependency-check, blog, ci-monitor, release-ready, tests, gha-audit, docs-claude, readme-sync, self-improve, manage-agents, senior-fullstack) seeded from `lib/agents/default-agent-skills.ts`.
- GitHub owner fallback configurable via `GITHUB_OWNER` env or Settings UI.
- Issue-driven runs auto-checkout `fix/issue-<n>-<slug>` (via `issue-branch` route from TerminalTab); after merge the working copy is returned to the default branch.
- Outbound webhook notifications (`lib/shared/notifications.ts`): Slack, Discord, ntfy, or generic JSON POST; HMAC-SHA256 signed when `notification_webhook_secret` is set; events: `release_success`, `release_fail`, `release_aborted`, `fix_loop_exhausted`, `review_do_not_ship`, `agent_run_fail`, `budget_blocked`. `TAMTAM_BASE_URL` sets log link base.
- Log/row retention (`lib/jobs/retention.ts`): `pruneProjectLogs` after each run (`log_retention_count` / `log_retention_days`, defaults 200 / 30); `runNightlyCleanup` deletes finished `jobs` rows older than `job_row_retention_days` (default 180); called once at startup then every 24h from `instrumentation-node.ts`.
- **Global job pause + budget gates** (`lib/shared/job-control.ts`): when `jobs_paused` is `true`, all pipeline routes return HTTP 409 and the internal scheduler pauses. When `budget_block_runs_enabled` is on and active quota exceeds `budget_block_at_pct`, job starts return HTTP 429. Pause state is module-level; `syncJobsPauseState` is called on settings write and on boot.
- Background recovery loops: `instrumentation-node.ts` schedules `runProbeSweep` every 30s, `drainStaleQueuedAgentRuns` every 30s, a 30s recovery reconcile sweep, a 5m auto-resume sweep, and a 60s budget-recovery ticker — the probe sweep detects providers that hang after the final result event and resolves them via `probeJobStatus`, while the recovery tickers drain queued agent/release work once blockers clear.
- **Per-project agent serialization** (`lib/agents/pending-agent-run.ts`): only one agent runs at a time per project. Concurrent calls to `/api/agents/[id]/run` while another `agent:*` job is active are enqueued (in-memory FIFO, idempotent per agentId) and the route returns HTTP 202 with `{ status: 'queued', blockingJobId }`. Lifecycle hook drains the queue when an agent job finishes. Same-agent duplicates still return 409.
- **Issue-branch lock** (`lib/shared/project-branch-lock.ts`): when checked out on `fix/issue-N-…`, the internal scheduler skips scheduled agent fires for that project. 5s TTL cache; cleared by `checkout-default` and `issue-branch` routes.
- **Scheduled agent intervals**: handled in-process by `lib/scheduling/internal-scheduler.ts`, NOT by PM2 cron (PM2 `cron_restart` + `--no-autostart` silently no-ops). State pinned on `globalThis.__tamtamScheduler` so route handlers and instrumentation share the singleton across Next.js's separate module realms. `launchctl` runner is deprecated. See `docs/AGENT.md`.
- **One-shot job processes**: CLI jobs are spawned by `lib/jobs/pm2-jobs.ts startJob` via PM2 → `scripts/job-runner.js` → the actual command. PM2 invokes the runner with `--interpreter node`, so PM2 tracks the runner's PID directly (no bash wrapper). Runner forwards SIGTERM/SIGINT/SIGHUP to its child. The `${jobId}.prompt` file is written so `/api/jobs/[jobId]/rerun` can restore the original prompt. Inline orchestrator jobs (`mark-dod`, `pr-wait`) run in the Next.js process and are reaped on boot if a restart abandons them.
- **GitHub project board sync**: lifecycle-triggered sync in `lib/github/project-board.ts` + `lib/github/project-board-status.ts`. Auto-sync from `lib/jobs/storage.ts` (start) and `lib/jobs/lifecycle.ts` (finish) is best-effort; manual sync routes (`/api/jobs/[jobId]/board-sync`, `/api/settings/board-resync`) are strict and surface errors. Pipeline child jobs update the root release card rather than creating duplicates.
- **Local HTTP MCP tools**: `.tamtam/mcp-http-tools.yaml` defines read-only TamTam API tools for the sibling `mcp-http-tools` project. Use `pnpm mcp:http tamtam_api_get '{"path":"..."}'` for arbitrary GET, or named wrappers like `pnpm mcp:http tamtam_usage_quota '{"provider":"codex"}'`.
- Dependabot with grouped PRs (production deps, dev deps, actions).
1. Mutable server-side coordination state is intentional in a few places (`globalThis.__tamtamScheduler`, pause gates, in-memory agent queues). If you add another singleton, only do it when cross-route/process coordination truly requires it, pin it on `globalThis` when Next.js module duplication would otherwise fork state, and document its boot/reload behavior in the relevant `docs/*.md`.

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

commits:
  commit_style: |                 # per-project commit voice; overrides the global commit_style setting
    Conventional commits, imperative mood, subject under 72 chars, no trailing period.
    Format: <type>(<scope>): <description>.
```

Supported keys: `test_command`, `custom_actions`, `safe_users`, `commit_style`. **Workflow flags** (`auto_commit_enabled`, `auto_push_enabled`, `auto_pr_merge_enabled`, `release_after_run`, `test_cron_enabled`, `test_cron_schedule`, `tests_disabled`, `review_disabled`, `issue_auto_branch`) are **DB-only** — each developer opts in individually. Older `.tamtam/config.yml` files may still contain those keys; TamTam migrates them to the DB on startup and ignores them on subsequent reads.

On a feature/PR branch, config is read from `origin/<defaultBranch>` (not the working tree) to prevent privilege escalation from untrusted branches.

Reader: `lib/skills/tamtam-file-config.ts` → `loadFileConfig(projectPath)` / `writeFileConfig(projectPath, updates)`.
The Config tab shows a banner listing which keys come from the file; saving writes back to `.tamtam/config.yml`.

### `.tamtam/agents/*.md`
Each `.md` file defines one agent scoped to the project. Filename (minus `.md`) is the agent name. YAML frontmatter sets default metadata; body is the prompt.

```markdown
---
provider: codex        # optional: claude | codex | gemini | lmstudio
model: normal          # fast | normal | smart (legacy haiku | sonnet | opus still read)
schedule: 4h           # optional: 15m 30m 1h 2h 4h 8h 12h 24h
skillIds: ["agent-tests"]   # JSON array or space-separated skill IDs
runner: pm2            # pm2 | launchctl
enabled: true
---

Prompt content here. This is sent verbatim as the agent's task instructions.
```

File agents appear in the Agents tab with a `file` badge. Prompt edits are written back to `.tamtam/agents/<name>.md`; committed frontmatter such as `provider` is preserved on write. Operational settings (`enabled`, `schedule`, `model`, `runner`, `skillIds`) are stored as DB overrides under `agent_override:<project>:<name>` so UI toggles do not dirty tracked files. A DB agent with the same project+name takes precedence over the file agent.

Reader: `lib/agents/tamtam-file-agents.ts` → `scanFileAgents(projectPath, projectName)` / `loadFileAgent(...)`.
File agent IDs use the format `file:<project>:<name>` and are handled transparently in all agent API routes.

## Docs Reference

Detailed architecture documentation lives in `docs/`. Read the relevant file before touching the subsystem it covers.

| File | Topic | Load when… |
|------|-------|------------|
| `docs/API.md` | Full API route reference | Adding/changing API routes |
| `docs/STREAMING.md` | Job lifecycle + SSE streaming infrastructure | Touching terminal runs, log tailing, SSE endpoints, or NDJSON parsing |
| `docs/PIPELINE.md` | Release pipeline state machine (test→review→fix→commit→push→dod→merge) | Modifying any pipeline step, completion hooks, or pipeline orchestration |
| `docs/DATABASE.md` | Drizzle schema reference — all tables, columns, indices | Adding/changing DB tables, writing migrations, or working with `lib/db/` |
| `docs/SETTINGS.md` | All `settings` table keys, their types, and defaults | Adding a new setting, reading config in a new place, or changing defaults |
| `docs/AGENT.md` | Agent concepts: skills composition, scheduling, runner lifecycle | Working on agents, the internal scheduler, or skill composition |
| `docs/CACHING.md` | Layered TTL cache strategy (in-memory + SQLite) | Adding a new cache layer, changing TTLs, or debugging stale data |
| `docs/PROFILING.md` | Server/client/Turbopack profiling guide | Investigating perf regressions or high CPU/memory |
| `docs/SECURITY.md` | Security model: file-agent trust, untrusted input handling, threat surface | Any security-sensitive change: auth, file-agent parsing, untrusted content |
| `docs/SHIM.md` | CLI shim compatibility layer (Claude, Gemini, Codex, LM Studio) | Touching `scripts/claude-shim.js`, `gemini-shim.js`, `codex-shim.js`, `lmstudio-shim.js`, or shim configuration |
| `docs/UI.md` | Design system: tokens, typography, components, voice | Any visual/UI change — read before touching CSS or components; canonical previews in `docs/ui-preview/*.html` |
| `docs/PROMPT-SIZE.md` | Prompt size & cache-read cost analysis | Changing skill/prompt composition, adding skills, or investigating token cost |
| `docs/E2E.md` | Playwright pipeline e2e harness: mocks, scenarios, helpers | Writing or debugging pipeline e2e tests in `e2e/pipeline/` |

## Coding Conventions
- **Stay project-generic in source**: TamTam is shared infrastructure across many projects. Do NOT reference any specific project slug, GitHub owner/repo, PR number, or issue number in code, comments, log strings, variable names, or commit messages within source files. Describe the symptom or behavior generically — say what triggers the bug, not which ticket reported it. Discovery context belongs in chat / PR descriptions, not in source. Such references rot fast (the ticket closes, projects get renamed) and leak operational context to anyone pulling the repo.
- **Runtime versions**: Next.js 16, React 19, TypeScript 6 (strict), Tailwind CSS v4, pnpm 10. Do not use APIs requiring a higher version than what's pinned in `package.json`.
- **Path imports**: always use the `@/` alias, never relative `../../`.
- **File naming**: kebab-case (`start-fix.ts`); PascalCase only for React component files (`AgentsTab.tsx`).
- **Symbol naming**: functions, variables, and hooks use `camelCase`; React components, TypeScript interfaces/types, and other constructors use `PascalCase`; keep `snake_case` only when matching persisted settings keys, DB columns, or external API payloads already defined that way.
- **Components**: PascalCase, one per file, `.tsx`. No class components.
- **Barrel files**: do not create new barrels or new `index.ts` re-export files. Existing exceptions are `lib/client-api.ts` (top-level client barrel), `lib/jobs/job-storage.ts` (compatibility barrel), and `lib/db/index.ts` (domain-local barrel); otherwise import directly from the module.
- **TypeScript**: strict mode is on. Avoid `any`. Never use `// @ts-ignore` — fix the type.
- **Error handling**: throw exceptions for unexpected failures; return typed result objects (`{ ok, error }`) only where callers must branch without crashing. Log errors to `console.error` before re-throwing in API routes.
- **Async**: `async/await` throughout, no raw `.then()` chains. Parallelise independent work with `Promise.all`.
- **UI styling**: use design tokens and component patterns from `docs/UI.md`; do not introduce one-off color scales, spacing systems, or global CSS outside the existing Tailwind v4 token setup.
- **Linting/typing**: `pnpm lint` after significant edits; `pnpm type-check` before committing.
- **Formatting**: there is no Prettier in this repo. Preserve the surrounding file's formatting style and use ESLint-driven fixes where needed; do not mass-reformat unrelated files.
- **Turbopack NFT comments**: Next.js 16 (Turbopack) traces server-route deps at build time. When a route's dep tree calls `path.join(dynamicVar, …)` or any `fs` call (`existsSync`, `readFileSync`, `readFile`, `openSync`, `statSync`, `watch`, `readdirSync`) with a *runtime-dynamic* path — settings paths, project paths, log paths, `homedir()`, `process.cwd() + userVar` — the static analyzer can't bound it and traces the **whole project**, dragging `next.config.ts` into every route bundle (warning: `Encountered unexpected file in NFT list`). Annotate the dynamic argument with `/*turbopackIgnore: true*/` inline at each call site (not just the original `join`). Examples: `existsSync(/*turbopackIgnore: true*/ p)`, `readFile(/*turbopackIgnore: true*/ path, 'utf8')`. Statically-scoped joins like `join(process.cwd(), 'data', name)` are fine.

## Dependency & Supply-Chain Security
- **Lock file**: always commit `pnpm-lock.yaml`. Never bypass `--frozen-lockfile` or use `--no-lockfile`.
- **Install scripts**: inspect `postinstall`, `prepare`, `preinstall`, `install` scripts before adding/updating any dependency. Treat them as arbitrary code execution.
- **Allowed build scripts**: `package.json` pins `pnpm.onlyBuiltDependencies` to `[better-sqlite3, esbuild, sharp, unrs-resolver]`. Do not add to this list without explicit user approval.
- **No silent additions**: never add a new dependency without explicit user approval. Justify every new dep in the commit message.
- **Verify before adding**: prefer packages with >1 M weekly downloads and >1 year of history.
- **Audit after changes**: run `pnpm audit` after any `pnpm add`/`pnpm remove`; fix or document high-severity findings before committing.
1. Use `pnpm` for all manifest and lockfile changes. Do not run `npm install`, `yarn add`, or any other package-manager command that can desync `pnpm-lock.yaml`.
2. Before proposing a new package, inspect the npm registry entry for maintainer continuity and release history, not just download count. Treat sudden ownership flips, very recent first publishes, or thin version history as a blocker unless the user explicitly accepts that risk.
3. Treat version bumps and lockfile refreshes as dependency changes too: after `pnpm up`, `pnpm update`, `pnpm dedupe`, or any manual `pnpm-lock.yaml` refresh, run `pnpm audit` and review newly introduced install/build scripts before committing.

## Commit & Branch Rules
- **Conventional commits**: `type(scope): message` — observed types: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`. Subject under 72 chars.
- **Direct to master**: solo project; direct commits to `master` are fine. No PR required for local changes.
- **DB schema changes**: always pair `lib/db/schema.ts` edits with `pnpm db:generate` and `pnpm db:migrate`. Never edit migration files by hand or delete them.
- **Never bypass hooks**: do not pass `--no-verify` to `git commit`. If a hook fails, fix the root cause.
- **No secrets in code**: env vars for credentials. Never commit `.env` files or hardcoded tokens.

## Scope & Safety Rules
- **Destructive git**: do not run `git reset --hard`, `git clean`, force pushes, branch deletion, or history rewrites unless explicitly requested.
- **Dirty worktrees are normal**: before editing, check whether the target file already has local changes. Preserve unrelated edits, work around them when possible, and never revert someone else's in-progress work just to get a clean diff.
- **Production data**: do not delete or rewrite `data/db/tamtam.db`, run destructive SQL, or remove project log directories without explicit approval.
- **Schema safety**: migrations must be additive or carefully backfilled; document any irreversible data loss before applying.
- **External side effects**: treat `git push`, GitHub issue/PR actions, webhook sends, and PM2 process changes as real side effects. Run only when required by the task and the target is clear.
- **Never SIGKILL system PIDs**: `lib/jobs/lifecycle.ts` runs `pgrep -P <job.pid>` + `process.kill(child, 'SIGKILL')` after job completion to clean up hung Claude CLI trees. PIDs ≤ `SAFE_PID_FLOOR` (100) are *refused* — PID 1 on macOS is `launchd`, whose children include Finder, Dock, the running terminal, and every user GUI app. A bad `job.pid` (corrupt DB row, zombie PM2 entry, a unit test passing `pid: 1`) without this guard would SIGKILL every user-owned process and restart the macOS UI in under a second. Any future code that takes a pid from job/DB state and calls `process.kill` MUST gate on `pid > SAFE_PID_FLOOR` and bail with `console.warn` otherwise. In tests, always use a high synthetic PID like `99999` for `createJob` — never a real or low PID.
