# TamTam — Agent Management Dashboard

Next.js monolith (App Router) for managing Claude CLI agents across multiple projects. Define skills, compose agents, run them on demand or on a schedule.

## Concepts
- **Skills** — reusable prompt/instruction blocks (DB-backed + file-based from `skills/docs/skills/`)
- **Agents** — composed from skills + model + prompt + schedule + runner (pm2/launchctl)
- **Runs** — individual executions of an agent (what was previously called "jobs")
- **Custom Actions** — per-project bash commands (e.g. deploy) with configurable button color

## Tech Stack
- **Framework**: Next.js 16 (App Router) — both frontend and backend
- **Database**: Drizzle ORM + better-sqlite3, WAL mode, DB at `data/tamtam.db` (gitignored)
- **Streaming**: SSE via route handlers for real-time run output
- **Styling**: Tailwind CSS v4
- **Skills**: `skills/` submodule (claude-skills) — engineering skills scanned from `skills/docs/skills/`
- **Testing**: vitest
- **Package Manager**: pnpm
- **Release**: semantic-release on push to master (GitHub releases only, no npm)

## Commands
- `pnpm dev` — start dev server via PM2 on port 1337 (streams logs)
- `pnpm stop` — stop dev server
- `pnpm restart` — restart dev server
- `pnpm logs` — view PM2 logs
- `pnpm build` — production build
- `pnpm start` — start production server via PM2
- `pnpm test` — run tests
- `pnpm type-check` — TypeScript check

**Never run `next dev` directly — always use PM2 via the scripts above.**

## Architecture
- `app/` — Next.js pages and API route handlers
- `components/` — React client components
- `hooks/` — Custom React hooks
- `lib/` — Server-side business logic
- `lib/db/` — Drizzle schema and connection (tables: settings, projects, jobs, ghStatus, skills, agents)
- `skills/` — claude-skills submodule
- `data/` — SQLite database (gitignored)
- `__tests__/` — vitest tests

## Pages
- `/` — Projects list with status, changes, CI
- `/project/[name]` — Project overview with agents, status bar (changes/review/tests)
- `/project/[name]/config` — Test command + custom actions editor (name, command, color)
- `/project/[name]/logs` — Project runs with filter tabs (all/running/failed/done)
- `/project/[name]/experimental` — Interactive Claude runner with skill picker and SSE streaming
- `/jobs` — All runs across projects
- `/skills` — Skill editor (CRUD for DB-backed skills)
- `/settings` — Workspace path, frequency, claude binary, DB backup

## API Routes
- `/api/agents` — CRUD for agents (GET, POST)
- `/api/agents/[agentId]` — Agent detail (GET, PATCH, DELETE)
- `/api/agents/[agentId]/run` — Run agent (POST) — composes skills into prompt
- `/api/skills` — CRUD for skills (GET, POST)
- `/api/skills/[skillId]` — Skill detail (GET, PATCH, DELETE)
- `/api/projects/personas` — File-based skills from `skills/docs/skills/` (GET)
- `/api/projects/by-project/[name]/action` — Custom actions (GET, PUT, POST)
- `/api/projects/by-project/[name]/run` — Run Claude on project (POST)
- `/api/streaming/[jobId]` — SSE log stream (reads log path from DB)
- `/api/settings/backup` — SQLite hot backup (POST)

## Key Patterns
- All config stored in DB (`settings`, `projects`, `skills`, `agents` tables)
- Workspace path configured in Settings UI, projects discovered by scanning for git repos
- All CLI calls (git, gh, launchctl, pm2) go through `lib/shell.ts`
- `lib/project-data.ts` assembles project data with 10s TTL cache
- SSE at `/api/streaming/[jobId]` for real-time run output (reads log path from jobs DB)
- Agent runs compose skill content into the prompt before sending to Claude CLI
- File-based skills scanned from `skills/docs/skills/` (all categories, SKILL.md files with frontmatter)
- DB-backed skills created via `/skills` page or API
- Optional auth via `Z_API_TOKEN` env var (Bearer token)
- GitHub owner fallback configurable via `GITHUB_OWNER` env var or Settings UI
- Dependabot with grouped PRs (production deps, dev deps, actions)
