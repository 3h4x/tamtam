# Streaming — How It Works

TamTam's streamed runs share the same infrastructure: the Next.js server spawns the provider CLI as a detached child process, the child writes output to a log file, and an SSE endpoint tails that file to the browser. For provider-backed runs, TamTam uses a Claude-compatible `stream-json` contract: the native Claude CLI emits that NDJSON directly, while Gemini, Codex, LM Studio, and compatible custom backends are normalized to the same shape by the bundled shims.

## When to read this

- Terminal tab shows blank output or stops mid-stream
- Implementing a new job kind that needs real-time output
- Debugging SSE disconnects or reconnect behavior
- Understanding how multi-turn terminal sessions are stored and restored
- Integrating with the `/api/streaming/[jobId]` endpoint from external tools

---

## Common job lifecycle

```
API route (any kind)
  → createJob(project, kind, ...)       — insert into jobs table, status='running'
  → startJobInProcess (lib/jobs/spawn-claude-detached.ts)
      → spawn(bin, args, { stdio: ['pipe', logFd, logFd], detached: true })
      → child.unref()                   — detach from parent's event loop
      → child writes NDJSON to ./data/logs/<jobId>.log (or custom logPath)
  → returns { job_id }

Client
  → EventSource /api/streaming/[jobId]
      → replays existing log content on connect
      → fs.watch + 1s poll for new content
      → parseStreamLines() → SSE events to browser
      → on 'done' event → mark job seen, update UI

child.on('exit') in parent
  → markDone(jobId, exitCode)           — writes finishedAt, exitCode to DB
  → completion hook runs (pipeline chain, notifications, etc.)
```

**Surviving Next.js restarts.** PM2 only supervises the `tamtam` Next.js server itself — there is no per-job PM2 entry. Jobs survive a `pnpm run rebuild` / PM2 restart of tamtam because:

1. `detached: true` + `child.unref()` puts the child in its own process group, so SIGTERM to the parent does not propagate.
2. `stdio: ['pipe', logFd, logFd]` redirects child stdout/stderr **directly to the log file's fd**. If the child's stdout were piped back through Node (the historical bug), the pipe would break when the parent dies and the next CLI write would get `SIGPIPE` — killing the child despite the detached process group. Writing to the kernel-held fd means the child's own dup'd handle survives the parent disappearing.
3. The prompt is fed via stdin pipe and stdin closes within a few ms; by the time a PM2 restart could fire, stdin is long done, so remaining pipe breakage is harmless.
4. When the parent does die mid-run, the in-process `child.on('exit')` handler is lost — so `markDone` doesn't fire from this path. On next boot, `probeJobStatus` recovers state: `process.kill(pid, 0)` checks liveness, and once the child exits, `getClaudeResultExitCode` parses the trailing `"type":"result"` line in the log to derive tokens / cost / exit code without ever needing the in-parent exit handler.

The log file is a durable buffer for the browser too: the terminal can reconstruct the current turn from `./data/logs/<jobId>.log` even if SSE drops mid-stream.

---

## SSE endpoint — `GET /api/streaming/[jobId]`

`app/api/streaming/[jobId]/route.ts`

- On connect: reads full log file, sends existing content, records byte offset
- `fs.watch` on the log file pushes new bytes as they arrive; 1s poll as fallback (override with `TAMTAM_STREAM_POLL_MS` env var — read once at module load; tests use a small value to exercise the poll path without the 1s wait)
- When `job.finishedAt` is set: flushes remaining content, emits `done`, closes
- **`?raw=1`**: forwards raw NDJSON lines unparsed (used by agent runs)
- **Default (parsed)**: runs content through `parseStreamLines()`, emits typed SSE events

SSE event types (parsed mode):

| SSE event name | Payload |
|----------------|---------|
| *(default)* | text chunk string |
| `thinking` | thinking text string |
| `tool_use` | `{ name, input }` JSON |
| `tool_result` | `{ content }` JSON |
| `done` | `{ exitCode, detail? }` JSON — or the provider `result` object if stream-json |

