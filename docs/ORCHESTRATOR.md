# Orchestrator

The orchestrator is the background loop that decides which agents get *extra*
runs ("boosts") within budget, and that watches agent output quality. It does
**not** run the release pipeline (that's `docs/PIPELINE.md`) and it does **not**
own the per-agent schedule cron (that's `docs/AGENT.md`). It is the layer that
turns spare quota + idle attention into useful agent work, and surfaces
**recommendations** when an agent needs operator attention.

## The tick loop

`lib/workflows/cron/orchestrator-tick-task.ts` runs on a graphile-worker
interval. Each tick:

1. Re-enqueues itself so the chain never dies (even when
   `orchestrator_enabled=false`, where it skips decision + dispatch).
2. Reads the global pace/budget bridge. The boost + health phases only run on a
   "safe" pace (`HEALTH_ANALYSIS_SAFE_PACE`); `will_exceed` / `exceeded` /
   `paused` / `unknown` skip the LLM/dispatch work so a tight budget can't
   over-spend.
3. Picks boost candidates and allocates extra runs (`lib/orchestrator/`:
   `boost-agent-loader.ts`, `budget-allocator.ts`). Unfruitful agents are
   **hard-excluded** from boosts here — see Fruitfulness below.
4. Runs agent **health analysis** (`lib/orchestrator/agent-health-analysis.ts`)
   over a few candidates, gated + throttled per agent.
5. Runs the **autopilot** (`lib/orchestrator/agent-autopilot.ts` decision +
   `apply-autopilot.ts` IO) over the same health outcomes — see below.

## Autopilot — role-based waste reclaim

The orchestrator detects low-value agents well but historically only *recommended*
action, so a churning agent burned tokens until an operator intervened. The
autopilot closes that loop, interpreting value by **agent role** (`lib/agents/roles.ts`).
Diff-count is a fine value proxy for a *producer* but a terrible one for a
*monitor* (a watchdog is most valuable when it finds nothing), so the lever is a
function of role:

| Role | Autopilot policy |
|------|------------------|
| `producer` | **Cadence-throttle** one ladder rung on either (a) a *sustained* `loop`/`noise` health verdict (`agent_autopilot_concern_streak`), or (b) **persistent low fruitfulness** — recent fruitful rate `< UNFRUITFUL_RATE_THRESHOLD` over `≥ UNFRUITFUL_MIN_SAMPLE` runs, which throttles on the first pass (the rate is already a sustained signal). A single fruitful run no longer rescues a chronically-unfruitful producer — recovery (and full cadence restore) requires the rate back at/above threshold *and* a clean verdict / fresh fruitful run. Floor-bounded (`agent_autopilot_cadence_floor`), never disabled. |
| `monitor` / `reviewer` / `planner` | **Model-downgrade** one tier (smart→normal→fast) after a sustained all-clear streak (`agent_autopilot_idle_streak`). Cadence is never touched (freshness). Tier restored the moment the agent finds something. Floor `agent_autopilot_tier_floor`. |
| `publisher` (and `kind=system`) | Untouched. |

It is driven off the health-analysis outcomes (so it inherits the ≤3-agents/tick
cap) and is **not** pace-gated — throttling/downgrading only *saves* budget.
Overrides live in `agents.autopilot_state`, kept separate from the operator's
configured `model`/`schedule`;
the cron handler resolves the effective values at each fire
(`agent-cron-task.ts`). Gated on `agent_autopilot_enabled` (default on) +
`orchestrator_enabled`. The monitor-safety guarantee is structural: the health
prompt classifies a quiet watchdog as healthy (idle-is-healthy), so it never
produces the `loop`/`noise` verdict that throttling requires.

## Initiative Engine — default-off autonomous chore discovery and dispatch

The orchestrator runs two additional phases (`mine`, `dispatch`) when
`initiative_engine_enabled` is true (default off). These phases add a
**grounded, autonomous layer** that discovers code-verifiable work (lint
errors, failing tests, TODOs, etc.) per project, maintains a backlog, and
automatically dispatches the top-priority item through the existing release
pipeline.

### Architecture

The **Miner** probes each project (`lib/orchestrator/initiative-probes.ts`):
`lint` (`pnpm lint`), `todo` (`git grep` of `lib|components|app|src` for
`.ts/.tsx` markers), `ui-coverage` (recently-added Next `app/api/**/route.ts`
with no client reference), `type-error` (`pnpm type-check`), `dep-bump`
(`pnpm outdated --format json`, aggregated into one finding), and `gh-issue`
(language-agnostic). The first five are TS/pnpm/Next-shaped, so non-Next/non-TS
repos surface little from them. `gh-issue` sources work through the **trusted
issue-ingestion gate only** — it calls
`GET /api/projects/by-project/[project]/issues?trusted_only=1`
(`filterTrustedIssues → isUserTrusted`), never raw `gh issue list`, and emits only
the **trusted-author** issue number + title (bodies/comments never enter the
prompt — "drop > wrap"; see `docs/SECURITY.md`). It is safe-by-default: with no
`trusted_github_users`/`safe_users` configured the gate returns nothing. Remaining
scored-but-unimplemented kinds (`failing-test`, `missing-test`, `docs-gap`) are
added incrementally. Findings upsert as `proposed` candidates; a promotion pass
admits them to `queued`, respecting the `initiative_max_backlog_per_project` cap.

The **Dispatcher** runs per-project, checks gates (`gatesClear`, `projectBusy`,
`maxShipsPerDay`), picks the top-scored queued initiative, and starts an
inline agent run carrying its prompt. The produced diff flows into the
existing release-after-run trigger, merging automatically if the release
succeeds. The initiative keeps the agent job as a temporary association until
release-after-run starts the release, then tracks the release meta-job; it is
marked `shipped` only after that release succeeds. Agent or release failure
marks it `failed` with a 6-hour cooldown to prevent thrashing.

**Scoring:** Each chore kind (lint, type-error, failing-test, todo, dep-bump,
docs-gap, etc.) has a base severity. Repeated failures decay the score by
`0.5^attempts` so stuck items naturally deprioritize.

**Per-project serialization** — only one initiative dispatches per project
per tick, reusing the existing `hasAgentStartSlot` gate. **Global gates** —
budgets and job-pause gates are respected; the dispatch phase skips when
gates do not clear.

**Operator steering** — each backlog initiative carries manual controls
(`PATCH /api/initiatives/[id]`): **promote** (👍) sets `pinned_at` on
`proposed`/`queued` rows, which sorts the row ahead of all unpinned queued rows
in both `listQueued` and the dispatcher's pick (pinned-first, then
`decayedScore`); **reject** (👎) moves a `proposed`/`queued` row to
`status='rejected'`, which the Miner never reopens (`'rejected'` is not a
refreshable status), with an **undo** that restores only rejected rows to
`queued` and clears the pin plus stale release/cooldown association fields.
Curation is independent of the global `initiative_dispatch_enabled` gate — it
orders what *would* ship once dispatch is on. Running and terminal rows are not
steerable from the UI/API, so manual curation cannot hide active release
tracking or requeue already shipped work. The controls live on the
**Initiatives** tab of the Recommendations page
(`/recommendations?tab=initiatives`); there is no separate top-level nav entry.

**Charter and PM layer** (per-project priority overrides, manual initiative
creation, SLA tracking) are deferred to Phase 2.

See `docs/PIPELINE.md` for how dispatched initiatives integrate into the
release pipeline, and `docs/superpowers/specs/2026-06-20-initiative-engine-design.md`
for the full Phase 1 design.

## Signals the orchestrator computes

- **Fruitfulness** (`lib/agents/fruitfulness.ts`): over the last N *scheduled*
  runs (manual/boost runs are excluded), did the agent change files / move
  lines? Below `UNFRUITFUL_RATE_THRESHOLD` over `UNFRUITFUL_MIN_SAMPLE` runs,
  the agent is **hard-excluded from boosts** (`budget-allocator.ts` — a bonus
  fire of an agent that produces nothing is pure waste; a project whose only
  eligible agents are unfruitful gets no boost), the autopilot **cadence-throttles
  it** (see the producer policy above), and an `agent_unfruitful` recommendation
  is written.
- **Project auto-pause** (`lib/orchestrator/unfruitful-pause.ts`, probe sweep):
  pauses a whole project when it is **caught up** (last `auto_pause_unfruitful_runs`
  scheduled runs all no-diff with ≥1 clean nothing-to-do run) **or** **persistently
  unfruitful** (line-level fruitful rate `< auto_pause_unfruitful_rate` over a wider
  sample — catches projects that re-touch files for *zero net line change*, which a
  files-or-lines metric counts as "fruitful" but produces nothing committable).
  Reversible from Settings; writes an `auto_pause_unfruitful` recommendation.
- **Per-agent saturation skip** (`lib/orchestrator/agent-saturation.ts`, agent-cron
  `prereqSkipReason`): the project auto-pause above only fires when the *whole*
  project is unfruitful, so a single agent whose target work is exhausted (e.g. a
  `refactor-ui` agent landing 0-line no-ops every run) keeps firing while the
  project stays active on its *other* still-fruitful agents. This gate skips that
  agent's scheduled fire when **this agent** is persistently unfruitful (line-level
  fruitful rate `< auto_pause_unfruitful_rate` over `unfruitfulRateSample(auto_pause_unfruitful_runs)`
  of its own scheduled runs) **and** HEAD is unchanged since it last ran. The HEAD
  gate is the release valve — any new commit re-enables one run, so it is never
  silenced permanently, just stops re-scanning an unchanged tree. Complements (not
  replaces) the autopilot **cadence-throttle** (which only *slows*, floor-bounded,
  never stops) and the operator-facing `agent_schedule_backoff` recommendation.
  Gated by `auto_pause_unfruitful_enabled`; system agents are exempt; the skip
  re-enqueues at the normal schedule interval so it re-checks next tick.
