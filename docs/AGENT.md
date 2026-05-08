# Agents — How They Work

Agents are reusable automation units that combine skills, a model, a prompt template, and optional scheduling. Each agent runs Claude CLI with a composed system prompt (skills) and a task prompt, either on-demand or on a recurring schedule.

## When to read this

- Creating a new agent via API or UI
- Debugging why a scheduled agent isn't firing
- Understanding how skills are composed into the system prompt
- Preventing duplicate/concurrent agent runs
- Understanding the internal scheduler and legacy launchctl compatibility

---

## Concepts

- **Agent** — A configuration combining skills, model, and prompt template
- **Scheduled run** — Automatic execution on an interval (e.g., "1h", "30m"), driven by the in-process scheduler for `runner: "pm2"` or by legacy `launchctl` rows
- **On-demand run** — Manual execution triggered via API or UI
- **Skill composition** — Skills are prepended as a system prompt before the task prompt

## Agent Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | `agent-{timestamp}` | Unique identifier |
| `name` | string | required | Display name (e.g., "Daily Tests") |
| `project` | string | required | Project name (must exist in workspace) |
| `skillIds` | string (JSON array) | `[]` | Array of skill IDs to compose as system prompt |
| `model` | string | `normal` | Semantic model tier: `fast`, `normal`, or `smart`. Legacy `haiku`, `sonnet`, and `opus` aliases are still accepted. |
| `prompt` | string | `''` | Default task prompt for scheduled runs |
| `schedule` | string | `null` | Run interval for scheduling: `"30m"`, `"1h"`, `"8h"`, etc. or `null` for manual only |
| `runner` | string | `pm2` | Scheduler mode: `"pm2"` for the internal scheduler, or legacy `"launchctl"` on macOS |
| `enabled` | boolean | `true` | Enable/disable without deletion |
| `provider` | string \| null | `null` | Optional preferred CLI provider (`claude`, `codex`, `gemini`, `lmstudio`). TamTam falls back to the enabled-provider chooser if the preferred provider cannot be used. |
| `createdAt` | number | — | Unix timestamp (seconds) |
| `updatedAt` | number | — | Unix timestamp (seconds) |

## Creating an Agent

### Via UI

1. Navigate to `/agents`
2. Click "New Agent"
3. Fill in name, project, skills, model, prompt, schedule
4. Click "Create"

### Via API

**POST /api/agents**

```bash
curl -X POST http://localhost:1337/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily Code Review",
    "project": "myapp",
    "skillIds": ["skill-123", "skill-456"],
    "model": "normal",
    "prompt": "Review uncommitted changes in the project and suggest improvements",
    "schedule": "24h",
    "runner": "pm2",
    "enabled": true
  }'
```

**Response:**
```json
{
  "agent": {
    "id": "agent-1705276800000",
    "name": "Daily Code Review",
    "project": "myapp",
    "skillIds": "[\"skill-123\", \"skill-456\"]",
    "model": "normal",
    "prompt": "Review uncommitted changes...",
    "schedule": "24h",
    "runner": "pm2",
    "enabled": true,
    "createdAt": 1705276800.5,
    "updatedAt": 1705276800.5
  }
}
```

**Required fields:** `name`, `project`  
**Optional fields:** `skillIds` (default `[]`), `model`, `prompt`, `schedule`, `runner`, `enabled`

If you provide both `schedule` and `prompt`, the agent's schedule is automatically installed.

## Running an Agent

Schedule values are validated on write. Supported formats are positive minute/hour/day intervals such as `15m`, `30m`, `1h`, `4h`, `24h`, `3d`, `7d`, or `30d`.

### On-Demand Run

**POST /api/agents/{agentId}/run**

```bash
curl -X POST http://localhost:1337/api/agents/agent-1705276800000/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Check if all tests pass and report any failures"
  }'
```

The `prompt` field is required for each run — it overrides the agent's default prompt.

Possible responses:

**Started (`200`)**
```json
{
  "status": "started",
  "job_id": "job-1705276900123",
  "pid": 45678,
  "agent": "Weekly Code Review"
}
```

