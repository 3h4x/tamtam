# Agents — How They Work

Agents are reusable automation units that combine skills, a model, a prompt template, and optional scheduling. Each agent runs Claude CLI with a composed system prompt (skills) and a task prompt, either on-demand or on a recurring schedule.

## When to read this

- Creating a new agent via API or UI
- Debugging why a scheduled agent isn't firing
- Understanding how skills are composed into the system prompt
- Preventing duplicate/concurrent agent runs
- Switching between PM2 and launchctl schedulers

---

## Concepts

- **Agent** — A configuration combining skills, model, and prompt template
- **Scheduled run** — Automatic executions via PM2 or launchctl on an interval (e.g., "1h", "30m")
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
| `runner` | string | `pm2` | Scheduler: `"pm2"` or `"launchctl"` (macOS only) |
| `enabled` | boolean | `true` | Enable/disable without deletion |
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
    "name": "Weekly Code Review",
    "project": "myapp",
    "skillIds": ["skill-123", "skill-456"],
    "model": "normal",
    "prompt": "Review uncommitted changes in the project and suggest improvements",
    "schedule": "1w",
    "runner": "pm2",
    "enabled": true
  }'
```

**Response:**
```json
{
  "agent": {
    "id": "agent-1705276800000",
    "name": "Weekly Code Review",
    "project": "myapp",
    "skillIds": "[\"skill-123\", \"skill-456\"]",
    "model": "normal",
    "prompt": "Review uncommitted changes...",
    "schedule": "1w",
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

**Response:**
```json
{
  "status": "started",
  "job_id": "job-1705276900123",
  "pid": 45678,
  "agent": "Weekly Code Review"
}
```

The agent starts immediately as a PM2 process. Output is streamed to a log file and can be watched via SSE at `/api/streaming/{job_id}`.

When an agent finishes, TamTam asks it to include a short `TamTam Run Report` in the final response. The lifecycle parser stores a concise `work_summary` and `modified_files` JSON array on the job row. If a scheduled agent repeatedly finds no actionable work and changes no files, TamTam creates an open project recommendation instead of silently changing the schedule.

### Scheduled Runs

If an agent has both `schedule` and `prompt`, the schedule is installed automatically on creation/update:

- **runner: "pm2"** — PM2 cron job (works on any OS)
- **runner: "launchctl"** — macOS LaunchAgent (requires macOS)

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

This allows agents to be reusable — the same agent can run with different task prompts while keeping the skill composition consistent.

## Request Flow

```
User/scheduler triggers
  → POST /api/agents/{agentId}/run
      → Fetch agent from DB
      → Fetch skills from DB (by skillIds)
      → Compose system prompt: `## SkillName\nContent` + `---` separators
      → Build command:
          claude --print --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions --model {agent.model}
      → Create job record
      → Start via PM2 with composed prompt as stdin
      → Return job ID and PID
  → Process runs → writes NDJSON log
  → Lifecycle stores agent run summary and changed-file metadata
  → No-op scheduled runs may create project recommendations
  → Client polls /api/streaming/{job_id} to watch output
```

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

This also uninstalls any active schedule (PM2 cron or LaunchAgent).

## Scheduled Execution Details

### PM2 Cron

When `runner: "pm2"`, a PM2 cron job is created:

```bash
pm2 cron "0 */1 * * *" --name tamtam-{project}-agent-{agentName} \
  "curl -s -X POST http://localhost:1337/api/agents/{agentId}/run -H 'Content-Type: application/json' -d @{promptFile}"
```

The prompt is stored in `./data/logs/agent-scripts/{agentId}.prompt.json` and passed to the run endpoint.

Log output goes to `./data/logs/agent-scheduler-{agentId}.log`.

#### PM2 boot-storm gotcha

`pm2 start <script> --cron <expr>` registers the cron **and synchronously executes the script once** — PM2 has no "register without running" behavior by default. A naïve `pm2 start` followed by `pm2 stop` does not prevent the initial invocation; the curl in the script reaches `/api/agents/{id}/run` before `pm2 stop` lands, spawning a real agent run. With N scheduled agents, every `reinstallAgents()` pass produces N unintended runs (visible as `<project>-agent:<name>-<epoch>` PM2 processes alongside the `tamtam-<project>-agent-<name>` schedule entries).

The fix is `--no-autostart` on `pm2 start`. This flag is accepted by `pm2 start` on v6.x (even though `pm2 start --help` doesn't list it) and registers the process in `stopped` state so the script only runs when the cron fires. It should be paired with `--no-autorestart` so a completed run doesn't immediately respawn.

```
pm2 start <scriptPath> --name <name> --no-autostart --no-autorestart --cron <cronExpr>
```

If the flag is ever removed upstream, the fallback is ecosystem config with `autostart: false`; the previous `pm2 start` → `pm2 stop` sequence is not a working substitute.

### LaunchAgent (macOS)

When `runner: "launchctl"`, a `.plist` file is created in `~/Library/LaunchAgents/`:

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

The agent loads on startup and runs at the configured interval.

## Preventing Duplicate Runs

To prevent an agent from running multiple times simultaneously, the run endpoint checks if an agent with the same name is already running on the same project:

```typescript
const kindKey = `agent:${agent.name}`;
const running = listJobs()
  .filter(j => j.project === agent.project && j.kind === kindKey && j.finishedAt === null)
  .filter(j => probeJobStatus(j) === 'running');

if (running.length > 0) {
  return 409 "Agent is already running";
}
```

This prevents concurrent runs if a schedule fires faster than the agent completes.

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
       "schedule": "1w",
       "runner": "pm2",
       "enabled": true
     }'
   ```

3. **Verify the schedule**:
   ```bash
   pm2 cron list
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
| `lib/agent-scheduler.ts` | Install/uninstall PM2 cron and LaunchAgent |
| `lib/pm2-jobs.ts` | PM2 process lifecycle |
| `components/AgentsTab.tsx` | UI for agent management |
| `instrumentation.ts` | Next.js register hook; calls `reinstallAgents()` on server boot |

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
| `pm2` | PM2 installed | Only if PM2 on startup | Server/Linux environments |
| `launchctl` | macOS | Yes (LaunchAgent) | macOS dev machines |

### Prompt composition order

```
[base_prompt from settings]
  + ## SkillName\nContent\n---  (for each skillId)
  + [task prompt from agent.prompt or run-time override]
```

### Verify a scheduled agent

```bash
# Check PM2 cron jobs
pm2 cron list

# Check launchctl agents (macOS)
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
| Schedule not firing | `prompt` or `schedule` is empty | Both fields required for schedule installation |
| Skills not in Claude's context | `skillIds` references deleted skills | Re-check skill IDs; missing skills are silently skipped |
| LaunchAgent not surviving reboot | plist not loaded | Run `launchctl load ~/Library/LaunchAgents/com.tamtam.agent.{id}.plist` |
| Agent runs but no output in UI | Job started but SSE not connected | Navigate to `/project/[name]/history`, open the run log |
| `schedule` change didn't take effect | Old schedule still installed | PATCH the agent — schedule is reinstalled on any update |
