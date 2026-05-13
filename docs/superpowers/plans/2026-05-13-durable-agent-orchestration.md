# Durable Agent Orchestration Evaluation

Date: 2026-05-13

Issue: #145

Decision: defer adoption of `workflow` for the first production durable-agent slice.

## Recommendation

TamTam should not adopt `workflow` as the immediate foundation for agent orchestration in its current deployment model.

The package is credible and increasingly capable, but the first durable slice would force one of these moves:

1. adopt Vercel-hosted workflow infrastructure, which does not match TamTam's PM2/self-hosted runtime, or
2. adopt a self-hosted Workflow "world", which today means adding PostgreSQL plus `graphile-worker`, or trusting a younger community SQLite/libSQL world.

That is a larger infrastructure change than the agent-orchestration problem alone justifies.

The right call today is:

- defer package adoption
- keep PM2 as the job execution boundary
- improve durability inside TamTam's existing SQLite-first architecture first
- revisit `workflow` only if TamTam is already moving to Postgres or to a formally supported SQLite-compatible world

## What TamTam Has Today

Current agent orchestration is split across a few focused mechanisms:

- `lib/scheduling/internal-scheduler.ts`
  - in-process scheduled fires
  - admission checks for project pause, global pause, budget gates, dirty worktree, issue-branch lock, and release lock
  - invokes `POST /api/agents/{id}/run`
- `app/api/agents/[agentId]/run/route.ts`
  - source of truth for agent start
  - resolves DB/file agents
  - enforces duplicate protection and queueing
  - creates the job row before long prerequisite work
  - writes prerequisite artifacts
  - composes prompt/docs/memory/retrieval
  - starts the PM2 one-shot runner
- `lib/agents/pending-agent-run.ts`
  - in-memory per-project queue for agent-vs-agent serialization
  - guards the route's start race with the synchronous start slot
- `lib/agents/queued-agent-runs.ts`
  - DB-backed queue when a release pipeline owns the project lock
  - survives restart
- `lib/jobs/pm2-jobs.ts`
  - keeps PM2 as the one-shot execution boundary
  - writes prompt/log artifacts
- `lib/jobs/lifecycle.ts`
  - completion hooks, verdict extraction, fix/review loops, recommendation side effects, and release chaining
- `instrumentation-node.ts`
  - restart recovery, probe sweeps, stale queued-run drains, and abandoned inline-job handling

This is not a single workflow engine. It is a set of narrow, practical coordinators around an existing CLI-job model.

## Audit: `workflow` vs TamTam

### Strengths

`workflow` directly targets problems TamTam cares about:

- durable pause/resume
- persisted execution state
- retries as code instead of scattered retry loops
- better step-level observability
- version pinning for long-running executions
- built-in support for long-running agent-style processes

If TamTam were designing orchestration from scratch around durable functions instead of PM2 one-shot jobs, this would be a serious candidate.

### Runtime fit

The fit is mixed, not clean.

#### Good fit

- Next.js support exists.
- The SDK supports self-hosting, not just Vercel.
- The startup hook model fits TamTam's existing `instrumentation.ts` / `instrumentation-node.ts` pattern.

#### Bad fit

- TamTam is SQLite-first.
- The production-ready self-hosted Workflow backend is `@workflow/world-postgres`, not SQLite.
- The local world is explicitly development-only and does not survive restart.
- The published SQLite-adjacent option listed in Workflow docs is `@workflow-worlds/turso`, a community package rather than a first-party, production-ready world.
- TamTam's durable unit today is not "a workflow step", it is "a PM2-managed CLI job with a log file, SSE tailing, and lifecycle hooks".

### Behavior fit by agent path

#### Scheduled fires

`workflow` could replace the in-memory timer plus replay logic eventually.

But today TamTam's scheduler does more than timing:

- budget throttling across providers
- project pause and global pause gates
- issue-branch skip logic
- dirty worktree skip logic
- release lock skip logic
- stable next-fire anchoring from prior successful runs

