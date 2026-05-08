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
| **Skill composition** | DB-backed skills + file-based skills from the `claude-skills` submodule. Mix and match into agents |
| **Real-time streaming** | Token-by-token output via SSE. Watch Claude think as it works |
| **Interactive terminal** | Full Claude runner per project — model tier selector (Fast / Normal / Smart), skill picker, persistent sessions across reconnects |
| **Smart push** | AI-generated commit messages, diff preview, one-click push |
| **CI repair** | Failed CI run? One click sends Claude to fix it |
| **Scheduling** | Built-in interval scheduler — daily reviews, nightly audits, whatever you need, running unattended |
| **Release pipeline** | Quality-gated Direct Branch or PR Workflow: test → review → fix loop → commit → push (→ DoD → merge), all driven by Claude |
| **Custom actions** | Per-project bash commands (deploy, migrate, seed) as colored buttons |
| **Notifications** | Unseen run alerts with bell badge; outbound webhooks (Slack, Discord, ntfy, generic) for release success/fail/aborted, fix-loop-exhausted, review-do-not-ship, agent-run-fail, and budget-blocked events |

## Stack

- **Next.js 16** (App Router) — frontend + backend in one
- **Drizzle ORM + better-sqlite3 + SQLite** — WAL mode, zero infra
- **Tailwind CSS v4**
- **PM2** — process management for the production server and one-shot agent jobs
- **SSE** — real-time log streaming without WebSocket overhead
- **vitest + Playwright** — unit and e2e tests

## Getting started

```bash
pnpm install
pnpm run rebuild   # build + PM2-managed start/restart on :1337 (canonical after edits)
```

Open `http://localhost:1337`, go to Settings, set your workspace path. TamTam scans for git repos and populates the projects list automatically.

```bash
pnpm build && pnpm start  # same end result as rebuild, but split into separate commands
pnpm restart      # same result as rebuild — build + PM2-managed start/restart
pnpm stop       # stop the PM2 server
pnpm logs       # PM2 log tail
pnpm dev        # foreground next dev with HMR (local debugging only — stop PM2 first)
pnpm mcp:http <tool> [json_args]  # call local TamTam HTTP endpoints via .tamtam/mcp-http-tools.yaml
```

> Bare `pnpm rebuild` runs pnpm's built-in native-deps rebuild, not this project's restart script. Use `pnpm run rebuild` or `pnpm restart`.

> `pnpm dev` is for active local debugging only — it runs foreground without PM2 and must not be left running as the long-lived server.

> `pnpm mcp:http` uses the sibling `mcp-http-tools` checkout by default; set `MCP_HTTP_TOOLS_DIR` if that repo lives elsewhere.

## Configuration

Runtime config lives in the SQLite database (`data/db/tamtam.db`). Shared per-project settings can also be committed in `.tamtam/config.yml`, and file-agent prompts can live in `.tamtam/agents/*.md`.

The Settings area is split across `/settings/general`, `/settings/cli`, `/settings/pipeline`, `/settings/notifications`, `/settings/projects`, `/settings/templates`, and `/settings/database`.
Bare `/settings` redirects to `/settings/general`, and legacy `/jobs` redirects to `/runs`.

| Setting | Where |
|---|---|
| Workspace path | `/settings/general` |
| GitHub owner and board sync | `/settings/general` |
| CLI provider routing, binaries, and model tiers | `/settings/cli` |
| Global base prompt | `/settings/cli` |
| Pipeline behavior, commit/review rules, and model overrides | `/settings/pipeline` |
| Project enablement | `/settings/projects` |
| Agent templates | `/settings/templates` |
| Per-project test commands | `/project/[name]/config` |
| Custom actions | `/project/[name]/config` |
| Notifications | `/settings/notifications` |
| Database backup | `/settings/database` |

Optional env vars:

```bash
GITHUB_OWNER=...       # GitHub org/user fallback for CI lookups
TAMTAM_BASE_URL=...    # Base URL for outbound webhook log links (default: http://localhost:1337)
PROMETHEUS_URL=...     # Prometheus base URL for monitoring dashboard (default: http://localhost:9090)
LOKI_URL=...           # Loki base URL for log monitoring (default: http://localhost:3100)
```

## Skills

Skills are reusable instruction blocks injected into agent prompts. Two sources:

- **DB-backed** — create and edit via `/skills`
- **File-based** — auto-scanned from `skills/docs/skills/` (the `claude-skills` submodule) and `data/skills/`; any `.md` file in a category subdirectory, with optional YAML frontmatter (`title`, `description`)

Agents are built by selecting a model, writing a prompt, and attaching any number of skills. At run time, skill content is prepended to the prompt before Claude sees it.

## Agents

Agents live at `/agents`. Each agent has:
- A name and optional prompt
- A target project
- A model tier (`fast` / `normal` / `smart`; legacy `haiku` / `sonnet` / `opus` still work)
- An optional interval schedule
- A composed set of skills

Prompt is optional when skills are attached — skills alone are enough to run an agent.

Run any agent on demand from the UI, or let the scheduler fire it automatically.

## Testing

```bash
pnpm test           # vitest unit tests
pnpm test:e2e       # Playwright (requires dev server running)
pnpm test:e2e:pipeline  # pipeline e2e tests (isolated dev server + temp DB)
pnpm type-check     # TypeScript
pnpm check          # lint + type-check + test (all in one)
```

API routes are covered by vitest tests in `__tests__/api/`, often with combined route coverage files. Follow the existing pattern: in-memory SQLite, mocked shell/PM2 calls.

## Architecture notes

- Most CLI calls (git, gh, pm2, launchctl) go through `lib/shared/shell.ts`; a few specialized helpers use direct `child_process` spawning when they need tighter process control.
- `lib/shared/project-data.ts` assembles project state with a 10s TTL cache
- Project detail tabs live at `/project/[name]` and `/project/[name]/[tab]`
- Streaming uses `claude --output-format stream-json` → PM2 log file → `fs.watch` → NDJSON parser → SSE
- See `docs/STREAMING.md` for the full terminal streaming architecture
