# Agents — How They Work

Agents are reusable automation units that combine skills, optional attached project docs, a model, a prompt template, and optional scheduling. User agents run the selected provider through TamTam's Claude-compatible CLI shim layer with a composed system prompt (skills + selected docs) and a task prompt, either on-demand or on a recurring schedule. System agents are built-in DB rows that use the same schedule surface but dispatch to internal TamTam handlers instead of the CLI workflow.

## When to read this

- Creating a new agent via API or UI
- Debugging why a scheduled agent isn't firing
- Understanding how skills and attached project docs are composed into the system prompt
- Preventing duplicate/concurrent agent runs
- Understanding graphile-worker backed scheduling
- Understanding the durable intake workflow (local-world by default, with Postgres world as an override)

---

## Concepts

- **Agent** — A configuration combining skills, optional attached project docs, model, and prompt template
- **System agent** — A built-in, auto-seeded agent with `kind: "system"` whose identity and behavior are owned by TamTam
- **Scheduled run** — Automatic execution on an interval (e.g., "1h", "30m"), driven by the graphile-worker cron pool
- **On-demand run** — Manual execution triggered via API or UI
- **Agent context composition** — Skills and attached docs are prepended as context before the task prompt

## Agent Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | `agent-{timestamp}` | Unique identifier |
| `name` | string | required | Display name (e.g., "Daily Tests") |
| `project` | string | required | Project name (must exist in workspace) |
| `skillIds` | string (JSON array) | `[]` | Array of skill IDs to compose as system prompt |
| `docPaths` | string (JSON array) | `[]` | Array of project-relative doc paths to include alongside skills in the composed prompt context |
| `model` | string | `normal` | Semantic model tier: `fast`, `normal`, or `smart`. Legacy `haiku`, `sonnet`, and `opus` aliases are still accepted. |
| `prompt` | string | `''` | Default task prompt for scheduled runs |
| `schedule` | string | `null` | Run interval for scheduling: `"30m"`, `"1h"`, `"8h"`, etc. or `null` for manual only |
| `enabled` | boolean | `true` | Enable/disable without deletion |
| `boostable` | boolean | `true` | Allow the orchestrator to pick this agent for bonus "boost" fires. Set to `false` for agents that should only run on their own schedule |
| `provider` | string \| null | `null` | Optional required CLI provider (`claude`, `codex`, `gemini`, `lmstudio`, `deepagents`). `null` means "any enabled provider". When set, the run fails closed if that provider is disabled or over budget. |
| `fallbackEnabled` | boolean | `false` | Opts the agent into one transient provider fallback retry using `provider_fallback_chain`. Built-in recommended agents are created with this enabled. |
| `prerequisiteCommand` | string \| null | `null` | Optional `bash -c` command run in the project directory before the agent CLI starts. Output is captured to a prerequisite artifact and prepended to the agent prompt. |
| `kind` | `"user"` \| `"system"` | `"user"` | `user` agents run through the normal CLI intake workflow. `system` agents are auto-seeded, DB-only built-ins that dispatch to internal handlers. |
| `role` | enum | `producer` | Drives the autopilot policy (see Roles below). Inferred at create-time from name/skills/prompt; operator-overridable. |
| `createdAt` | number | — | Unix timestamp (seconds) |
| `updatedAt` | number | — | Unix timestamp (seconds) |

## Roles

Every agent has a **role** that tells the orchestrator how to judge its value and
which lever may reclaim its budget (the **autopilot** — see `docs/ORCHESTRATOR.md`).
Diff-count is a fair value proxy for a producer but not for a watchdog, so the
behavior is role-specific:

| Role | Value signal | Autopilot lever | Diff-based recs (`agent_unfruitful` / `agent_schedule_backoff`)? |
|------|--------------|-----------------|---------------------------------|
| `producer` (improve, refactor, dedupe, docs-gen) | shipped diffs | cadence-throttle on sustained loop/noise | yes |
| `monitor` (audit-logs, log/health scanners) | coverage; finding nothing = success | model-downgrade when idle; **cadence never touched** | no |
| `reviewer` / QA (review, qa, test-e2e, security) | issues caught / verdicts | model-downgrade when idle | no |
| `planner` (research, recommend, plan) | artifacts (issues, plans) | model-downgrade when idle | no |
| `publisher` (blog, social) | published output | none — untouched | no |