**Queued (`202`)**
```json
{
  "status": "queued",
  "detail": "Agent 'Docs Agent' queued — 'agent:Review Agent' is running for myapp (job myapp-agent:Review Agent-1705276900123)",
  "blockingJobId": "myapp-agent:Review Agent-1705276900123",
  "agent": "Docs Agent"
}
```

When the route is between duplicate-check and `pm2 start`, the response may
still be `202 queued`, but without a `blockingJobId`. In that case the
blocking agent is only "starting" and has not landed its job row yet.

When a release pipeline currently holds the project's pipeline lock, the same
route returns `202 queued` with `code: "pipeline_lock"`. If no release is
currently running but the project still has an older `pending_release` flag,
the route first gives that release a chance to start; if it remains queued, the
agent returns `202 queued` with `code: "pending_release"`. Both cases store the
agent in `queued_agent_runs`, not just memory, so it survives restart and is
retried after the release unlocks, when jobs resume from a global pause, when
the budget gate clears, on boot recovery, and from the periodic recovery sweep.

**Duplicate start (`409`)**
```json
{
  "detail": "Agent 'Weekly Code Review' is already running (job myapp-agent:Weekly Code Review-1705276900123)"
}
```

When a non-agent job already owns the project worktree, the route instead
returns `409` with `code: "project_busy"` plus the blocking job id:

```json
{
  "code": "project_busy",
  "detail": "Job 'run' is already running for myapp (job run-1705276900123)",
  "blockingJobId": "run-1705276900123"
}
```

The agent starts immediately as a PM2 process. Output is streamed to a log file and can be watched via SSE at `/api/streaming/{job_id}`.

When an agent finishes, TamTam asks it to include a short `TamTam Run Report` in the final response. The lifecycle parser stores a concise `work_summary` and `modified_files` JSON array on the job row. If a scheduled agent repeatedly finds no actionable work and changes no files, TamTam creates an open project recommendation instead of silently changing the schedule.

### Scheduled Runs

If an agent has both `schedule` and `prompt`, the schedule is installed automatically on creation/update:

- **runner: "pm2"** — Registers the agent with TamTam's in-process scheduler. The long-lived TamTam server must be running for scheduled fires to happen.
- **runner: "launchctl"** — Legacy macOS LaunchAgent support retained for backward compatibility. New agents should use `runner: "pm2"`; launchctl emits a deprecation warning.

On each scheduled trigger, the agent runs with its stored `prompt`.

## Skill Composition

Skills are combined into a system prompt before the task prompt:

```
## Skill 1 Name
Skill 1 content...

---

## Skill 2 Name
Skill 2 content...

---

[Task prompt provided at run time]
```

The final prompt sent to Claude is:
```
[Base prompt from settings] + [Composed skills] + [Task prompt]
```

For file-backed agents in `.tamtam/agents/*.md`, `provider:` is committed frontmatter and is preserved on prompt-only writes. TamTam treats it as part of the shared agent contract, not as an ephemeral UI-only override.

This allows agents to be reusable — the same agent can run with different task prompts while keeping the skill composition consistent.

## Request Flow

```
User/scheduler triggers
  → POST /api/agents/{agentId}/run
      → Fetch agent from DB
      → Check for running/starting agent on the same project
          → same agent already active/starting → 409
          → different agent active/starting → 202 queued
      → Check for active release lock on the same project
          → release in flight → 202 queued with `code: "pipeline_lock"` and a DB-backed queue row
      → Claim per-project start slot
      → Check for queued pending release on the same project
          → try draining pending release first
          → still pending / release reacquired lock → 202 queued with `code: "pending_release"` or `code: "pipeline_lock"` and a DB-backed queue row
      → Fetch skills from DB (by skillIds)
      → Compose system prompt: `## SkillName\nContent` + `---` separators
      → Build command:
          claude --print --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions --model {agent.model}
      → Create job record
      → Start via PM2 with composed prompt as stdin
      → Return job ID and PID
      → If startup fails before PM2 takes over, release the per-project start slot and drain the next queued fire immediately
  → Process runs → writes NDJSON log
  → Lifecycle stores agent run summary and changed-file metadata
  → No-op scheduled runs may create project recommendations
  → Client polls /api/streaming/{job_id} to watch output