- **Health** (`agent-health-analysis.ts`): an LLM reviews the agent's last 3
  runs and returns a verdict (`concern` + `concernType` like loop/noise). On a
  concern it writes an `orchestrator_agent_health` recommendation; on a clean
  verdict it auto-resolves any open one (see Lifecycle). When *every* analyzed
  run is idle-by-design (no changes + a "no actionable work" summary, incl. the
  improve agent's `IMPROVE_QUEUE_ROTATED` sentinel, which the finalizer persists
  as a no-actionable-work summary), it short-circuits *before* the LLM call —
  retiring any open concern and skipping the spend — so a caught-up agent is
  never mislabeled loop/noise. Mixed windows still go to the LLM, with idle runs
  annotated and the prompt told that idle is healthy.

## Recommendations

Recommendations are the orchestrator's (and the agent finalizer's) way of
surfacing things worth attention. They live in the `recommendations` table
(`lib/recommendations/recommendations.ts`) and render on `/recommendations`.

### Types

| Type | Source | Meaning |
|------|--------|---------|
| `orchestrator_boost` | tick loop | The orchestrator already fired an extra run. Informational — created with status `resolved` so it lands directly in **History**, not the Unresolved queue (the action is already done at write time). |
| `agent_autopilot` | tick loop (autopilot) | The orchestrator already throttled a churning producer's cadence, downgraded an idle monitor's model tier, or restored either. AUTO + `resolved` at creation (same as boost). Payload `{ action, role, from, to, reason }`. |
| `agent_unfruitful` | agent finalizer (`lib/agents/agent-run-report.ts`) | Scheduled runs aren't producing changes. Payload `cause` disambiguates: `unproductive` (last run found work but landed nothing → improve the prompt) vs `unknown`. The `idle` case (last run reported no actionable work — incl. the improve agent's `IMPROVE_QUEUE_ROTATED` sentinel) does **not** raise this recommendation at all: idle-by-design is not a failure, so it's owned by `agent_schedule_backoff` and any stale unfruitful row is auto-retired. Boost deprioritization still happens live off the fruitfulness stats, independent of this row. The `/recommendations` card offers "Improve prompt" for `unproductive`/`unknown`. |
| `orchestrator_agent_health` | health analysis | An LLM flagged a loop/noise trend over recent runs. |
| `agent_schedule_backoff` | agent finalizer | A scheduled run found no actionable work; consider a slower cadence. |