Role is inferred at create-time by a token-free keyword heuristic
(`inferAgentRole` in `lib/agents/roles.ts`) and can be overridden explicitly via
the agent editor or `PATCH /api/agents/{id}` `{ role }`. It is stored in the
`agents.role` column. Defaulting an un-tagged monitor to
`producer` is safe: a quiet watchdog never produces the loop/noise verdict that
cadence-throttling requires, so it is never throttled — tagging it `monitor` only
unlocks the model-downgrade saving and silences the diff-based recommendations.

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
    "enabled": true,
    "createdAt": 1705276800.5,
    "updatedAt": 1705276800.5
  }
}
```

**Required fields:** `name`, `project`  
**Optional fields:** `skillIds` (default `[]`), `docPaths` (default `[]`), `model`, `prompt`, `schedule`, `enabled`, `boostable`, `provider`, `prerequisiteCommand`

`POST /api/agents` always creates user agents. `kind: "system"` is reserved for TamTam's system-agent seeder and is rejected by the public create route.

If you provide both `schedule` and `prompt`, the agent's schedule is automatically installed.

## Built-in Recommended Agents

TamTam ships a curated built-in catalog of recommended agents in [lib/agents/recommended-agents.ts](../lib/agents/recommended-agents.ts). This catalog is a core product surface: it defines the opinionated starter agents shown at the top of the Agents tab before a project has installed its own versions.

Behavior:

- Built-in recommendations are shown in three UI buckets: `essential`, `featured`, and regular recommended.
- They are templates only. Clicking `Add` creates a normal project agent row; TamTam does not treat the resulting agent as special after creation.
- `schedule: ''` means manual-only. The template appears in recommendations, but the created agent is unscheduled until the user sets a schedule.
- Built-in templates are merged with custom templates from Settings → Templates.
- Custom templates override built-ins by case-insensitive `name` or a built-in legacy alias, so teams can replace the shipped default content for a given recommended agent without patching code.
- Override scope is content only. Settings templates do not carry the built-in `essential` / `featured` flags, so a same-name override suppresses the shipped entry and appears in the regular recommended bucket.

Current notable entries:

- `docs-claude` is marked `essential` because TamTam depends on project-specific Claude guidance being present and current.
- `docs-generate` is marked `essential` because it creates a new Layer-2 docs page for an uncovered subsystem, then links its design back to the existing wiki instead of editing established docs in place.
- `manage-agents` is marked `featured` because it maintains the project's broader agent fleet.
- `cto` is the strategic issue-planning agent. Its shipped skill reads `CLAUDE.md`, `README.md`, and project docs before proposing work, checks open issues and implementation evidence before filing, and marks issues that need external account/vendor setup with `human-needed` so autonomous implementers do not pick them as code-ready.
- `issue-cruncher` is marked `featured` and manual-only because it is a high-leverage entry point into TamTam's core issue-to-release workflow: pick a ready GitHub issue, close stale or unverifiable ones by default during validation, implement actionable work on an issue branch, then hand off to the existing release pipeline.
- `qa` is marked `featured` because it browses the project's configured `qa_url` when present, otherwise the configured `website`, using the host-side `/api/projects/by-project/<name>/config` prerequisite output as its target source. It uses Playwright MCP tools in the `mcp__tamtam_browser__*` namespace to look for UI bugs, fixes at most 1-2 small safe findings directly, and reports anything larger, risky, or unclear. It stops early with `QA_NO_TARGET` when the project has neither URL configured; it does not hand off to other agents or create GitHub issues.
- `refactor-split` is marked `featured` because it consumes the improve agent's `F6: oversized` audit rows and performs the supervised follow-up split improve intentionally defers: one eligible file per run, with type-check and targeted tests before it records the split ledger.

When changing this catalog:

- Edit the shared module, not `components/AgentsTab.tsx`.
- Keep names stable; name collisions are the override key.
- Treat description, model tier, schedule default, and badges as product decisions, not page-local copy.
- Add or update a unit test if the contract or classification changes.

## Built-in System Agents

The `agents` table has a `kind` column with two values: `'user'` (default — everything created via UI/API) and `'system'` (built-in, auto-seeded per project, dispatched to an internal handler instead of the LLM-CLI intake workflow). System agents share the agents table, the scheduled-agent cron pipeline, and the `/workflow-runs` UI; they differ only at the cron-task dispatch point in `lib/workflows/cron/agent-cron-task.ts`, which routes `kind='system'` to `runSystemAgent()` (registered in `lib/agents/system/index.ts`) instead of `startAgentRun()`.

Lifecycle:

- **Seeded** at TamTam boot via `seedSystemAgents()` (`lib/agents/system/seed.ts`) for every enabled project, before `seedAgentCrons()` runs. The seeder is also called per-project after a PATCH on `/api/config/projects` flips a project to `enabled: true`. Idempotent: a project that already has a row, or that has a `system_agent_dismissed:<project>:<name>` settings marker, is skipped. Name conflicts with existing DB agents (case-insensitive) are also skipped — user-owned names take precedence.
- **Locked at the API:** POST `/api/agents` rejects `kind=system` (400). PATCH `/api/agents/[agentId]` strips mutating fields for `kind=system` rows, rejects `schedule`, and honors only `enabled`. DELETE writes a dismissal marker so the seeder does not recreate the row on next boot.
- **Dispatched** by the cron task with no CLI spawn. The handler writes its own job row (`createJob`), performs the work in-process, fills in `workSummary` + `contextMeta.retrievalHealth`, and persists via `updateJob` — bypassing `markDone` because the post-processing chain (stream-json parsing, outcome-classifier hooks, release chain) assumes a CLI session that system agents don't produce.

Current entries:

- **`documentation-reindex-vectors`** (`lib/agents/system/retrieval-maintenance.ts`) — keeps the pgvector retrieval index in sync. On each fire: detects embedding-model drift via `retrieval_records.embedding_model` and wipes that project's chunks if the configured model has changed; calls `reindexProject()` (`lib/agents/retrieval/reindex-project.ts`) — the same code path the manual reindex API uses; finally issues a sample retrieval query and, when `outcome_classifier_model` is non-empty, asks the cheap LLM (default `gemma3:4b`) whether the snippets look like real on-topic content for the project. The verdict (`ok` | `problem` | `null`) plus reindex stats land on `contextMeta.retrievalHealth`. See `docs/SETTINGS.md` → "Built-in documentation-reindex-vectors agent" for the operator-facing description.

Auto-seed is not limited to system (`kind:'system'`) agents. A catalog entry with `dispatch:'cli'` + `autoSeed:true` seeds a normal `kind:'user'` agent per project, with its `role`/`boostable`/`skillIds` taken from the catalog entry (`lib/agents/system/seed.ts`). The built-in **`health`** monitor uses this path (`role:'monitor'`, `boostable:false`) so it runs the standard LLM-CLI intake workflow rather than an in-process handler — see `docs/HEALTH.md`. (`SYSTEM_AGENTS` in `lib/agents/system/index.ts` therefore maps only the `dispatch:'internal'` auto-seed entries to handlers.)

Settings hooks that interact with system agents:

- Changing `retrieval_embedding_model` in `/settings/general` fires every `documentation-reindex-vectors` agent immediately (`quickAddJob('agent-cron', …, { runAt: new Date() })`) so the wipe+reindex starts at once instead of waiting up to one schedule interval.

When adding a new system agent:

1. Implement the handler under `lib/agents/system/<name>.ts` with signature `(agent: AgentInput) => Promise<{ jobId: string }>`. Use `createJob` + `updateJob`; do not route through `markDone` or `runAgentIntakeWorkflow`.
2. Register it in `lib/agents/system/index.ts` (`SYSTEM_AGENTS` map). The registry is the single source of truth for which system agents exist and what their default seed config is.
3. Add a vitest covering the handler's deterministic steps + the verifier path under `__tests__/lib/agents/system/`.
4. Update this section and `docs/SETTINGS.md` if the agent introduces operator-visible behavior.

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

For system agents, this route runs the registered internal handler immediately and ignores the prompt body. It returns the created system job id with `via: "system"` and never starts the CLI intake workflow.

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

Mutable agent runs are serialized by a durable per-project run slot stored in
`maintenance_status` for the lifetime of the active agent job. This covers
parallel cron fires, route races, and separate Next.js runtime contexts whose
in-memory job caches may not yet agree. Same-agent duplicates return `409`;
different agents for the same project return `202 queued` and are drained when
the running agent finishes.

When the route is between duplicate-check and job creation, the response may
still be `202 queued`, but without a `blockingJobId`. In that case the blocking
agent has the durable run slot but has not landed its job row yet.

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

The agent starts immediately as a detached child process. Output is streamed to a log file and can be watched via SSE at `/api/streaming/{job_id}`.

When retrieval is enabled and prompt-time search returns snippets above the configured score threshold, the intake workflow prepends a `## Retrieved Context` block to the prompt and records a bounded audit trail on the job's `context_meta.retrieval.sources`. Each source entry includes `sourceKind`, `sourceId`, `project`, `rank`, `score`, and a short preview only; full retrieved bodies are not duplicated into metadata. Restoring the run in the terminal session view renders a compact `Retrieved Context` section before the user prompt so operators can inspect what was injected. Runs with retrieval disabled, an empty corpus, failed embedding, or no accepted snippets do not get retrieval metadata.