On non-zero exit, `done` includes a `detail` field with a human-readable diagnosis extracted from the log (e.g. "log file empty — rate-limited", "wrappers only — claude exited immediately").

---

## Claude-compatible stream-json format

TamTam's shims normalize supported providers to the same NDJSON contract produced by Claude CLI `--output-format stream-json --include-partial-messages --verbose`.

```
Text token:   {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
Tool use:     content_block_start with tool_use type; input assembled from input_json_delta deltas
Tool result:  {"type":"system","subtype":"tool_result","content":"output here"}
Completion:   {"type":"result","subtype":"success","is_error":false,"duration_ms":2393,"session_id":"abc-123","modelUsage":{...}}
Ignored:      system init/hooks/status, assistant, rate_limit_event, message_start/delta/stop
```

---

## NDJSON parser

`lib/jobs/claude-stream-parser.ts` — `parseStreamLines(content: string): ParsedEvent[]`

Types: `text` | `thinking` | `tool_use` (name, input) | `tool_result` (content) | `done` (result with duration, sessionId, tokens)

Takes one or more NDJSON lines as a string. Silently skips malformed or irrelevant lines.

---

## Terminal tab (interactive, multi-turn)

The terminal tab is the interactive case: user types, the selected provider responds, and the session persists across turns.

### Request flow

```
User types → handleSubmit()
  → POST /api/projects/by-project/[name]/run
      → createJob(project, 'run', ..., contextMeta)
      → if resumeSessionId: pre-seed job.sessionId so the row links back to
        the session even if the run is killed before the CLI emits its
        `result` event (recovery aid; CLI's emitted id overrides on success).
      → startJobInProcess (lib/jobs/spawn-claude-detached.ts) spawns:
        {selected-provider-shim} --print --output-format stream-json --include-partial-messages --verbose --model {model} [--resume <sessionId>]
      → returns { job_id }
  → startStreaming(job_id)
      → EventSource /api/streaming/[jobId]
  → on 'done' SSE event → sessionId saved to claudeSessionId state
                        → URL updated to /project/[name]/terminal/[sessionId] via router.replace()
```

If a blocking job (release/fix/etc.) is running, the run route returns `202 { status: 'queued', queueId, ... }` instead of a `job_id`. `useHandleSubmit` then shows a muted `status` line and hands the `queueId` to `TerminalTab`, which polls `GET /api/projects/by-project/[name]/queued-runs/[queueId]` until `status: 'started'` and calls `terminalStore.startStream(project, jobId)` — the same attach path as a fresh run. The queue is DB-backed and drains FIFO ahead of queued agents; see `lib/terminal/pending-terminal-run.ts` and the `queued_terminal_runs` table.

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

Opt-in: the panel is **closed by default** (the toolbar `recent` toggle opens it), so the terminal lands directly on the "start a terminal chat" empty state instead of a wall of past runs.

1. `GET /api/jobs?project=<name>&has_session=1` → keep restorable-kind rows (`run` / `review` / `fix` / `fix-ci` / `agent:*`) **that have an actual prompt**, grouped by `session_id`, newest-first, max 10. Rows with no user-facing prompt (pipeline steps, composed agent turns) are dropped — restoring them shows an empty conversation and they buried the real sessions.
2. `restoreSession()`: still running → reconnect SSE; finished → read log, reconstruct history, set `claudeSessionId`. Restore still accepts the broad restorable-kind set so a deep-linked review/fix session rebuilds its full transcript.

### Typewriter animation

Streamed text → `streamBuffer`. `requestAnimationFrame` loop advances `displayedLength` at ~800 chars/sec. On completion: full buffer committed to `history`, stream state cleared.