Those policies would still need to live in TamTam-specific code even if the timer primitive changed.

#### On-demand runs

The route contract is narrow and user-visible:

- `200 started`
- `202 queued`
- `409 already running` / `project busy`
- persistent `jobs` row and log path

`workflow` could model the pre-start orchestration, but it would not automatically preserve this contract. TamTam would need an adapter layer anyway.

#### Queued agent runs

TamTam has two distinct queues with different semantics:

- in-memory per-project agent serialization
- DB-backed release-lock queue

`workflow` could unify this eventually, but only if it becomes the owner of queue semantics. A partial adoption would still leave both queues in place.

#### Read-only CTO runs

This is the cleanest candidate for any future first slice because it skips worktree serialization and dirty-worktree gating.

That makes it the best path for experimentation, but not enough to justify the dependency and backend change by itself.

#### Prerequisite commands

TamTam persists prerequisite output to both:

- the main log stream
- a `.prereq.txt` artifact referenced in `contextMeta`

That side effect is tightly coupled to existing UI and log consumption. A workflow step can run the command, but TamTam still needs the artifact-writing and log-append behavior unchanged.

#### PM2 runner boundary

This is the biggest mismatch.

TamTam's actual agent work is a spawned CLI process owned by PM2, with:

- log files
- SSE tailing
- rerun support from saved prompt files
- lifecycle hooks that read completion from PM2/log state

Using `workflow` would not remove PM2 unless TamTam also rewrote streaming, job lifecycle, and cancellation around workflow-native execution.

If PM2 stays, Workflow mostly becomes a durable wrapper around "decide whether to spawn the same PM2 job".

#### Restart recovery

Workflow is strongest here in principle, but only if it owns the durable state machine end to end.

TamTam currently recovers by combining:

- persisted `jobs`
- persisted release-lock queue rows
- process probes
- scheduler reinstall
- periodic sweeps

If Workflow only wraps the intake path while PM2/lifecycle remain the true execution owner, restart recovery stays split across both systems.

## Supply-Chain Review

Reviewed on 2026-05-13.

### `workflow`

- package: `workflow`
- latest version: `4.2.4`
- last modified in npm metadata: 2026-05-12
- weekly downloads: 349,015 for 2026-05-06 through 2026-05-12
- license: Apache-2.0
- repository: `vercel/workflow`
- repository created: 2025-10-23
- GitHub stars at review time: 2,016
- dependencies: multi-package SDK stack including `@workflow/core`, `@workflow/next`, `@workflow/cli`, `@workflow/errors`, `@workflow/utils`
- install scripts: no package-install script surfaced in npm metadata for the root `workflow` package

Assessment:

- active and maintained
- backed by Vercel engineers, not an abandoned side project
- still young for a foundational orchestration dependency
- below TamTam's normal "prefer >1M weekly downloads" bar for new dependencies

That does not disqualify it, but it means adoption would need a stronger payoff than "this might simplify some queueing code".

### `@workflow/world-postgres`

- latest version: `4.1.1`
- last modified in npm metadata: 2026-05-11
- first-party package in the same Vercel repo
- hard dependencies include `pg`, `graphile-worker`, `drizzle-orm`, and `@vercel/queue`

Assessment:

- credible
- production-oriented
- operationally heavier than TamTam's current SQLite deployment
- would introduce a second database stack or force a broader storage migration

### `@workflow-worlds/turso`

- latest version: `0.2.2`
- last modified in npm metadata: 2026-02-09
- repository: `mizzle-dev/workflow-worlds`
- single listed maintainer
- depends on beta Workflow world packages

Assessment:

- interesting because it is SQLite/libSQL-adjacent
- too early for TamTam's first production orchestration slice
- not a safe default for a system that already depends on predictable restart recovery

## Why The Decision Is "Defer"