```

For scheduled runs with `runner: "pm2"`, the trigger path is:

```
TamTam server boots
  → instrumentation-node.ts calls reinstallAgents()
      → lib/scheduling/internal-scheduler.ts arms setTimeout entries
          → timer fires
              → POST /api/agents/{agentId}/run (in-process fetch)
                  → normal agent-run flow above
```

If a release lock blocked the fire, the queued row is replayed by
`queued-agent-runs.ts` instead of the in-memory pending queue. Replays are
triggered after release unlock, on resume from a global pause, on budget
recovery, at boot, and by the periodic queued-agent recovery ticker.

## Querying Agents

**GET /api/agents** — List all agents

```bash
curl http://localhost:1337/api/agents
```

**GET /api/agents?project=myapp** — Filter by project

```bash
curl http://localhost:1337/api/agents?project=myapp
```

**GET /api/agents/{agentId}** — Get a single agent

```bash
curl http://localhost:1337/api/agents/agent-1705276800000
```

## Updating an Agent

**PATCH /api/agents/{agentId}**

```bash
curl -X PATCH http://localhost:1337/api/agents/agent-1705276800000 \
  -H "Content-Type: application/json" \
  -d '{
    "skillIds": ["skill-789"],
    "model": "smart",
    "schedule": "2h"
  }'
```

Only provided fields are updated. If you change `schedule`, `prompt`, or `enabled`, the schedule is automatically reinstalled or uninstalled.

## Deleting an Agent

**DELETE /api/agents/{agentId}**

```bash
curl -X DELETE http://localhost:1337/api/agents/agent-1705276800000
```

This also removes any active internal-scheduler entry or legacy LaunchAgent.

## Scheduled Execution Details

### Internal Scheduler (`runner: "pm2"`)

When `runner: "pm2"`, TamTam does not create a PM2 cron job. Instead it stores the schedule in memory inside the long-lived Next.js server process and computes the next fire time with `computeNextFire()` in `lib/scheduling/internal-scheduler.ts`.

Current behavior:

- `instrumentation-node.ts` calls `reinstallAgents()` on boot to load enabled scheduled agents from the DB and file-agent layer.
- `lib/scheduling/internal-scheduler.ts` arms one `setTimeout` per agent using the supported `Nm` / `Nh` / `Nd` interval grammar plus a stable per-agent phase offset.
- When the timer fires, the scheduler POSTs to `/api/agents/{id}/run` with the stored prompt and `X-Tamtam-Trigger: schedule`.
- Agent CRUD routes call `installAgentSchedule()` / `uninstallAgentSchedule()`, which delegate to `upsertAgentSchedule()` / `removeAgentSchedule()` so schedule changes apply immediately without restarting the server.
- Actual agent work still runs as one-shot PM2-managed job processes after `/api/agents/{id}/run` accepts the request. PM2 is used for job execution, not for recurring schedule timers.

Skip conditions tracked by the internal scheduler:

- global job pause
- budget gate or 7-day burn-rate throttle
- release pipeline lock for the same project
- issue-branch lock for the same project
- duplicate in-flight or in-progress-start agent run

The scheduler tracks `nextFireMs`, `lastFireMs`, `fireCount`, `errorCount`, `skippedCount`, and the most recent error/skip reason. `/api/agents/scheduler-health` exposes both the expected agent set and the live internal scheduler state.

#### Why PM2 cron is not used

Older TamTam versions tried to register scheduled agents with PM2 cron. PM2's `cron_restart` combined with `--no-autostart` silently no-op'd: the cron tick updated PM2 metadata but never started the stopped process. That left legacy PM2 schedule rows behind that looked installed but never fired. The current implementation removes those rows and uses the in-process scheduler instead.

### LaunchAgent (macOS)

`runner: "launchctl"` is legacy-only. The code path remains for backward compatibility with pre-existing DB rows and file-agent overrides, but new agents should not use it.

Launchctl uses the same validated interval grammar as the internal scheduler: `Nm`, `Nh`, and `Nd` are all accepted and are converted to `StartInterval` seconds in the generated plist.

When `runner: "launchctl"` is still present on an existing agent, a `.plist` file is created in `~/Library/LaunchAgents/`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tamtam.agent.{agentId}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/...logs/agent-scripts/{agentId}.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>{intervalInSeconds}</integer>
  <key>StandardOutPath</key>
  <string>./data/logs/agent-scheduler-{agentId}.log</string>
  <key>StandardErrorPath</key>
  <string>./data/logs/agent-scheduler-{agentId}.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Schedule string format:
- `"30m"` → every 30 minutes
- `"1h"` → every hour
- `"8h"` → every 8 hours

The agent loads on startup and runs at the configured interval. TamTam logs a `[agent-scheduler] launchctl runner is deprecated` warning on install, uninstall, and health checks for these rows.

## Preventing Duplicate Runs

To prevent multiple agents from racing in the same git worktree, the run
endpoint applies two guards:

1. An existing-job check for already-running agent jobs on the same project.
2. A synchronous per-project "starting" slot covering the gap between that
   check and `pm2 start`, so concurrent requests cannot both observe an empty
   running set and start together.

Same-agent duplicates are rejected with `409`. Different agents on the same
project are returned as `202 queued` and are drained FIFO when the active or
starting run exits or fails before startup completes.

The running-job guard looks like:

```typescript
const kindKey = `agent:${agent.name}`;
const running = listJobs()
  .filter(j => j.project === agent.project && j.kind === kindKey && j.finishedAt === null)
  .filter(j => probeJobStatus(j) === 'running');

