<p align="center">
  <img src="public/logo.png" alt="TamTam" width="480" />
</p>

# TamTam

The agent management dashboard built for Claude-compatible CLIs. Define skills, compose agents, run them on demand or on an interval schedule — all from a single web interface that lives alongside your code.

## What it does

**Skills → Agents → Runs.** Compose reusable instruction blocks (skills) into agents. Run them against any project in your workspace. Watch output stream in real time. Rerun, fix, and schedule — without touching a terminal.

| Feature | Details |
|---|---|
| **Multi-project overview** | All your git repos at a glance — uncommitted changes, CI status, last run |
| **Skill composition** | DB-backed skills + file-based skills from `skills/docs/skills/` and `data/skills/`. Mix and match into agents |
| **Real-time streaming** | Token-by-token output via SSE. Watch the selected provider work in real time |
| **Interactive terminal** | Full runner per project — model tier selector (Fast / Normal / Smart), skill picker, persistent sessions across reconnects |
| **Smart push** | AI-generated commit messages, diff preview, one-click push |
| **CI repair** | Failed CI run? One click sends the selected provider to fix it |
| **Scheduling** | Built-in interval scheduler — daily reviews, nightly audits, whatever you need, running unattended |
| **Release pipeline** | Quality-gated, branch-context-driven flow: test → review → fix loop → commit → push → DoD (`mark-dod`) → pr-wait → soak → merge. Default-branch releases push directly; non-default branches open or reuse a PR |
| **Cross-project recommendations** | Open agent and scheduler suggestions across every project in `/recommendations` |
| **Semantic retrieval** | Optional local context injection from project docs, DB-backed skills, and completed agent run reports via `pgvector` + Ollama |
| **Pipeline health** | Live release pipeline metrics in `/pipeline` |
| **Custom actions** | Per-project bash commands (deploy, migrate, seed) as colored buttons |
| **Notifications** | Unseen run alerts with bell badge; outbound webhooks (Slack, Discord, ntfy, generic) for release success/fail/aborted, fix-loop-exhausted, review-do-not-ship, agent-run-fail, and budget-blocked events |

## Architecture

TamTam is a single Next.js 16 (App Router) application backed by Postgres. The Next.js server is supervised by PM2; agent intake runs through the workflow runtime, which TamTam pins to the local world by default (`WORKFLOW_TARGET_WORLD=local`, `WORKFLOW_LOCAL_DATA_DIR=data/workflow-data`), and scheduled agents run through graphile-worker, so a crash or restart does not lose in-flight work.

```
       ┌──────────────────────────────────────────────────────────────┐
       │                    Next.js 16 (App Router)                   │
       │   pages + API routes + SSE streams + Server Components       │
       │                                                              │
       │  ┌───────────────────┐  ┌─────────────────────────────────┐  │
       │  │  Agent intake     │→ │  Durable workflow (@workflow)   │  │
       │  │  (POST /api/...)  │  │  composePrompt → startAgent     │  │
       │  └───────────────────┘  └──────────────┬──────────────────┘  │
       │                                        ▼                     │
       │  ┌──────────────────────────────────────────────────────┐    │
       │  │   Workflow steps spawn one-shot CLI jobs             │    │
       │  │   → log files → fs.watch → SSE token stream → UI     │    │
       │  └──────────────────────────────────────────────────────┘    │
       └────────────────┬──────────────────────────┬──────────────────┘
                        │                          │
                        ▼                          ▼
        ┌─────────────────────────────┐   ┌────────────────────────┐
        │ Postgres 16 + pgvector      │   │ Ollama (local, opt.)   │
        │ (Drizzle ORM, node-postgres)│   │ embeddings for         │
        │  · jobs, agents, skills,    │   │ pgvector retrieval     │
        │    projects, settings…      │   └────────────────────────┘
        │  · workflow state (durable, │
        │    local-world files in     │
        │    `data/workflow-data`     │
        │    by default)              │
        │  · pgvector retrieval index │
        └─────────────────────────────┘
```