The finalized stream buffer is committed with the `assistant` role **regardless of exit code** (`finalizeStream` in `lib/terminal/terminal-session-store.ts`). A non-zero exit does not colour the content as an error, because Claude CLI is frequently SIGKILLed by pm2's timeout *after* emitting its final result — a clean finish that `markDone` rewrites to exit 0. Run status is conveyed by a separate `terminalExitEntry`, and that marker itself mirrors the `markDone` is-error heuristic client-side: a non-zero exit that follows a clean stream-json result renders as "exit 0 — ok", not a red "exit -1". Only a genuine failure (plain-text fallback / cancellation) keeps the error styling.

### Transport recovery during rebuilds

The terminal does not treat a transient SSE disconnect as a failed provider run.

- `EventSource.onerror` closes the broken socket but keeps the session live
- the client probes `GET /api/jobs/[jobId]` and rebuilds the in-flight turn from the persisted log
- for passthrough jobs such as `release`, the recovery path replays the mixed raw/NDJSON log through the same parser used by `/api/streaming/[jobId]?passthrough=1`, so shell output stays monospace while provider-backed sections still render as assistant/tool/thinking entries
- while the job is still running, the terminal polls job state instead of reopening SSE from byte 0 (which would duplicate already-rendered output)
- once the job finishes, the client finalizes the transcript from the recovered job payload

This is specifically to survive `pnpm run rebuild` / PM2 restarts of the tamtam server without injecting `Connection error` or provider-failure lines into an otherwise healthy terminal session. The CLI subprocess itself continues running across the restart (see "Surviving Next.js restarts" above); the client just has to re-attach to its log on reconnect.

### Model selection

Model picker (Fast / Normal / Smart) persists via `PATCH /api/settings` (`default_model`). Legacy `haiku` / `sonnet` / `opus` values are still accepted and normalized on read.

---

## Non-terminal job streaming (review, fix, test, push)

Review and fix jobs also use the provider-backed `stream-json` path, while shell-oriented jobs such as test and push write plain text (or mixed) output to the log. The SSE endpoint works the same way; clients either use `?raw=1` when they need the original log stream or consume the parsed text/tool events.

The pipeline chain in `lib/jobs/job-storage.ts` completion hooks reads job output via the log file directly (not SSE) using `getJobLog()` — SSE is only for browser clients.

Verdict detection (`getVerdict`) reads the **last 2000 chars** of the parsed log and looks for `Verdict: X` or a bare token on the final line.

---

## Job storage

- All runs in `jobs` table; `kind` distinguishes `run` / `review` / `fix` / `test` / `push` / `release` / `pr-wait` / …
- `markDone(jobId, exitCode)`: sets `finishedAt`, `exitCode`; for `kind='run'` also extracts `sessionId` + token counts from the `result` NDJSON line
- `contextMeta` (text column): written at job creation with selected skills/docs; a few phases update it afterwards (e.g. `pr-wait` stamps `prWaitReason` so the inbox can explain a deferred merge)
- `saveToDb()` uses `INSERT ... ON CONFLICT DO UPDATE`
- **`markDone` and `updateJob` both `jobsCache.set(job.id, job)`** so the in-memory cache stays in sync with the DB write. Without it, a phase that finalizes inside the workflow runtime on a job object that is *not* the cached reference (e.g. `pr-wait`) persists to Postgres but leaves `listJobs()` serving a stale row with `finishedAt: null` — which silently broke inbox signals derived from finished state.

---

## Key files

| File | Role |
|------|------|
| `app/api/streaming/[jobId]/route.ts` | SSE endpoint, tails log file, emits typed events |
| `lib/jobs/claude-stream-parser.ts` | Parses NDJSON lines into typed events |
| `lib/jobs/job-storage.ts` | Job CRUD, `markDone()`, completion hooks, verdict detection |
| `lib/jobs/spawn-claude-detached.ts` | In-process detached child spawn, exit handler → `markDone` |
| `components/TerminalTab.tsx` | Terminal UI, SSE client, skill/docs/persona picker, session URL nav |
| `app/project/[name]/terminal/[sessionId]/page.tsx` | Session-specific route |
| `app/api/projects/by-project/[name]/run/route.ts` | Starts the selected provider in-process, stores `contextMeta` |
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
| Raw NDJSON | `/api/streaming/[jobId]?raw=1` | Agent runs — full NDJSON lines unparsed |

