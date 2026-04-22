# Streaming — How It Works

All Claude runs (terminal, review, fix, test, push) share the same streaming infrastructure: PM2 spawns the process, writes NDJSON to a log file, and an SSE endpoint tails that file to the browser.

## When to read this

- Terminal tab shows blank output or stops mid-stream
- Implementing a new job kind that needs real-time output
- Debugging SSE disconnects or reconnect behavior
- Understanding how multi-turn terminal sessions are stored and restored
- Integrating with the `/api/streaming/[jobId]` endpoint from external tools

---

---

## Common job lifecycle

```
API route (any kind)
  → createJob(project, kind, ...)       — insert into jobs table, status='running'
  → PM2 spawns process                  — writes NDJSON to ./data/logs/<jobId>.log (or custom logPath)
  → returns { job_id }

Client
  → EventSource /api/streaming/[jobId]
      → replays existing log content on connect
      → fs.watch + 1s poll for new content
      → parseStreamLines() → SSE events to browser
      → on 'done' event → mark job seen, update UI

PM2 exit handler
  → markDone(jobId, exitCode)           — writes finishedAt, exitCode to DB
  → completion hook runs (pipeline chain, notifications, etc.)
```

**Why PM2?** It survives Next.js restarts. The log file is a durable buffer — SSE can reconnect and replay from offset 0 at any time.

---

## SSE endpoint — `GET /api/streaming/[jobId]`

`app/api/streaming/[jobId]/route.ts`

- On connect: reads full log file, sends existing content, records byte offset
- `fs.watch` on the log file pushes new bytes as they arrive; 1s poll as fallback
- When `job.finishedAt` is set: flushes remaining content, emits `done`, closes
- **`?raw=1`**: forwards raw NDJSON lines unparsed (used by agent runs and `start-fix-push.ts`)
- **Default (parsed)**: runs content through `parseStreamLines()`, emits typed SSE events

SSE event types (parsed mode):

| SSE event name | Payload |
|----------------|---------|
| *(default)* | text chunk string |
| `thinking` | thinking text string |
| `tool_use` | `{ name, input }` JSON |
| `tool_result` | `{ content }` JSON |
| `done` | `{ exitCode, detail? }` JSON — or the Claude `result` object if stream-json |

On non-zero exit, `done` includes a `detail` field with a human-readable diagnosis extracted from the log (e.g. "log file empty — rate-limited", "wrappers only — claude exited immediately").

---

## Claude CLI stream-json format

The `--output-format stream-json --include-partial-messages --verbose` flags produce NDJSON.

```
Text token:   {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
Tool use:     content_block_start with tool_use type; input assembled from input_json_delta deltas
Tool result:  {"type":"system","subtype":"tool_result","content":"output here"}
Completion:   {"type":"result","subtype":"success","is_error":false,"duration_ms":2393,"session_id":"abc-123","modelUsage":{...}}
Ignored:      system init/hooks/status, assistant, rate_limit_event, message_start/delta/stop
```

---

## NDJSON parser

`lib/claude-stream-parser.ts` — `parseStreamLines(content: string): ParsedEvent[]`

Types: `text` | `thinking` | `tool_use` (name, input) | `tool_result` (content) | `done` (result with duration, sessionId, tokens)

Takes one or more NDJSON lines as a string. Silently skips malformed or irrelevant lines.

---

## Terminal tab (interactive, multi-turn)

The terminal tab is the interactive case: user types, Claude responds, session persists across turns.

### Request flow

```
User types → handleSubmit()
  → POST /api/projects/by-project/[name]/run
      → createJob(project, 'run', ..., contextMeta)
      → PM2 spawns: claude --print --output-format stream-json --include-partial-messages --verbose --model {model}
      → returns { job_id }
  → startStreaming(job_id)
      → EventSource /api/streaming/[jobId]
  → on 'done' SSE event → sessionId saved to claudeSessionId state
                        → URL updated to /project/[name]/terminal/[sessionId] via router.replace()
```

### Session URLs

Each session gets a stable URL: `/project/[name]/terminal/[sessionId]`

- New session starts at `/project/[name]/terminal`; URL updates after first response
- Returning: navigate to URL — skill/doc selections and terminal history restored from DB
- `contextMeta`: JSON blob `{ skills: SkillItem[], docs: DocItem[] }` stored on job row at creation, read back on restore

### Session continuity (multi-turn)

Follow-up messages pass `resumeSessionId` → server adds `--resume <sessionId>`. Skills, docs, and persona injection are skipped on follow-ups — context already lives in the session.

### Skill, docs, and persona injection (first message only)

- DB skills (`source='db'`): content prepended as `## Name` + content + `---`
- File-based personas (`source='file'`): path passed as `personas[]`, server reads `.md` from `skills/docs/skills/`
- Project docs (`source='docs'`): content from `{projectPath}/docs/*.md` via `GET /api/projects/by-project/[name]/docs`
- Skill usage counts stored in `localStorage` under `tamtam-skill-usage`