## Stack

- **Next.js 16** (App Router) — frontend, API routes, and SSE streaming in one process
- **Postgres 16 + pgvector** via `pg.Pool` + Drizzle ORM — main source of truth for jobs, agents, skills, settings, and retrieval embeddings
- **`workflow` runtime** — `"use workflow"` / `"use step"` orchestration for agent intake (`composePrompt` → `startAgent`); TamTam pins the local world by default (`WORKFLOW_TARGET_WORLD=local`, `WORKFLOW_LOCAL_DATA_DIR=data/workflow-data`) and keeps workflow data under `data/workflow-data`. A Postgres-backed workflow world is an explicit operator override, not the default.
- **graphile-worker** — durable cron queue for scheduled agents and system maintenance
- **PM2** — supervises the long-running TamTam server; one-shot CLI jobs are spawned in-process by workflow steps and route handlers
- **SSE** — token-by-token log streaming straight from job log files via `fs.watch` + NDJSON parser
- **Ollama** (optional, local) — embeddings for the pgvector-backed retrieval index
- **Tailwind CSS v4**
- **vitest** with PGlite for in-memory API tests; **Playwright** for browser + pipeline e2e

## Getting started

TamTam requires Node.js 24.x. The repo pins that version in [`.nvmrc`](.nvmrc) and enforces the same major via `package.json` `engines`.

```bash
nvm use               # or install Node.js 24.x with your preferred version manager
pnpm install
docker compose up -d postgres                                           # Postgres 16 + pgvector on :5432
DATABASE_URL=postgres://tamtam:tamtam@localhost:5432/tamtam pnpm db:migrate
echo 'DATABASE_URL=postgres://tamtam:tamtam@localhost:5432/tamtam' > .env.local
pnpm run rebuild   # build + PM2-managed start/restart on :1337 (canonical after edits)
```

Open `http://localhost:1337`, go to Settings, set your workspace path. TamTam scans for git repos and populates the projects list automatically.

```bash
pnpm start        # start or idempotently restart the PM2-managed production server
pnpm restart      # legacy immediate build + PM2 restart via scripts/pm2-start.sh
pnpm stop       # stop the PM2 server
pnpm logs       # PM2 log tail
pnpm dev        # foreground next dev with HMR (local debugging only — stop PM2 first)
pnpm dev:qa     # deterministic Docker QA environment on :1338
pnpm mcp:http <tool> [json_args]  # call local TamTam HTTP endpoints via .tamtam/mcp-http-tools.yaml
```

> Bare `pnpm rebuild` runs pnpm's built-in native-deps rebuild, not this project's restart script. Use `pnpm run rebuild` or `pnpm restart`.

> `pnpm dev` is for active local debugging only — it runs foreground without PM2 and must not be left running as the long-lived server.

> `pnpm dev:qa` starts a seeded TamTam instance at `http://localhost:1338` with `next dev` inside Docker. The working tree is bind-mounted, so code edits are picked up by the dev watcher without rebuilding the image. It uses mocked `git`, `gh`, `pm2`, and provider shims plus an isolated `pgvector/pgvector:pg16` Postgres and workspace under Compose volumes.

> `pnpm mcp:http` uses the sibling `mcp-http-tools` checkout by default; set `MCP_HTTP_TOOLS_DIR` if that repo lives elsewhere.

## Configuration

Runtime config, including notification throttle state, lives in the Postgres database referenced by `DATABASE_URL`. Shared per-project settings can also be committed in `.tamtam/config.yml`, and file-agent prompts can live in `.tamtam/agents/*.md`.
Per-project dev-server lifecycle fields (`dev_server_start_command`, `dev_server_stop_command`, `dev_server_ready_url`) live in `/project/[name]/config` as DB-only project metadata and let TamTam start, gate, and tear down a project's own app during agent runs.

The Settings area is split across `/settings/general`, `/settings/cli`, `/settings/pipeline`, `/settings/notifications`, `/settings/projects`, `/settings/templates`, and `/settings/database`.
Bare `/settings` redirects to `/settings/general`, and legacy `/jobs` redirects to `/runs`.

