# Final Review — Initiative Engine Phase 1

**Verdict: CHANGES_REQUIRED**

One real correctness bug breaks the outcome-linkage in production (the jobId→outcome
mapping never resolves), plus a related "stuck running forever" gap. The safety rails
(default-OFF master switch, ships/day cap, gates, serialization, cooldowns) are
correctly wired and YAGNI discipline is good — but the outcome path must be fixed
before this can ship enabled.

---

## Critical

- **`lib/orchestrator/run-initiative.ts` (`defaultStartRun`) reads `json.jobId`, but `/api/agents/[agentId]/run` returns `job_id` (snake_case).** The user-agent branch (route.ts ~623-629) responds with `{ status, job_id, pid, agent, via }` — there is no `jobId` key. So `json.jobId` is `undefined`, the fallback `String(json.jobId ?? 'unknown')` yields the literal string `'unknown'`, and that string is stored as the initiative's `releaseId`. Reconcile then calls `getJob('unknown')` → `null` → outcome `'unknown'` → the initiative is **never marked shipped/failed and stays `running` forever** on every real dispatch. The entire reconcile/outcome path (concern #2) is non-functional via the production seam; only the unit tests (which inject a fake `startRun`) pass. Fix: read `json.job_id` (and accept `jobId` as a fallback if you want symmetry).

## Important

- **No backstop for `running` initiatives whose job lookup returns `unknown`** (`lib/orchestrator/initiative-reconcile.ts` + instrumentation `jobStatus`). When `getJob(jobId)` returns null — the `'unknown'`-jobId bug above, OR a legitimately pruned job row (retention deletes finished `jobs` after `job_row_retention_days`, default 180) — `jobStatus` returns `'unknown'` and the row is left untouched indefinitely. A permanently-`running` row is not safety-dangerous (it's excluded from `listQueued` and doesn't block dispatch), but it's a correctness leak: the row never resolves, and because `running` is not in `REFRESHABLE` (`initiatives-store.ts`), the same `dedupKey` can never be re-mined or re-shipped — that chore is silently lost forever. Add a max-age sweep (mark stale `running` as `failed` with cooldown) or treat `unknown` past an age threshold as failed.

## Minor

- **`instrumentation-node.ts` `initiativeEngineEnabled` uses `require('@/lib/shared/config')`** — the only `require()` in the file; every neighbor in the same deps object uses `await import(...)`. It works (callback must be sync and `getSettings` is sync + already-loaded), but it breaks the file's convention and leans on commonjs resolvability in the Next instrumentation context. Prefer capturing `getSettings` via the existing async-import pattern, or document why `require` is needed here.
- **Orphaned-run window in `dispatchTopInitiative`** (`initiative-dispatch.ts`): the instrumentation `runInitiative` closure starts the agent run, then calls `store.setStatus(..., { releaseId })`. If that second `setStatus` throws after the run already started, `dispatchTopInitiative`'s catch marks the row `failed` (+cooldown) while the agent keeps running with no recorded `releaseId`. Self-heals after cooldown; finite caps prevent looping. Low impact, worth a note.
- **`setStatus` bumpAttempts uses `sql\`…\` as unknown as number`** (`initiatives-store.ts`). Not `any`/`@ts-ignore`, and a standard Drizzle escape for raw fragments, so it satisfies the constraints — flagged only for awareness.

## Confirmed safe / no action

