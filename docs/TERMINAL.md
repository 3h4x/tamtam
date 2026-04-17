# Terminal Tab — How It Works

The terminal tab is an interactive Claude terminal. It runs Claude CLI on the project and streams output back in real time, supporting multi-turn conversations via session resumption. Each session gets a persistent URL (`/project/[name]/terminal/[sessionId]`) that restores the conversation and its skill/doc selections.

## Request flow

```
User types → handleSubmit()
  → POST /api/projects/by-project/[name]/run
      → createJob(project, 'run', ..., contextMeta)
      → PM2 spawns: claude --print --output-format stream-json --include-partial-messages --verbose --model {model}
      → Claude writes NDJSON to ~/logs/<jobId>.log as tokens are generated
      → returns { job_id }
  → startStreaming(job_id)
      → EventSource /api/streaming/[jobId]
          → reads log file, fs.watch for new content
          → parseStreamLines() → text/tool_use/tool_result/done events
          → SSE to browser
  → on 'done' SSE event → metadata.sessionId saved to claudeSessionId state
                        → URL updated to /project/[name]/terminal/[sessionId] via router.replace()
```

## Claude CLI stream-json format

The `--output-format stream-json --include-partial-messages --verbose` flags produce NDJSON.

Text tokens: `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}`
Tool use: `content_block_start` with `tool_use` type, input assembled from `input_json_delta` deltas
Tool results: `{"type":"system","subtype":"tool_result","content":"output here"}`
Completion: `{"type":"result","subtype":"success","is_error":false,"duration_ms":2393,"session_id":"abc-123","modelUsage":{...}}`
Ignored: `system` init/hooks/status, `assistant`, `rate_limit_event`, `message_start/delta/stop`.

## NDJSON parser

`lib/claude-stream-parser.ts` — `parseStreamLines(content: string): ParsedEvent[]`
Types: `text` | `tool_use` (name, input) | `tool_result` (content) | `done` (result with duration, sessionId, tokens)
Takes one or more NDJSON lines as a string. Silently skips malformed or irrelevant lines.

## SSE streaming endpoint

`GET /api/streaming/[jobId]`

- Replays existing log file content on connect (late-joiners get full output)
- `fs.watch` pushes new content as it arrives
- `?raw=1` forwards raw NDJSON lines without parsing (used by agent runs)
- SSE: default event = text chunk; named event `"done"` = completion metadata

## Session URLs

Each session gets a stable URL: `/project/[name]/terminal/[sessionId]` where `sessionId` is the Claude session ID returned in the `done` event.

- New session: starts at `/project/[name]/terminal`, URL updates automatically after the first response
- Returning to a session: navigate to the URL — skill/doc selections and terminal history are restored from DB
- `contextMeta`: JSON blob `{ skills: SkillItem[], docs: DocItem[] }` stored on the job row at creation time; read back on restore
- Route: `app/project/[name]/terminal/[sessionId]/page.tsx` → same `ProjectDetailPage`, `initialSessionId` prop threaded to `TerminalTab`

## Session continuity (multi-turn)

When `claudeSessionId` is set, follow-up messages pass `resumeSessionId` to the run API → server adds `--resume <sessionId>`.
Skills, docs, and persona injection are skipped on follow-ups — context already lives in the session.

## Job storage

- All runs stored in `jobs` table with `kind='run'`
- `markDone()` parses the log for the `result` NDJSON event, writes `sessionId` + token counts + duration to DB
- `contextMeta` (text column): written once at job creation with selected skills/docs; never updated
- `saveToDb()` uses `INSERT ... ON CONFLICT DO UPDATE` — update set includes `sessionId` and `contextMeta`

## Previous sessions panel

1. Fetches `GET /api/jobs?project=<name>`, filters `kind==='run'`, sorted newest-first, max 100
2. `restoreSession()`: still running → reconnects SSE; finished → reads `data.log`, reconstructs history, sets `claudeSessionId`

## Skill, docs, and persona injection (first message only)

- DB skills (source `'db'`): content prepended as `## Name` + content + `---`
- File-based personas (source `'file'`): path passed as `personas[]` to run API, which reads `.md` file from `skills/docs/skills/`
- Project docs (source `'docs'`): content from `{projectPath}/docs/*.md` via `GET /api/projects/by-project/[name]/docs`
- Skill usage counts stored in `localStorage` under `tamtam-skill-usage`

## Model selection

Model picker (haiku/sonnet/opus) persists via `PATCH /api/settings` (`default_model`). On mount reads current `default_model`.

## Typewriter animation

Streamed text → `streamBuffer`. `requestAnimationFrame` loop advances `displayedLength` at ~800 chars/sec.
On completion: full buffer committed to `history`, stream state cleared.

## Why PM2

PM2 survives Next.js restarts. Log at `~/logs/{jobId}.log` is a durable buffer — SSE endpoint can reconnect and replay.

## Key files

| File | Role |
|------|------|
| `components/TerminalTab.tsx` | UI, session state, SSE client, skill/docs/persona picker, session URL nav |
| `app/project/[name]/terminal/[sessionId]/page.tsx` | Session-specific route, delegates to `ProjectDetailPage` |
| `app/api/projects/by-project/[name]/run/route.ts` | Starts Claude CLI via PM2, creates job, stores `contextMeta` |
| `app/api/projects/by-project/[name]/docs/route.ts` | Lists `docs/*.md` files for docs picker |
| `app/api/streaming/[jobId]/route.ts` | SSE endpoint, tails log file |
| `lib/claude-stream-parser.ts` | Parses NDJSON lines into typed events |
| `lib/job-storage.ts` | Job CRUD, `markDone()` extracts sessionId from log |
| `lib/pm2-jobs.ts` | PM2 process lifecycle |

## Tests

- Unit: `__tests__/lib/claude-stream-parser.test.ts` — parser tests
- Unit: `__tests__/api/project-docs.test.ts` — docs route tests
- E2E: `e2e/terminal-streaming.spec.ts` — Playwright tests (requires dev server on `localhost:1337`)
- `pnpm test` — unit tests; `pnpm test:e2e` — e2e