### AUTO vs MANUAL — *who can resolve it*

This is the distinction the UI badge encodes. **It is about resolution
capability, not detection.** Everything below was *detected* automatically; the
question the badge answers is whether the **orchestrator can resolve it on its
own** or whether the **operator must act**.

- **AUTO** (green pill, no Fix menu): the orchestrator handles it end-to-end and
  there is nothing for you to do. **`orchestrator_boost`** (the extra run already
  fired) and **`agent_autopilot`** (cadence/model lever already moved, reversibly).
- **MANUAL** (amber pill, Fix menu): the orchestrator can *detect* it and will
  *auto-close the card* if the situation later recovers, but it cannot drive the
  fix itself. The operator (or a prompt/schedule change) must act:
  `agent_unfruitful`, `orchestrator_agent_health`, `agent_schedule_backoff`.

The sets live in `lib/client/projects.ts`
(`AUTO_RECOMMENDATION_TYPES` / `MANUAL_RECOMMENDATION_TYPES`,
`isAutoRecommendation` / `isManualRecommendation`). MANUAL cards offer Fix
actions: Run agent now, View logs, Run investigation, Decrease rate (throttle),
Stop boosting, Disable agent, Edit agent.

### Lifecycle and the resolved/unresolved split

A recommendation has a deterministic id per `(project, type, agent)`, so
re-detection upserts the same row rather than piling up duplicates. Status:

- `open` — needs attention. Shown in the **Unresolved** tab.
- `resolved` — **auto-retired by the orchestrator** when the triggering
  condition cleared (`resolveRecommendationIfOpen`): the unfruitful agent
  recovered, the schedule-backoff agent did real work, or the health verdict
  came back clean. Detectors call this on the same branch where they used to
  just return. AUTO `orchestrator_boost` rows are also written `resolved`
  **at creation** (via `upsertRecommendation`'s optional `status`) because the
  boosted run already fired — there is no open phase to clear.
- `dismissed` / `applied` — operator actions via the per-project PATCH route.

`resolved` / `dismissed` / `applied` are non-open and appear in the **History**
tab (`/api/recommendations?state=history` →
`listAllResolvedRecommendations()`), each tagged with how it left the queue
(`auto-resolved` / `dismissed` / `applied`). Auto-retirement never overrides an
operator decision — `resolveRecommendationIfOpen` only flips rows that are still
`open`.

So the two axes are independent:

- **Mode** (AUTO/MANUAL badge) — *can the orchestrator resolve it without you?*
- **State** (Unresolved vs History chip) — *has it been resolved yet, and how?*