- **Default-OFF master switch gates all phases.** `orchestrator-tick-task.ts` runs mine+dispatch only inside `if (deps.initiativeEngineEnabled?.())`; `getSettings()` falls back to `DEFAULTS` (engine off) on a cold cache, so the safe direction is the default. Mining is independently gated by `initiative_mining_enabled` inside `mineInitiatives`.
- **Ships/day cap engages.** Instrumentation computes `shipsTodayCount` *after* reconcile (so today's freshly-shipped rows are counted) and passes it as `shipsToday`; `dispatchTopInitiative` blocks with `skipped: 'ships-cap'` when `maxShipsPerDay > 0 && shipsToday >= maxShipsPerDay`. `shipsTodayCount` counts `status='shipped'` rows with `updatedAt >= startOfUtcDay`.
- **Gates + serialization.** `gatesClear: () => runGates() === null` reuses the global pause/budget gate; `projectBusy: hasAgentStartSlot` reuses the per-project in-memory start slot. Dispatch checks both before flipping to `running`. Per-project loop = one dispatch attempt per project per tick.
- **No double-count.** running→shipped is a one-way transition; a shipped row drops out of `listByStatus(_, 'running')` next tick.
- **Dedup integrity.** `upsertCandidate` only refreshes rows in `REFRESHABLE = ['proposed','queued']`; shipped/failed/running/rejected/superseded are never downgraded by re-detection (test `does not resurrect a shipped row` covers this). `listQueued` filters cooldown (`cooldownUntil` null or ≤ now) and orders by score desc.
- **Failure cooldown.** Both the dispatch-time throw path and `markInitiativeOutcome('failed')` set a 6h cooldown; `decayedScore` halves per attempt so a flaky item can't monopolize the queue.
- **Phase-1 scope discipline (YAGNI).** No PM module, charter, UI, or webhooks shipped — all correctly deferred. `CHORE_SEVERITY` includes unused forward keys (`type-error`, `failing-test`, `gh-issue`, `missing-test`, `dep-bump`, `docs-gap`) but the spec explicitly leaves gaps for Phase 2; only lint+todo probes ship. No empty-assertion tests found; all assert meaningful behavior.
- **Acceptable Phase-1 limitations confirmed harmless:** "shipped" = agent-run completed exit 0 (the real merge still flows through the full gated release pipeline — `release-after-run.ts` — so calling it "shipped" early doesn't bypass any gate); a project with no enabled user agent throws a clear error in `defaultStartRun` and the per-project try/catch isolates it; only lint+TODO probes ship.
- **Migration + schema** match the inline test DDL and the `_journal.json` idx-25 entry is correctly appended after idx-24.

---

## Fixes applied

**Date:** 2026-06-20

### Finding 1 (Critical) — jobId key mismatch

- `lib/orchestrator/run-initiative.ts`: Added exported pure helper `extractJobId(json: unknown): string | null` that reads `o.job_id ?? o.jobId` (snake_case first, camelCase fallback) and returns `null` for null/non-object input. Replaced the buggy `json.jobId` extraction in `defaultStartRun` with `extractJobId(json)` plus a hard throw if the result is null.
- `__tests__/orchestrator/run-initiative.test.ts`: Added `extractJobId` import and a new `describe('extractJobId')` block with 4 tests: `{ job_id: 'j1' }` → `'j1'`; `{ jobId: 'j2' }` → `'j2'`; `{}` → `null`; `null` → `null`. Original 2 tests unchanged.

**Test result:** `pnpm test __tests__/orchestrator/run-initiative.test.ts` → 1 file passed, **6 tests passed**

### Finding 2 (Important) — stale `running` backstop

- `lib/orchestrator/initiative-reconcile.ts`: Extended `ReconcileDeps` with two optional fields `now?: () => number` and `staleMs?: number`. In the per-initiative loop: when `releaseId` is null and `isStale`, calls `markOutcome(row.id, 'failed', row.releaseId)` before `continue`; when `outcome === 'unknown'` and `isStale`, calls `markOutcome(row.id, 'failed', row.releaseId)`. Existing 6 tests pass unchanged (they pass no `staleMs`).
- `__tests__/orchestrator/initiative-reconcile.test.ts`: Added 3 new tests: `unknown` + stale → `markOutcome('failed', 'job-x')`; `unknown` + not stale → no call; `releaseId: null` + stale → `markOutcome('failed', null)`.

**Test result:** `pnpm test __tests__/orchestrator/initiative-reconcile.test.ts` → 1 file passed, **9 tests passed**

### Finding 2 wiring — backstop config in instrumentation

- `instrumentation-node.ts`: Added `now: () => Date.now()` and `staleMs: 2 * 60 * 60 * 1000` to the `reconcileRunningInitiatives` deps object. No other changes.

### Type-check and lint

- `pnpm type-check` → clean (no errors)
- `pnpm lint` → clean (no errors)