### Previous sessions panel

1. `GET /api/jobs?project=<name>` → filter `kind==='run'`, sorted newest-first, max 100
2. `restoreSession()`: still running → reconnect SSE; finished → read log, reconstruct history, set `claudeSessionId`

### Typewriter animation

Streamed text → `streamBuffer`. `requestAnimationFrame` loop advances `displayedLength` at ~800 chars/sec. On completion: full buffer committed to `history`, stream state cleared.

### Model selection

Model picker (haiku/sonnet/opus) persists via `PATCH /api/settings` (`default_model`). On mount reads current setting.

---

## Non-terminal job streaming (review, fix, test, push)

These jobs run without `--output-format stream-json` — they write plain text (or mixed) to the log. The SSE endpoint works the same way; clients typically use `?raw=1` or consume the parsed text events and ignore tool events.

The pipeline chain in `lib/job-storage.ts` completion hooks reads job output via the log file directly (not SSE) using `getJobLog()` — SSE is only for browser clients.

Verdict detection (`getVerdict`) reads the **last 2000 chars** of the parsed log and looks for `Verdict: X` or a bare token on the final line.

---

## Job storage

- All runs in `jobs` table; `kind` distinguishes `run` / `review` / `fix` / `test` / `push` / `release`
- `markDone(jobId, exitCode)`: sets `finishedAt`, `exitCode`; for `kind='run'` also extracts `sessionId` + token counts from the `result` NDJSON line
- `contextMeta` (text column): written once at job creation with selected skills/docs; never updated
- `saveToDb()` uses `INSERT ... ON CONFLICT DO UPDATE`

---

## Key files

| File | Role |
|------|------|
| `app/api/streaming/[jobId]/route.ts` | SSE endpoint, tails log file, emits typed events |
| `lib/claude-stream-parser.ts` | Parses NDJSON lines into typed events |
| `lib/job-storage.ts` | Job CRUD, `markDone()`, completion hooks, verdict detection |
| `lib/pm2-jobs.ts` | PM2 process lifecycle, exit handler → `markDone` |
| `components/TerminalTab.tsx` | Terminal UI, SSE client, skill/docs/persona picker, session URL nav |
| `app/project/[name]/terminal/[sessionId]/page.tsx` | Session-specific route |
| `app/api/projects/by-project/[name]/run/route.ts` | Starts Claude CLI via PM2, stores `contextMeta` |
| `app/api/projects/by-project/[name]/docs/route.ts` | Lists `docs/*.md` for docs picker |

---

## Tests

- Unit: `__tests__/lib/claude-stream-parser.test.ts` — parser
- Unit: `__tests__/api/project-docs.test.ts` — docs route
- E2E: `e2e/terminal-streaming.spec.ts` — Playwright (requires dev server on `localhost:1337`)
- `pnpm test` / `pnpm test:e2e`

---

## Quick Reference

### SSE endpoint modes

| Mode | URL | Use case |
|------|-----|----------|
| Parsed (default) | `/api/streaming/[jobId]` | Terminal UI — typed events (text, thinking, tool_use, done) |
| Raw NDJSON | `/api/streaming/[jobId]?raw=1` | Agent runs, fix-push — full NDJSON lines unparsed |

### Job kind → streaming mode

| Kind | Format | Client parses |
|------|--------|---------------|
| `run` | `stream-json` NDJSON | text, thinking, tool_use, tool_result, done |
| `review`, `fix`, `fix-push` | Plain text mixed | Text events + done |
| `test`, `push`, `action` | Plain text | Text events + done |

### Log file locations

```
./data/logs/<jobId>.log          — standard job log (NDJSON or plain text)
./data/logs/agent-scripts/       — agent prompt files
./data/logs/agent-scheduler-<id>.log — scheduled agent output
```

### Diagnose a stuck stream

```bash
# Check if the job is still running
curl http://localhost:1337/api/jobs/<jobId>

# Tail the raw log file
tail -f ./data/logs/<jobId>.log

# Check PM2 process list
pm2 list

# Replay full stream from offset 0
curl -N http://localhost:1337/api/streaming/<jobId>
```

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Terminal shows nothing after submit | PM2 process didn't start; log file empty | Check `pm2 list`; look for "rate-limited" in done event `detail` |
| Stream stops mid-response | Claude rate limited or crashed | Check log file; `done` event `detail` has diagnosis |
| Session history not restored on navigate | `sessionId` not saved (job didn't emit `result` line) | Job may have crashed before completion; check exit code |
| `tool_use` events missing in terminal | Using `?raw=1` by mistake | Use default (parsed) mode for terminal UI |
| SSE reconnects immediately and replays | `finishedAt` already set in DB | Normal — endpoint flushes remaining content then closes |
| Multi-turn follow-up re-injects skills | `resumeSessionId` not passed | Ensure `resumeSessionId` is set on follow-up requests |