### Job kind → streaming mode

| Kind | Format | Client parses |
|------|--------|---------------|
| `run` | `stream-json` NDJSON | text, thinking, tool_use, tool_result, done |
| `review`, `fix` | `stream-json` NDJSON | text, thinking, tool_use, tool_result, done |
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

# Re-probe and inspect the persisted job state
curl http://localhost:1337/api/jobs/<jobId>

# Replay full stream from offset 0
curl -N http://localhost:1337/api/streaming/<jobId>
```

---

## Testing the Terminal — Practical Guide

Use Playwright MCP (`mcp__playwright__*` / Playwright MCP tools) to verify terminal behavior. This section covers the observable UI states and how to reach each one.

### URL patterns

| State | URL | How to reach it |
|-------|-----|-----------------|
| New/blank session | `/project/[name]/terminal` | Click Terminal tab |
| Completed session | `/project/[name]/terminal/[sessionId]` | Click entry in History; auto-set after first response completes |
| Running job (live) | `/project/[name]/terminal?job=[jobId]` | Click a running entry in History tab |

The `?job=` param is used during live streaming because the session ID isn't known until the provider emits the `result` line. After the session finishes, the URL stabilises to `/terminal/[sessionId]`.

### Session states and input placeholder

| Placeholder text | Bottom label | Live badge | State |
|------------------|-------------|-----------|-------|
| `type a message...` | `no session` | — | New, nothing loaded |
| `follow-up...` | `session [truncated-id]` | — | Completed session loaded |
| `queue a message... (Esc cancels)` | `no session` | `● live` | Claude is actively running |

### Switching sessions

**Via the "recent" panel (Terminal tab):**
1. The panel opens with up to 10 most recent sessions (green dots = done, orange = still running); click **recent** to hide or show it again
2. Click any entry → session loads; URL changes to `/terminal/[sessionId]` or `?job=[jobId]`
3. Click **close** to dismiss the panel without switching

**Via the History tab:**
1. Navigate to `/project/[name]/history`
2. Any row in the list is clickable — it navigates to Terminal and loads that job
3. Running rows (yellow left border, `● running` badge) open with the live `● live` indicator active
4. Completed rows restore the full conversation from the log

### Toolbar controls

```
[ session: new recent ● live trace ]   [ thinking ] [ attach: skills 2 docs 1 ] [ model: Fast Normal Smart ]
```

- **new** — clears the terminal and starts a fresh session (prompt: `type a message...`)
- **recent** — opens the session picker dropdown
- **● live** — appears only while a job is actively streaming
- **thinking** — toggles visibility of Claude's `<thinking>` blocks
- **skills N / docs N** — live inside the `attach` group. They open the skill and docs pickers and show the current selection counts. Selected items also appear as removable pills in a separate `selected` row when anything is attached. Skills and docs are injected only on the *first* message of a new session.
- **model buttons** — Fast / Normal / Smart are direct buttons, not a dropdown. The selection persists to `default_model`, with legacy Claude-family aliases still readable.
- **trace ↗** — appears only during an active release pipeline run; links to `/project/[name]/release/[releaseId]` trace view showing per-step verdicts and log excerpts
- **abort** — appears only while a real release job is running; it calls the release abort route to stop the locked release and its current child step. Standalone test/review/fix strips do not show it.

### Content rendering

**User prompts** — displayed as a monospace block with `# ` prefix. A **copy** button appears on hover.