When an agent finishes, TamTam asks it to include a short `TamTam Run Report` in the final response. The lifecycle parser stores a concise `work_summary` and `modified_files` JSON array on the job row. If a scheduled agent repeatedly finds no actionable work and changes no files, TamTam creates an open project recommendation instead of silently changing the schedule. That `agent_schedule_backoff` recommendation now carries a structured rationale payload copied from the run report summary (`summary`, `actionableWork`, `filesChangedCount`, cadence, confidence, and `sourceJobId` when present), and the recommendations UI renders that metadata in a compact "Why" panel so operators can see why the slower cadence was suggested.

The orchestrator tick may also run a small, budget-gated health analysis for scheduled user agents when global pace is safe. It looks at recent scheduled runs only and can create an `orchestrator_agent_health` recommendation when the agent appears to be looping, drifting, producing noise, or making risky low-quality changes. The payload records the LLM concern fields (`concernType`, `severity`, `llmSummary`, `llmRecommendation`) plus run metrics (`runsAnalyzed`, `runIds`, `lastRunScore`, `avgRunScore`). These recommendations are informational: the UI renders the metrics in the "Why" panel and only offers dismiss, not Accept/apply.

### Read-only Agent Runs

`POST /api/agents/{agentId}/run` accepts `readOnly: true` for agents whose task does not touch the local checkout. The canonical case is the built-in `cto` agent when it is used from the Issues tab to shape a user idea into one GitHub issue via `gh issue list` and `gh issue create`. That wrapper asks the agent to read project guidance docs, search the implementation for existing behavior, and avoid creating duplicate issues. If the proposed work depends on a human-owned external account, vendor setup, billing, secrets, approvals, or credentials, it must add/create the `human-needed` label and state the prerequisite in the issue body.

