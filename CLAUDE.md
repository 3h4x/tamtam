# TamTam — Project Management Dashboard

Next.js monolith (App Router) for managing scheduled Claude CLI agents across multiple projects.

## Tech Stack
- **Framework**: Next.js 16 (App Router) — both frontend and backend
- **Database**: Drizzle ORM + better-sqlite3, WAL mode, DB at `data/tamtam.db` (gitignored)
- **Streaming**: SSE via route handlers (no WebSocket)
- **Styling**: Tailwind CSS v4
- **Skills**: `skills/` submodule (claude-skills) for personas and review prompts
- **Testing**: vitest
- **Package Manager**: pnpm

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
- `lib/db/` — Drizzle schema and connection
- `skills/` — claude-skills submodule (personas, review prompts)
- `data/` — SQLite database (gitignored)
- `__tests__/` — vitest tests

## Key Patterns
- All config is stored in DB (`settings` and `projects` tables) — no external config files
- Workspace path configured in Settings UI, projects discovered by scanning for git repos
- All CLI calls (git, gh, launchctl, pm2) go through `lib/shell.ts`
- `lib/project-data.ts` assembles all project data with 10s TTL cache
- SSE at `/api/streaming/[jobId]` for real-time logs
- Optional auth via `Z_API_TOKEN` env var (Bearer token)
- GitHub owner fallback configurable via `GITHUB_OWNER` env var or Settings UI