if (running.length > 0) {
  return 409 "Agent is already running";
}
```

This prevents concurrent runs if a schedule fires faster than the agent completes. The
additional start-slot closes the smaller race where a second request arrives
after the running-job check but before the first request has created its job row.

### Spawn-grace in `probeJobStatus`

Job rows are inserted with `pid=0` and the real pid is persisted asynchronously after `pm2 start` returns (hundreds of ms, up to pm2's 15 s timeout). `probeJobStatus` treats `pid<=0` as **still spawning** for the first 30 seconds after `startedAt` — otherwise a concurrent duplicate-check would `markDone(-1)` the sibling mid-spawn **and** `pm2 delete` its Claude process, producing a phantom `exit -1 @ 0s` row next to the real run. After the grace window, `pid<=0` is treated as dead as before. See `lib/job-storage.ts:probeJobStatus`.

## Example: Set Up a Weekly Review Agent

1. **Create a skill** that provides code review instructions:
   ```bash
   curl -X POST http://localhost:1337/api/skills \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Code Review Instructions",
       "description": "Guidelines for reviewing code changes",
       "content": "Focus on: correctness, performance, security, readability. Flag TODOs and FIXMEs..."
     }'
   ```

2. **Create the agent**:
   ```bash
   curl -X POST http://localhost:1337/api/agents \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Weekly Code Review",
       "project": "myapp",
       "skillIds": ["skill-abc123"],
       "model": "normal",
       "prompt": "Review all uncommitted changes and provide feedback",
       "schedule": "24h",
       "runner": "pm2",
       "enabled": true
     }'
   ```

3. **Verify the schedule**:
   ```bash
   curl http://localhost:1337/api/agents/scheduler-health
   ```

4. **Manually trigger** (to test):
   ```bash
   curl -X POST http://localhost:1337/api/agents/{agentId}/run \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Review uncommitted changes"}'
   ```

5. **Watch output**:
   ```bash
   curl http://localhost:1337/api/streaming/{job_id}
   ```

## Key Files

| File | Role |
|------|------|
| `lib/db/schema.ts` | `agents` table definition |
| `app/api/agents/route.ts` | Create, list agents |
| `app/api/agents/[agentId]/route.ts` | Get, update, delete agents |
| `app/api/agents/[agentId]/run/route.ts` | Run agent on-demand (skill composition happens here) |
| `app/api/agents/scheduler-health/route.ts` | Scheduler reconciliation + health view |
| `lib/scheduling/agent-scheduler.ts` | Schedule install/uninstall + legacy PM2/launchctl cleanup |
| `lib/scheduling/internal-scheduler.ts` | In-process schedule timers, skip reasons, live state |
| `lib/jobs/pm2-jobs.ts` | PM2 process lifecycle for actual agent runs |
| `components/AgentsTab.tsx` | UI for agent management |
| `instrumentation-node.ts` | Boot-time scheduler install + other Node-only startup work |

### Instrumentation edge-runtime constraint

Next.js compiles `instrumentation.ts` for **both** the Node and Edge runtimes. Anything the file imports — even transitively, and even through `await import(...)` — is traced into the Edge bundle. `lib/db` uses `path`, `fs`, and `better-sqlite3`, none of which exist on Edge, so a direct import produces:

```
A Node.js module is loaded ('path' at line 4) which is not supported in the Edge Runtime.
Import trace:  Edge Instrumentation: ./lib/db/index.ts → ./instrumentation.ts
```

A runtime guard (`if (process.env.NEXT_RUNTIME !== 'nodejs') return`) prevents execution on Edge but **does not prevent bundling**. To keep Node-only code out of the Edge bundle, split it into a sibling file (e.g. `instrumentation-node.ts`) and dynamic-import that file from inside the runtime branch:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNode } = await import('./instrumentation-node');
  await registerNode();
}
```