That issue-planning flow now uses one shared body contract so downstream DoD automation can parse it reliably:

```md
## Problem
<one paragraph describing the gap and why it matters>

## Proposed approach
<bulleted or short-paragraph plan>

## Acceptance criteria
- [ ] <verifiable outcome 1>
- [ ] <verifiable outcome 2>
```

The section order matters, and each acceptance criterion must use an unchecked `- [ ]` checkbox. `mark-dod` parses those boxes from the GitHub issue body and ticks verified items in place.

Read-only runs bypass per-project worktree serialization so they can start while unrelated agents or terminal jobs are running. Specifically, they skip the non-agent busy gate, different-agent queueing, the project start slot, pending-release re-acquire, and dirty-worktree checks. They still reject duplicate runs of the same agent, still queue behind an active release pipeline lock, and still honor the CLI start gate for pause and quota policy.
Agent metadata does not grant that bypass. Names, skill IDs, and schedule source must not affect concurrency; only the explicit `readOnly: true` run request opts into the lighter path.
Agent names are trimmed before persistence, must be non-empty, and may not contain slashes, backslashes, or control characters. Create and rename operations reject project-local duplicates among DB agents, using a case-insensitive uniqueness key so `Agent` and `agent` cannot coexist.

Issue-branch behavior is now split by trigger type:

- manual agent runs are allowed on `fix/issue-*` branches
- scheduled mutable agent fires are skipped while the project is on any non-default branch, or while a release `pr-wait` job is awaiting merge, so background automation does not land unrelated edits on an in-progress PR branch
- when the opt-in `ci_gate_block_dispatch_on_red` setting is enabled (default off), scheduled fires are also skipped while the project's **default-branch CI is red** (any failing workflow), deferring new scheduled work until CI goes green again. `system` agents are exempt (no diff-producing runs, mirroring the saturation backoff); `fix-ci`, releases, and manual runs are unaffected, so CI can still self-heal and ship. The flag is read realm-safe via `isCiDispatchGateEnabled()` (direct DB read, not `getSettings()`), fails open on a `gh` error, and the red state is surfaced as the `ci_red` inbox HITL. See `lib/jobs/ci-dispatch-gate.ts` and `docs/SETTINGS.md`.

### Scheduled Runs

If an agent has `schedule` and either a prompt or skills, the schedule is installed automatically on creation/update. TamTam writes a prompt recovery file under `<logDir>/agent-scripts/` and upserts a graphile-worker job with `jobKey = agent-cron-<agentId>`.

On each scheduled trigger, the agent runs with its stored `prompt`.

## Agent Context Composition

Skills and attached project docs are combined into a system prompt before the task prompt:

```
## Skill 1 Name
Skill 1 content...

---

## Skill 2 Name
Skill 2 content...

---

## README.md
Selected project documentation...

---

[Task prompt provided at run time]
```

The final prompt sent to the selected provider is:
```
[Base prompt from settings] + [Composed skills/docs] + [Task prompt]
```

## Prerequisite Command