| Setting | Where |
|---|---|
| Workspace path | `/settings/general` |
| GitHub owner and board sync | `/settings/general` |
| CLI provider routing, binaries, model tiers, and subscription budget controls | `/settings/cli` |
| Global base prompt | `/settings/cli` |
| Pipeline behavior, commit/review rules, and model overrides | `/settings/pipeline` |
| Project enablement | `/settings/projects` |
| Agent templates | `/settings/templates` |
| Per-project test commands | `/project/[name]/config` (Config tab) |
| Per-project dev-server lifecycle | `/project/[name]/config` (Config tab, DB-only) |
| Custom actions | `/project/[name]/config` (Config tab) |
| Notifications | `/settings/notifications` |
| Database backup | `/settings/database` |

Optional env vars:

```bash
DATABASE_URL=...       # Required. Postgres connection string (e.g. postgres://tamtam:tamtam@localhost:5432/tamtam)
GITHUB_OWNER=...       # GitHub org/user fallback for repository lookups when a project has no explicit GitHub setting
TAMTAM_BASE_URL=...    # Base URL for outbound webhook log links (default: http://localhost:1337)
PROMETHEUS_URL=...     # Prometheus base URL for monitoring dashboard (default: http://localhost:9090)
LOKI_URL=...           # Loki base URL for log monitoring (default: http://localhost:3100)
```

## Skills

Skills are reusable instruction blocks injected into agent prompts. Two sources:

- **DB-backed** — create and edit via `/skills`
- **File-based** — auto-scanned from `skills/docs/skills/` (vendored curated library) and `data/skills/`; any `.md` file in a category subdirectory, with optional YAML frontmatter (`title`, `description`)

Agents are built by selecting a model, writing a prompt, and attaching any number of skills and project docs. Agents can also pin a provider or prerequisite command. At run time, attached content is prepended to the prompt before the configured provider sees it.

## Agents

Agents live at `/agents`. Each agent has:
- A name and optional prompt
- A target project
- A model tier (`fast` / `normal` / `smart`; legacy `haiku` / `sonnet` / `opus` still work)
- An optional interval schedule
- A composed set of skills

Prompt is optional when skills are attached — skills alone are enough to run an agent.

Run any agent on demand from the UI, or let the scheduler fire it automatically.

TamTam also ships a curated recommended-agent catalog in the Agents tab, including `issue-cruncher`, `qa`, `docs-claude`, and `manage-agents`.

## Testing

```bash
pnpm test           # vitest unit tests
pnpm test:e2e       # Playwright (requires dev server running)
pnpm test:e2e:pipeline  # pipeline e2e tests (isolated dev server + temp DB)
pnpm type-check     # TypeScript
pnpm check          # lint + type-check + test (all in one)
```

API routes are covered by vitest tests in `__tests__/api/`, often with combined route coverage files. Follow the existing pattern: in-memory PGlite via `__tests__/helpers/test-db.ts`, mocked shell/PM2 calls.

## Architecture notes

- Most CLI calls (git, gh, pm2) go through `lib/shared/shell.ts`; a few specialized helpers use direct `child_process` spawning when they need tighter process control.
- `lib/shared/project-data.ts` assembles project state with a 10s TTL cache
- `instrumentation-node.ts` handles boot-time recovery, the 30s probe sweep, graphile-worker cron seeding/worker startup, and nightly retention cleanup after startup
- Project detail tabs live at `/project/[name]` and `/project/[name]/[tab]` (`overview`, `config`, `history`, `terminal`, `changes`, `issues`, `docs`, `agents`)
- Project release traces and task detail pages live at `/project/[name]/release/[releaseId]` and `/project/[name]/task/[task]`
- Streaming uses the selected provider's `stream-json` output → job log file → `fs.watch` → NDJSON parser → SSE
- See `docs/STREAMING.md` for the full terminal streaming architecture
