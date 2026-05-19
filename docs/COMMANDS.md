# Commands

## Server lifecycle

- `pnpm start` — start (or idempotently restart) production server via PM2 on port 1337. Self-heals if a previous orphan is squatting on the port. Canonical way to run TamTam.
- `pnpm run rebuild` — graceful build + PM2 restart via `scripts/rebuild-safe.sh`: pause new jobs, wait for active pipeline/agent/run jobs to drain, build, restart, smoke-probe critical pages, then unpause. If the smoke probe fails after restart, the script removes `.next/`, rebuilds cleanly, restarts again, and only unpauses after the probe passes. On build failure, jobs are unpaused and the existing server is left running; on restart or smoke-recovery failure, jobs remain paused for manual recovery. **Canonical post-edit command.**
- `pnpm run rebuild:force` — skip pause/drain and rebuild immediately. Use only when the server is already dead or active work can be interrupted.
- `pnpm restart` — legacy immediate build then PM2 restart via `pnpm build && bash scripts/pm2-start.sh`; does not perform the graceful drain. Note: bare `pnpm rebuild` triggers pnpm's native-deps rebuild instead — always use `pnpm run rebuild`.
- `pnpm stop` — stop the PM2 server.
- `pnpm logs` — view PM2 logs.
- `ecosystem.config.js` — PM2 compatibility config for operators that use ecosystem files. It mirrors the production `next start` target; `pnpm start` / `scripts/pm2-start.sh` remains the canonical lifecycle because it also handles orphaned port cleanup and legacy PM2 entries.
- `pnpm build` — production build. Runs `prebuild` first, which regenerates `public/workflow-graph.svg` from `lib/workflows/pipeline-spec.ts` when Chrome/Chromium is available. If no browser is available but the committed SVG already exists, the generator keeps the existing SVG and lets the build continue.
- `pnpm gen:workflow-graph` — manually regenerate the release pipeline SVG after editing `lib/workflows/pipeline-spec.ts`. Set `PUPPETEER_EXECUTABLE_PATH` to a Chrome/Chromium binary when the system browser is not in a standard location.
- `pnpm dev` — `next dev` foreground on port 1337 (HMR enabled, no PM2). Local debugging only. Never use as the long-lived server (HMR watchers can restart mid-operation, orphaning in-flight jobs).
- `pnpm dev:qa` — deterministic Docker QA environment on port 1338 with mocked `git`/`gh`/`pm2`/provider shims and an isolated DB/workspace. Runs `next dev` inside the container with the repo bind-mounted, so source edits are picked up without rebuilding. Use when you need a reproducible browser or API target without touching the main PM2 server.
- `pnpm dev:profile` / `pnpm dev:flamegraph` — Turbopack tracing / V8 CPU profiling. **Disruptive**: tears down current TamTam and clears port 1337. See `docs/PROFILING.md`.

TamTam runs in **production mode** (`next start`) under PM2 — no HMR. After any code change, run `pnpm run rebuild`. If you genuinely need HMR, `pnpm stop` first.

## Tests + lint

- `pnpm test` / `pnpm test:watch` — vitest unit tests. Always use the package script, not `vitest` directly, so global setup runs.
- `pnpm test:e2e` — Playwright e2e (requires dev server on port 1337).
- `pnpm test:e2e:pipeline` — pipeline e2e on port 1338 against a temp Postgres database. See `docs/E2E.md`.
- `pnpm lint` / `pnpm type-check` / `pnpm check` — ESLint / `tsc --noEmit` / lint+type-check+test.
- `pnpm lint` only covers `app`, `components`, `lib`, `hooks`. Don't assume it has checked `scripts/`, `__tests__/`, `e2e/`, or repo config files.

## Database

- `pnpm db:generate` / `pnpm db:migrate` — Drizzle migrations. Always pair `lib/db/schema.ts` edits with both. Never edit migration files by hand or delete them.

## MCP

- `pnpm mcp:http <tool> [json_args]` — call local TamTam HTTP endpoints via the sibling `mcp-http-tools` checkout (`.tamtam/mcp-http-tools.yaml`). Prefer `tamtam_api_get` for path-only GET routes, e.g. `pnpm mcp:http tamtam_api_get '{"path":"jobs/notifications"}'`.