**Claude text** — markdown rendered inline: bold, inline code highlighted in teal/syntax color, list items, etc.

**Tool calls** — indented block with `Tool: [ToolName]` header, tool input and output shown below. During live streaming, tool calls show as collapsed single-line rows (`tool_name ›`) until the result arrives.

**Thinking blocks** — hidden by default; toggle with the **thinking** button.

**Raw / passthrough output** — shell-heavy or release-style logs render in a dark monospace pane. Live raw buffers use a `raw output` badge plus a `live log` eyebrow; raw assistant passthrough streams use a `raw` badge plus a `passthrough` eyebrow. Individual lines are classified with badges such as `cmd`, `meta`, `ok`, `warn`, and `err`, and multiline ANSI colors are preserved across newline boundaries.

**Live run status** — while a run is active, a dedicated `live run` panel shows elapsed time, the latest streamed line or pending tool name, idle/waiting state, and the inline `cancel` action.

**Context compaction** — when Claude compacts its context window, a `[context compacted]` marker appears inline in the conversation.

### "↓ latest" button

A floating **↓ latest** button appears in the bottom-right whenever you have scrolled above the most recent content. Clicking it jumps to the end of the stream. During live streaming this is the primary way to follow new output after manually scrolling up to inspect earlier content.

### Following a live stream step-by-step

1. Start a run (submit a prompt or click "Run" on an agent)
2. Terminal shows `● live` badge; input shows `queue a message...`
3. Content streams in: text appears via the typewriter animation (~800 chars/sec), tool calls arrive as collapsed rows
4. Scroll up freely — **↓ latest** keeps you able to jump back
5. When Claude finishes: `● live` disappears, URL updates to `/terminal/[sessionId]`, placeholder switches to `follow-up...`

### History tab — what you can verify

| Element | How to check |
|---------|-------------|
| Filter tabs | Click `running`, `failed`, `chat`, etc. — list re-filters immediately |
| Release pipeline steps | Click `▸` expand button on a release row — sub-steps appear with verdicts |
| Session metadata | Each chat row shows: turns, model, `#sessionId` prefix, token/cost stats |
| Status badges | `● running` (orange), `● done` (green), `● exit N` (red) — verify colors match exit code |
| Agent runs | Shown with `agent` kind badge; clicking opens the terminal for that job |

### Common test scenarios

**Verify a completed multi-turn session loads correctly:**
1. Go to History, find a `chat` entry with N turns
2. Click it → Terminal opens; scroll to top; verify user/assistant turns alternate correctly
3. Confirm session ID in bottom-left matches `#[id]` shown in History row

**Verify live streaming works:**
1. Submit a prompt that will take >10 seconds (e.g. a Bash command)
2. Confirm `● live` badge appears within 1-2 seconds
3. Confirm text starts appearing with typewriter effect
4. Confirm `↓ latest` appears if you scroll up during streaming
5. Confirm `● live` disappears and URL updates after completion

**Verify session switching doesn't corrupt state:**
1. Open session A (note its first line of text)
2. Open "recent" panel, switch to session B
3. Switch back to session A — verify text is identical to step 1

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Terminal shows nothing after submit | Detached child did not write output; log file empty | Check `/api/jobs/<jobId>` and the raw log; look for "rate-limited" in done event `detail` |
| Stream stops mid-response | Claude rate limited or crashed | Check log file; `done` event `detail` has diagnosis |
| Session history not restored on navigate | `sessionId` not saved (job didn't emit `result` line) | Job may have crashed before completion; check exit code |
| `tool_use` events missing in terminal | Using `?raw=1` by mistake | Use default (parsed) mode for terminal UI |
| SSE reconnects immediately and replays | `finishedAt` already set in DB | Normal — endpoint flushes remaining content then closes |
| Multi-turn follow-up re-injects skills | `resumeSessionId` not passed | Ensure `resumeSessionId` is set on follow-up requests |
