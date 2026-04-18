<p align="center">
  <img src="public/logo.png" alt="TamTam" width="480" />
</p>

# TamTam

The agent management dashboard built for Claude CLI. Define skills, compose agents, run them on demand or on a cron schedule — all from a single web interface that lives alongside your code.

## What it does

**Skills → Agents → Runs.** Compose reusable instruction blocks (skills) into agents. Run them against any project in your workspace. Watch output stream in real time. Rerun, fix, and schedule — without touching a terminal.

| Feature | Details |
|---|---|
| **Multi-project overview** | All your git repos at a glance — uncommitted changes, CI status, last run |
| **Skill composition** | DB-backed skills + file-based skills from the `claude-skills` submodule. Mix and match into agents |
| **Real-time streaming** | Token-by-token output via SSE. Watch Claude think as it works |
| **Interactive terminal** | Full Claude runner per project — model selector (haiku/sonnet/opus), skill picker, persistent sessions across reconnects |
| **Smart push** | AI-generated commit messages, diff preview, one-click push |
| **CI repair** | Failed CI run? One click sends Claude to fix it |
| **Scheduling** | Built-in cron scheduler — daily reviews, nightly audits, whatever you need, running unattended |
| **Custom actions** | Per-project bash commands (deploy, migrate, seed) as colored buttons |
| **Notifications** | Unseen run alerts with bell badge |

## Stack

- **Next.js 16** (App Router) — frontend + backend in one
- **Drizzle ORM + SQLite** — WAL mode, zero infra
- **Tailwind CSS v4**
- **PM2** — process management for both dev and production
- **SSE** — real-time log streaming without WebSocket overhead
- **vitest + Playwright** — unit and e2e tests

## Getting started

```bash
pnpm install
pnpm dev        # starts on :1337 via PM2
```

Open `http://localhost:1337`, go to Settings, set your workspace path. TamTam scans for git repos and populates the projects list automatically.

```bash
pnpm stop       # stop dev server
pnpm restart    # restart dev server
pnpm logs       # PM2 log tail
pnpm build && pnpm start  # production
```

> Never run `next dev` directly — always use the PM2 scripts above.

## Configuration

All config lives in the SQLite database (`data/tamtam.db`). Nothing to edit by hand.

| Setting | Where |
|---|---|
| Workspace path | Settings page |
| Global base prompt | Settings page |
| Claude binary path | Settings page |
| Per-project test commands | `/project/[name]/config` |
| Custom actions | `/project/[name]/config` |

Optional env vars:

```bash
GITHUB_OWNER=...     # GitHub org/user fallback for CI lookups
```

## Skills

Skills are reusable instruction blocks injected into agent prompts. Two sources:

- **DB-backed** — create and edit via `/skills`
- **File-based** — auto-scanned from `skills/docs/skills/` (the `claude-skills` submodule, all `SKILL.md` files with frontmatter) and `data/skills/`

Agents are built by selecting a model, writing a prompt, and attaching any number of skills. At run time, skill content is prepended to the prompt before Claude sees it.

## Agents

Agents live at `/agents`. Each agent has:
- A name and description
- A target project (or runs globally)
- A model (haiku / sonnet / opus)
- An optional cron schedule
- A composed set of skills

Run any agent on demand from the UI, or let the scheduler fire it automatically.

## Testing

```bash
pnpm test           # vitest unit tests
pnpm test:e2e       # Playwright (requires dev server running)
pnpm type-check     # TypeScript
```

All API routes have corresponding tests in `__tests__/`. Follow the existing pattern: in-memory SQLite, mocked shell/PM2 calls.

## Architecture notes

- All CLI calls (git, gh, pm2, launchctl) go through `lib/shell.ts`
- `lib/project-data.ts` assembles project state with a 10s TTL cache
- Streaming uses `claude --output-format stream-json` → PM2 log file → `fs.watch` → NDJSON parser → SSE
- See `docs/TERMINAL.md` for the full terminal streaming architecture