Adopting `workflow` now would add infrastructure complexity before it removes TamTam complexity.

Specifically:

1. TamTam would still keep PM2 jobs, log files, SSE streaming, and lifecycle hooks.
2. TamTam would still need its own project-specific policy checks and queue semantics.
3. The production-ready self-hosted backend requires PostgreSQL, which TamTam does not use.
4. The dev-only local world does not satisfy the restart-recovery requirement.
5. The SQLite-adjacent community world is not mature enough to anchor a first production slice.

That means the first real adoption would be "TamTam plus Workflow plus PM2 plus existing lifecycle", not "Workflow replaces the fragile parts".

That is the wrong order of operations.

## First Production Slice If We Revisit Later

If TamTam later adopts Postgres, or if a first-party SQLite/libSQL world becomes clearly production-grade, the first slice should be:

- feature flag: `durable_agent_workflows_enabled`
- scope: manual `readOnly: true` agent runs with no prerequisite command
- keep existing route: `POST /api/agents/[agentId]/run`
- keep existing `jobs` row shape, log paths, SSE endpoint, and response payloads
- keep PM2 as the execution boundary for the actual CLI run

### Why this slice

It avoids the riskiest current concerns:

- no worktree serialization
- no dirty-worktree block
- no prerequisite artifact handling
- no release-pipeline mutation work

But it still exercises the pieces we care about:

- durable acceptance of a run request
- persisted start state
- retry around transient start failures
- restart recovery for the intake path

### Shape of the slice

The workflow would own only the pre-start orchestration:

1. resolve the agent
2. enforce duplicate/run gate rules for the read-only path
3. create the `jobs` row immediately
4. compose prompt/context
5. call the existing PM2 `startJob()`
6. persist the started PID and return

After the PM2 process is started, TamTam's existing job lifecycle remains the owner of:

- log streaming
- status probes
- completion detection
- report parsing
- notifications

This would be a bounded experiment, not a full orchestrator replacement.

### Required invariants

- same HTTP response bodies as today
- same `job_id` semantics
- same log file layout
- same SSE consumer path
- same cancellation API behavior
- same lifecycle hooks after process start

## Minimal Migration Plan

Do this only after the storage/runtime precondition is solved.

### Phase 1

- add the feature flag
- implement a workflow-backed intake path for manual read-only runs without prerequisites
- shadow-write workflow diagnostics into `contextMeta`
- do not change the UI contract

### Phase 2

- expand to manual read-only runs with prerequisites
- define a durable artifact-writing contract for prerequisite output

### Phase 3

- expand to scheduled read-only runs
- compare workflow retries against existing scheduler replay behavior

### Phase 4

- evaluate replacing one queue at a time
- start with release-lock queue persistence, not PM2 execution

### Explicit non-goals for the first slice

- replacing PM2
- replacing SSE/log streaming
- replacing lifecycle completion hooks
- rewriting release orchestration
- migrating the entire scheduler to workflow timers

## Better Near-Term Work Without `workflow`

If the goal is durable orchestration sooner, the simpler path is to make the current architecture more durable inside SQLite:

- persist the per-project pending-agent queue instead of keeping it in memory
- unify queue drain retries and recovery sweeps under one persisted state model
- make "starting" a persisted state instead of only a process-local start slot
- keep PM2, job rows, logs, and SSE exactly as they are

That directly addresses TamTam's actual pain points without a new backend or orchestration runtime.

## Conclusion

`workflow` is promising, but it is not the simplest next step for TamTam.

For TamTam as it exists on 2026-05-13, adopting it now would mostly layer a second orchestration system on top of the current PM2/job/lifecycle model while also pushing the project toward new storage infrastructure.

Recommendation:

- defer adoption now
- tighten durability in the existing SQLite-first model first
- revisit `workflow` only alongside a deliberate runtime/storage change, with the first production slice limited to manual read-only agent starts behind a feature flag