An agent may declare an optional `prerequisiteCommand` — a shell command that runs before the agent CLI is spawned. Its stdout/stderr are captured to `<logDir>/<jobId>.prereq.txt` (alongside the run's `.log`/`.prompt` files) and a summary block is prepended to the system prompt the agent receives:

```
## Prerequisite Output
Command: `pnpm test`
Exit code: 0
Duration: 4218 ms
Artifact: /Users/me/logs/agent-…-job.prereq.txt

--- stdout ---
…suite output…

--- stderr ---
```

This lets you build agents that react to fresh runtime state — e.g. a "test-speed watcher" that runs `pnpm test`, sees the duration, and proposes optimizations when the suite slows down. Output is truncated to ~64 KiB per stream in the prompt block; the full artifact file is always written.

Built-in `issue-cruncher` agents default to `curl -fsS "http://localhost:1337/api/projects/by-project/<project>/issues?pick_top=1"` when the prerequisite is missing. The endpoint picks one issue server-side (trusted authors only, blocker labels and assigned issues excluded, ranked by priority labels then `updatedAt` desc), fetches its body + comments via `gh issue view`, drops every comment whose author is not in the trust allowlist, and creates/reuses/checks out the issue branch before returning success. Blocker labels include `blocked`, `needs-info`, `needs-design`, `needs-refinement`, `discussion`, `question`, `wontfix`, `duplicate`, and `human-needed`. The response shape is `{ chosenIssue: number|null, issue: { number, title, author, state, labels, url, body, comments[], droppedCommentCount } | null, branch: { name, status } | null, openPr: { number, branch, url } | null, reason: string|null, cached, cachedAt }` — when the eligible list is empty or branch checkout is blocked, the endpoint returns `chosenIssue: null` with a non-null `reason` such as `"no_eligible_issue"`, `"branch_pipeline_running: <jobId>"`, or `"branch_creation_failed: <detail>"`, and the agent prints `NO_ELIGIBLE_ISSUE` and stops. `branch` is `null` when project config disables auto-branching or the branch is intentionally skipped. The skill forbids the agent from running `gh issue view/list/read`, `gh api repos/*/issues/*`, `git checkout`, or `git switch` because TamTam has already gathered all authorized content and moved the working tree to the selected branch; issue-cruncher runs also pass Claude `--disallowed-tools` rules for `gh issue:*`, the issue-reading `gh api` paths, and the git branch-switch primitives. Issue write actions go through TamTam's `issue-comment`, `issue-close`, and `issue-label` API routes so repo resolution and cache invalidation stay server-side. Detail responses are cached for 5 minutes in `gh_issue_detail_cache`. During validation, the shipped prompt closes stale, unverifiable, or no-longer-actionable issues as `not planned` by default; it reserves `needs-info` for recently active authors when one specific missing detail would unblock implementation. New DB-backed issue-cruncher agents get that command on creation, existing DB-backed ones are backfilled on startup, and the run path still applies the same fallback defensively for older legacy rows that truly lack a stored prerequisite. An explicit clear (`null` / empty string via the agent API) stays cleared and suppresses the default. When an OPEN PR already implements the chosen issue — matched by the canonical `fix/issue-<n>` branch, a structured `closingIssuesReferences` link, or a close-keyword in the PR body (`lib/github/find-issue-pr.ts`) — TamTam checks out that PR's branch instead of a fresh fix branch and returns it as `openPr`. The skill then verifies each acceptance criterion against that branch and either emits a gated `merge-pr` action (GitHub required checks still gate the merge server-side) or finishes the remaining work directly on the PR branch, rather than re-implementing from scratch.

Behaviour:
- The agent is spawned regardless of the prerequisite's exit code. Failures are surfaced through the prompt block (`Exit code: <n>`) so the agent can analyse them.
- Timeout is 10 minutes (hardcoded for now).
- The command runs with `bash -c <cmd>` in the project's working directory.
- The job row is created with `pid: 0` **before** the prerequisite runs, so the run is immediately visible in the UI and the log file streams in real time. The per-project agent start slot remains held while the prerequisite runs, so another agent for the same project queues instead of starting concurrently, and project-wide starters such as terminal runs, tests, CI fixes, reruns, and releases see the project as busy. Because the job exists early, mid-prerequisite cancellation via the cancel-job endpoint works: the endpoint aborts the prereq process tree, and the route reaps the placeholder cleanly (exitCode 130). The `pid: 0` placeholder sits inside the probe sweep's spawn-grace window, so probes never falsely finalize a running prereq.
- The field is stored on the `agents` row.

## Per-agent statistics

The Overview tab's "Scheduled agents" block fetches `GET /api/agents/scheduler-health` (for upcoming/last-fire timing) and `GET /api/agents/stats?project=<name>` (for run-history aggregates) every 30s and 60s respectively. For each scheduled agent it surfaces:

- **runs** — total `agent:<name>` job rows on the project.
- **avg duration** — mean of `jobs.duration_ms` across finished runs.
- **success rate** — share of finished runs with `exit_code = 0` (only shown when below 100%).
- **tokens** — sum of `input_tokens + output_tokens + cache_read_tokens + cache_create_tokens`.
- **cost** — sum of `jobs.cost_usd`.
- **files touched** — sum of `JSON.parse(jobs.modified_files).length`.
- **fixes triggered** — for agents whose name matches `/review/i`, the count of `fix` jobs sharing a `release_id` with one of this agent's runs. A rough proxy for the impact of review agents on the fix-loop.

A header strip above the per-agent list shows project-wide totals (runs, tokens, cost, files touched) so users can see cumulative agent impact at a glance. All values are computed server-side in `app/api/agents/stats/route.ts`; no UI-level aggregation.

## Magic-wand Prompt Rewrite

The Agents tab's editor includes a **✨ Improve** button next to the Prompt textarea. Clicking it sends the current draft to `POST /api/agents/improve-prompt`, which synchronously invokes `claude --print --model fast` with:

1. A baked-in TamTam-agents primer (`lib/agents/wand-primer.ts`) describing how skills compose, what `prerequisiteCommand` does, and the run-report contract.
2. The project's `CLAUDE.md` (if present).
3. Whatever skills/docs the user has selected in the form right now (resolved via the same `composeAgentSkills` helper the run path uses).
4. A meta-instruction telling Claude to output only the rewritten prompt — no preamble, no fences.

Behaviour:
- One-shot, non-streaming. UI shows a spinner; on success the textarea is replaced with the result. Native Cmd+Z restores the original draft.
- Honours the budget gate (`checkCliStartGate`). A blocked provider surfaces a toast and the textarea is left unchanged.
- 120s timeout. No job row, no spawned subprocess record, no log file.

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
      → Create job record (pid: 0, immediately visible in UI)
      → Run optional prerequisite command (cancellable via cancel-job endpoint)
      → Re-check release/project blockers after the prerequisite completes
      → Write prerequisite artifact, if applicable
      → Build command:
          {selected-provider-shim} --print --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions --model {agent.model}
      → Spawn detached child process with composed prompt as stdin
      → Return job ID and PID
      → If startup fails before the child detaches, release the per-project start slot and drain the next queued fire immediately
  → Process runs → writes NDJSON log
  → Lifecycle stores agent run summary and changed-file metadata
  → No-op scheduled runs may create project recommendations
  → Client polls /api/streaming/{job_id} to watch output
```

For scheduled runs, the trigger path is:

```
TamTam server boots
  → instrumentation-node.ts starts graphile-worker
      → seedAgentCrons() upserts agent-cron-<agentId> rows
          → graphile-worker fires agent-cron-task.ts
              → start the durable agent intake workflow
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

This also removes the prompt recovery file and pushes the graphile-worker schedule row into the far future so the chain winds down.

## Scheduled Execution Details

### Scheduled Agent Cron

Each enabled scheduled agent has one graphile-worker `agent-cron` row keyed as `agent-cron-<agentId>`. The row stores the next fire time computed with `computeNextFire()` in `lib/workflows/cron/parse-schedule.ts`.

Current behavior:

- `instrumentation-node.ts` starts the cron worker and calls `seedAgentCrons()` on boot to upsert enabled scheduled agents from the DB.
- `lib/workflows/cron/agent-cron-task.ts` handles each fire, checks pause/budget/branch/release gates, records the latest skipped/queued/dispatched attempt for the Agents UI, starts the agent intake workflow, and re-enqueues the next fire. Transient blockers such as global pause, an in-flight PR wait, non-default branch state, release locks, or stale origin state retry in about one minute; other outcomes advance to the next scheduled tick.
- A fire whose `loadAgent` lookup returns null retries on the same one-minute window up to 3 consecutive times (a `notFoundRetries` counter rides the job payload) before the chain terminates. A single null read can be a transient agent-listing miss rather than a real deletion, and terminating immediately silently kills the schedule until an operator reinstalls it via `/api/agents/scheduler-health`. A definitive read of a disabled agent still terminates immediately.
- Agent CRUD routes call `installAgentSchedule()` / `uninstallAgentSchedule()` so schedule changes apply immediately without restarting the server.
- `/api/agents` reads the graphile-worker `agent-cron-<agentId>` row to expose the actual queued `run_at` as `agent.cron.nextFireMs`, so schedule displays use queue state rather than estimating from the previous run.
- Actual agent work still runs as one-shot in-process jobs after the agent intake workflow accepts the request.

Skip conditions tracked by the cron task:

- global job pause
- budget gate or 7-day burn-rate throttle
- release pipeline lock for the same project
- issue-branch lock for the same project
- duplicate in-flight or in-progress-start agent run

`/api/agents/scheduler-health` exposes the expected agent set, graphile-worker queue keys, and any missing prompt files or queue jobs. It can reconcile missing rows by reinstalling schedules.

Schedule string format:
- `"30m"` → every 30 minutes
- `"1h"` → every hour
- `"8h"` → every 8 hours

The cron worker loads on startup and runs each scheduled agent at the configured interval.

## Preventing Duplicate Runs

To prevent multiple agents from racing in the same git worktree, the run
endpoint applies two guards:

1. An existing-job check for already-running agent jobs on the same project.
2. A synchronous per-project "starting" slot covering the gap between that
   check and spawn, so concurrent requests cannot both observe an empty
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

Job rows are inserted with `pid=0` and the real pid is persisted asynchronously after spawn returns. `probeJobStatus` treats `pid<=0` as **still spawning** for the first 30 seconds after `startedAt` — otherwise a concurrent duplicate-check would `markDone(-1)` the sibling mid-spawn and tear down its Claude process, producing a phantom `exit -1 @ 0s` row next to the real run. After the grace window, `pid<=0` is treated as dead as before. See `lib/jobs/job-storage.ts:probeJobStatus`.

### Drain circuit breaker

`drainNextAgentRun` in `lib/agents/pending-agent-run.ts` has a per-project circuit breaker to prevent a fast-failing route (e.g. spawn `EBADF` after file-descriptor exhaustion) from churning the queue at ~50 runs/sec.

Behavior:
- Each 5xx response or fetch-level error increments a per-project, per-entry `consecutiveFailures` counter.
- After `MAX_CONSECUTIVE_FAILURES` (5) consecutive failures on the same queue head, the head is dropped and the breaker clears. A log warning is emitted.
- Between failure attempts, a 30-second `scheduleDrainRetry` timer fires instead of immediately retrying on the next lifecycle drain.
- Replacing a queue entry (same `agentId`, new `enqueuedAt`) resets the failure counter for that slot.
- A successful drain or a terminal 400/404/409 (non-transient) drops the head and clears the counter without tripping the breaker.

## Durable Agent Intake

All agent runs go through `runAgentIntakeWorkflow()` in `lib/agents/intake-workflow.ts`. There is no flag and no alternate path; the workflow owns prompt composition, optional prerequisite execution, retrieval/memory injection, and the spawn handoff. The function is declared with `'use workflow'` / `'use step'` directives and runs under the `workflow` runtime. TamTam pins the local workflow world by default (`WORKFLOW_TARGET_WORLD=local`, `WORKFLOW_LOCAL_DATA_DIR=data/workflow-data`), so persisted step state lives under `data/workflow-data` unless the process is explicitly configured for another workflow world. Completed steps are reused across transient crashes or server restarts instead of restarting the run from the beginning.

### Steps

**Step 1 — `runPrerequisiteStep`** (only when the agent has `prerequisiteCommand`): runs `bash -c <cmd>` in the project directory with cancellation support, captures stdout/stderr, and returns a `PrereqResult`. Cancelled prereqs short-circuit the workflow and mark the job done with exit 130.

**Step 2 — `composePromptStep`**: re-checks the release lock and (for non-readOnly runs) the project-busy gate after the prereq, composes skills + docs, captures a `git rev-parse HEAD` + `git status` baseline, loads agent memory for mutable runs, queries pgvector retrieval when `retrieval_enabled` is on, resolves the CLI binary + env, and builds the full prompt.

**Step 3 — `startAgentStep`**: writes the prereq artifact to disk, updates the job row with the composed `contextMeta` (which includes `workflow: true`), and calls `startJob()` to hand off to the spawned child. On failure it writes an error breadcrumb to the log file, marks the job done with `exitCode -1`, and rethrows so the workflow runtime can retry.

Everything after spawn — lifecycle hooks, SSE streaming, log tailing, completion detection, recommendation side effects — is unchanged.

### Per-Project Dev Server Lifecycle

Projects may store local, DB-only dev-server lifecycle fields on the `projects` row:

- `dev_server_start_command` — optional `bash -c` command run from the project root at agent kickoff.
- `dev_server_stop_command` — optional command run from the project root during cleanup before TamTam falls back to terminating the owned process group.
- `dev_server_ready_url` — optional HTTP(S) URL polled after startup until it returns a non-5xx response.

`startAgentStep` calls `ensureDevServerRunning()` before spawning the agent CLI when `dev_server_start_command` is set, after first checking that the agent job has not already been finalized by replay/boot recovery. The lifecycle is idempotent: a TamTam pidfile is reused only when the live PID still matches the recorded OS process-start identity (or the same TamTam process still has the child handle it spawned), and if `dev_server_ready_url` is already responding without a trusted pidfile, TamTam treats the server as externally owned and does not stop it later.

TamTam-owned state lives in `data/dev-servers/<project>.pid` with a sibling log file. Legacy, dead, or process-identity-mismatched pidfiles are removed without signaling their PID, so PID reuse cannot make TamTam kill an unrelated process group. Agent completion stops the server only when no release or other active agent-like work remains for that project. Release completion uses the shared release finalization hook, so normal completion, user aborts, first-step startup failures, direct phase finalizers, and direct `markDone(release, …)` paths all run the same cleanup. On boot, `sweepOrphanDevServers()` removes stale pidfiles and stops owned servers whose project has no active agent/release work.

### Response

The `/api/agents/{agentId}/run` success response always includes `via: "workflow"`:

```json
{
  "status": "started",
  "job_id": "job-…",
  "pid": 0,
  "via": "workflow",
  "agent": "My Agent"
}
```

`pid` is `0` because the route returns before the workflow step has spawned the child process; query `/api/jobs/<job_id>` later to get the actual PID.

### Setup

TamTam sets `WORKFLOW_TARGET_WORLD=local` when the variable is unset, and for the local world stores workflow runtime files in `WORKFLOW_LOCAL_DATA_DIR` or `data/workflow-data`. `scripts/pm2-start.sh`, `ecosystem.config.js`, and `next.config.ts` all preserve that default so PM2 restarts and production builds see the same runtime target. If operators intentionally switch to a Postgres-backed workflow world, they must provide the workflow runtime's Postgres setup and connection environment for that world; TamTam's main application data still uses `DATABASE_URL`.

The workflow world is started by `instrumentation-node.ts` at boot. If it fails to start or enqueue a run, agent runs return `500 { detail: "Workflow failed to enqueue: …" }`.

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
| `lib/scheduling/agent-scheduler.ts` | Schedule install/uninstall facade backed by graphile-worker |
| `lib/workflows/cron/seed-agent-crons.ts` | Boot-time schedule seeding and graphile-worker queue reconciliation |
| `lib/workflows/cron/agent-cron-task.ts` | Scheduled-agent fire handling, runtime gates, and next-fire re-enqueue |
| `components/AgentsTab.tsx` | UI for agent management |
| `instrumentation-node.ts` | Boot-time scheduler install + other Node-only startup work |

### Instrumentation edge-runtime constraint

Next.js compiles `instrumentation.ts` for **both** the Node and Edge runtimes. Anything the file imports — even transitively, and even through `await import(...)` — is traced into the Edge bundle. `lib/db` uses `path`, `fs`, and `pg`, none of which exist on Edge, so a direct import produces:

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

### Prompt composition order

```
[base_prompt from settings]
  + ## SkillName\nContent\n---  (for each skillId)
  + [task prompt from agent.prompt or run-time override]
```

### Verify a scheduled agent

```bash
# Inspect prompt-file and graphile-worker queue health
curl http://localhost:1337/api/agents/scheduler-health

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
| Schedule not firing | `prompt`/skills or `schedule` is empty, the graphile-worker queue row is missing, or the fire was intentionally skipped by runtime gates | Check `/api/agents/scheduler-health` for `missing`, `promptFileLoaded`, and `queueLoaded`; POST the endpoint to reinstall missing schedules |
| Scheduled fires being skipped with `lastSkippedReason: 'project paused'` | The project has its per-project pause toggle enabled. Fires are silently skipped until the project is resumed. May have been auto-set by a soak-phase failure (post-merge CI failed; see PIPELINE.md `soak` section and the most recent `tamtam-soak-*` job log to verify). Note: soak only pauses + reverts when `auto_fix_ci_on_red_default_branch` is **off** (or the auto-fix was bounded-out) — with it on (default), soak self-heals by dispatching `fix-ci` and does **not** pause. | Toggle off the pause via the project page or `PATCH /api/projects/by-project/[name]` with `{ paused: false }`. If the cause was a soak failure, review or land the auto-opened `revert/<sha>` PR first. Queued entries are retained and resume firing after unpause. |
| Scheduled fires being skipped with `dirty worktree: N files` | The project has at least as many uncommitted/untracked files as `dirty_worktree_block_threshold` (default 1). Agents won't run on top of a dirty worktree by default. | Commit, stash, or discard pending changes — or raise the threshold to allow small WIP (or set to 0 to disable) in Settings → Pipeline. |
| Skills not in Claude's context | `skillIds` references deleted skills | Re-check skill IDs; missing skills are silently skipped |
| Scheduler says the agent is missing | The prompt recovery file or graphile-worker queue row is missing | POST `/api/agents/scheduler-health` to reinstall missing schedules, then re-check the GET response |
| Agent runs but no output in UI | Job started but SSE not connected | Navigate to `/project/[name]/history`, open the run log |
| `schedule` change didn't take effect | The graphile-worker queue row was not refreshed yet | PATCH the agent again or POST `/api/agents/scheduler-health` to reinstall missing schedules, then confirm the agent is no longer listed in `missing` |