The dynamic import target is only referenced under the Node branch, so Turbopack's Edge pass doesn't trace it. Put `reinstallAgents()`, `runNightlyCleanup`, and any other Node-only logic in the sibling file. The same rule applies to `middleware.ts` and any route handler with `export const runtime = 'edge'`.

## Tests

- Unit: `__tests__/api/agents.test.ts` — agent CRUD and run tests
- E2E: `e2e/agents.spec.ts` — Playwright tests (requires dev server)
- `pnpm test` — run unit tests
- `pnpm test:e2e` — run e2e tests

---

## Quick Reference

### Schedule format

| String | Fires every |
|--------|-------------|
| `"15m"` | 15 minutes |
| `"30m"` | 30 minutes |
| `"1h"` | 1 hour |
| `"8h"` | 8 hours |
| `"24h"` | 24 hours |
| `null` | Manual only (no schedule installed) |

### Runner selection

| Runner | Requires | Persists across reboots | Use when |
|--------|----------|------------------------|----------|
| `pm2` | TamTam server running under PM2 or another long-lived supervisor | Yes, if the TamTam server itself is restarted on boot | Default for all new agents |
| `launchctl` | macOS | Yes (LaunchAgent) | Legacy compatibility only; migrate existing rows to `pm2` |

### Prompt composition order

```
[base_prompt from settings]
  + ## SkillName\nContent\n---  (for each skillId)
  + [task prompt from agent.prompt or run-time override]
```

### Verify a scheduled agent

```bash
# Inspect the live internal scheduler
curl http://localhost:1337/api/agents/scheduler-health

# Check legacy launchctl agents (macOS only)
launchctl list | grep tamtam

# Manually trigger
curl -X POST http://localhost:1337/api/agents/{agentId}/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test run"}'

# Watch output
curl -N http://localhost:1337/api/streaming/{job_id}
```

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Agent returns 409 on run | Another instance already running | Wait for the current run to finish; duplicate prevention is intentional |
| Schedule not firing | `prompt` or `schedule` is empty, the internal scheduler is paused, or the fire was intentionally skipped | Check `/api/agents/scheduler-health` for `missing`, `errorCount`, `skippedCount`, `lastError`, and `lastSkippedReason` |
| Scheduled fires being skipped with `dirty worktree: N files` | The project has more uncommitted/untracked files than `dirty_worktree_block_threshold` (default 20). Agents won't run on top of large WIP. | Commit, stash, or discard pending changes — or raise the threshold (or set to 0 to disable) in Settings → Pipeline. |
| Skills not in Claude's context | `skillIds` references deleted skills | Re-check skill IDs; missing skills are silently skipped |
| Scheduler says the agent is missing | Boot-time reinstall did not register the entry or the row was changed while the server was down | POST `/api/agents/scheduler-health` to reinstall missing schedules, then re-check the GET response |
| LaunchAgent not surviving reboot | plist not loaded | Legacy only: run `launchctl load ~/Library/LaunchAgents/com.tamtam.agent.{id}.plist`, then migrate the agent to `runner: "pm2"` |
| Agent runs but no output in UI | Job started but SSE not connected | Navigate to `/project/[name]/history`, open the run log |
| `schedule` change didn't take effect | Internal scheduler entry was not refreshed yet | PATCH the agent again or POST `/api/agents/scheduler-health` to reinstall missing schedules, then confirm the new `nextFireMs` |
