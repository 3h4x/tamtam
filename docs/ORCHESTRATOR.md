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
   deprioritized here — see Fruitfulness below.
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
| `producer` | **Cadence-throttle** one ladder rung on a *sustained* `loop`/`noise` health verdict (`agent_autopilot_concern_streak`). Restored in full on a clean verdict or a fruitful run. Floor-bounded (`agent_autopilot_cadence_floor`), never disabled. |
| `monitor` / `reviewer` / `planner` | **Model-downgrade** one tier (smart→normal→fast) after a sustained all-clear streak (`agent_autopilot_idle_streak`). Cadence is never touched (freshness). Tier restored the moment the agent finds something. Floor `agent_autopilot_tier_floor`. |
| `publisher` (and `kind=system`) | Untouched. |

It is driven off the health-analysis outcomes (so it inherits the ≤3-agents/tick
cap) and is **not** pace-gated — throttling/downgrading only *saves* budget.
Overrides live in `agents.autopilot_state` (DB agents) or the file-agent override
(file agents), kept separate from the operator's configured `model`/`schedule`;
the cron handler resolves the effective values at each fire
(`agent-cron-task.ts`). Gated on `agent_autopilot_enabled` (default on) +
`orchestrator_enabled`. The monitor-safety guarantee is structural: the health
prompt classifies a quiet watchdog as healthy (idle-is-healthy), so it never
produces the `loop`/`noise` verdict that throttling requires.

## Signals the orchestrator computes

- **Fruitfulness** (`lib/agents/fruitfulness.ts`): over the last N *scheduled*
  runs (manual/boost runs are excluded), did the agent change files / move
  lines? Below `UNFRUITFUL_RATE_THRESHOLD` over `UNFRUITFUL_MIN_SAMPLE` runs,
  the agent is deprioritized for boosts (`budget-allocator.ts`) and an
  `agent_unfruitful` recommendation is written.
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
