# Release Pipeline — How It Works

The pipeline is a quality-gated sequence driven by Claude. The exact steps depend on the **workflow mode** configured per project.

## Budget Gate

Before any run/release path starts work, TamTam performs one shared async gate:

1. Check the global jobs pause flag.
2. Resolve a CLI provider using the same multi-provider chooser the eventual run will use.

Implications:

- If `budget_block_runs_enabled` is off, the chooser still selects a provider but does not block on quota.
- If exactly one CLI is enabled and it is over `budget_block_at_pct`, the start is rejected with HTTP 429.
- If multiple CLIs are enabled, TamTam skips blocked providers and proceeds with the enabled provider that has the most remaining headroom.
- The shared start gate only considers the hard 5-hour window (and provider credits where available). The 7-day burn-rate throttle is enforced separately for scheduled agent fires inside the internal scheduler, not for manual buttons or root pipeline starts.
- Release/test/push entrypoints no longer rely on the legacy active-provider snapshot, so a full Claude window does not block a release when another enabled CLI is healthy.
- Once a release starts, the chosen provider is stamped onto the release/test/push jobs so downstream review/fix/commit steps inherit the same provider instead of repicking mid-pipeline.

## Workflow Modes

Each project has a mode selector in its Config tab:

| Mode | Push destination | Extra steps |
|------|-----------------|-------------|
| **Direct Branch** | Current branch, directly | — |
| **PR Workflow** | Feature/issue branch → pull request | `dod` → optional `merge` |

### Direct Branch

```
test → [fix loop] → review → [fix loop] → commit → push
```

Changes are committed and pushed straight to whatever branch is currently checked out. No pull request is created.

#### Direct Branch + issue-branch interaction

When a user clicks **Work on** for a GitHub issue, TamTam checks out a `fix/issue-<n>-<slug>` branch. In Direct Branch mode this creates a potential conflict with scheduled agents, which are expected to operate on the default branch. The following rules are enforced:

| Situation | Behavior |
|-----------|----------|
| Scheduled/manual **agent run** while on `fix/issue-*` in Direct Branch mode | **Refused (409)** — agent must not commit to the issue branch. Finish or abandon issue work first. |
| `startRelease` (🚀 Release button) while on `fix/issue-*` in Direct Branch mode | **Allowed** — user explicitly triggered it. After a successful push the working copy is automatically returned to the default branch. |
| `startRelease` while on any other non-default, non-issue branch in Direct Branch mode | **Refused (409)** — unexpected branch; switch to the default branch before releasing. |
| **Work on** (issue-branch checkout) while a pipeline is actively running | **Refused (409)** — switching branches mid-pipeline would corrupt the working copy. Wait for the pipeline to finish. |
| Successful push on `fix/issue-*` in Direct Branch mode | Working copy is automatically **returned to the default branch** (mirrors PR Workflow post-merge behavior). |

### PR Workflow

```
test → [fix loop] → review → [fix loop] → commit → push → dod → merge (optional)
```

Changes are pushed to the current feature/issue branch. A pull request is created (or updated) automatically. After push:

- **dod** — Claude verifies which acceptance-criteria checkboxes in the linked GitHub issue are actually implemented, then ticks the verified ones. Best-effort and non-fatal; the pipeline continues regardless.
- **merge** — if *Auto-merge PR* is enabled, TamTam polls CI checks and merges the PR once they pass. If disabled, the PR is left open for manual merge.

The `fix/issue-<n>-<slug>` branch is checked out automatically when opening a terminal run from an issue in the Issues tab. After a successful PR merge the working copy is returned to the default branch.

---

## When to read this

- Pipeline is stuck or not chaining to the next step
- Understanding why Release skipped straight to push (or stopped early)
- Configuring verdict rules or fix iteration limits
- Debugging why "LGTM" wasn't detected in a review log
- Setting up `auto_push_enabled` for continuous deployment

---

## State machine

### Direct Branch

```
startRelease()
  ├─ No changes + no unpushed commits → 400 error
  ├─ Fresh LGTM on current working-tree hash → skip to PUSH
  └─ Otherwise:
      ├─ testCommand configured → start TEST
      └─ No testCommand:
          ├─ Has uncommitted changes → start REVIEW
          └─ Only unpushed commits → start REVIEW against @{u}..HEAD

TEST
  ├─ exit 0  → completion hook → start REVIEW when uncommitted changes or unpushed commits exist
  │                              → otherwise start PUSH/no-op
  └─ exit ≠0 → completion hook → start FIX (if iterations < 3 per 30 min)
                                 → otherwise finalize release (exit 1)

REVIEW
  ├─ exit 0  → completion hook → extract verdict
  │   ├─ LGTM              → start PUSH
  │   ├─ NEEDS ATTENTION   → start FIX (if iterations < 3 per 30 min)
  │   ├─ DO NOT SHIP       → start FIX (if iterations < 3 per 30 min)
  │   └─ No verdict found  → finalize release (exit 1)
  └─ exit ≠0 → completion hook → finalize release (exit 1)

When a release enters a follow-up review after a fix, TamTam feeds the review job the
parsed output from earlier review/fix steps in the same release. Repeated structured
`Finding ID:` entries are treated as the same underlying issue even if the wording
changes, so the fix loop can stop when the review findings are not converging.
If the most recent successful fix explicitly claims `Status: fixed` for a
`Finding ID` that the follow-up review still flags, the release also stops:
TamTam treats reviewer/fixer disagreement on the same structured finding as a
non-converging loop instead of burning another fix iteration.

FIX
  ├─ exit 0  → completion hook → start REVIEW (loop)
  └─ exit ≠0 → completion hook → finalize release (exit 1)

PUSH
  ├─ exit 0  → completion hook → finalize release (exit 0)
  └─ exit ≠0 → completion hook
      ├─ isHookRejection(log) → start FIX-PUSH (if attempts < 2 per 30 min)
      └─ Not a hook error    → finalize release (exit 1)

FIX-PUSH
  ├─ exit 0  → completion hook → start PUSH (retry)
  └─ exit ≠0 → completion hook → finalize release (exit 1)
```

### PR Workflow (additional steps after PUSH succeeds)

```
PUSH exit 0
  └─ completion hook → start MARK-DOD

MARK-DOD
  ├─ exit 0  → completion hook
  │   ├─ auto_pr_merge_enabled → start PR-MERGE-WAIT
  │   └─ otherwise             → finalize release (exit 0)
  └─ exit ≠0 → finalize release (exit 0)  ← non-fatal, pipeline still succeeds

PR-MERGE-WAIT
  ├─ CI passes → merge PR → switch to default branch → finalize release (exit 0)
  └─ CI fails  → finalize release (exit 1)
```

The release meta-job (`kind='release'`) collects log sections from each step. Its own `finishedAt` is set when any step finalizes without chaining.

### History view — release grouping

In the per-project **History** tab, pipeline children (`test`, `review`, `fix`, `fix-push`, `commit`, `push`, `mark-dod`, `pr-wait`) are folded under their parent `release` row client-side. Grouping is a time-window match: a child whose `startedAt` falls inside a release's `[startedAt, finishedAt ?? ∞]` window attaches to that release. This is safe because the project-scoped `pipeline_locks` table guarantees only one release is active per project at a time, so no `parent_job_id` is needed. Clicking the parent row opens `/terminal?job=<release-id>`, which serves the **raw** aggregated log (not parsed stream-json) because the release log is a mix of plain text (test/commit/push output) and NDJSON (review/fix). See `components/ProjectRunsTab.tsx:groupReleaseChildren`, `components/TerminalTab.tsx:isClaudeJobKind` (deliberately excludes `release`), and `app/api/jobs/[jobId]/route.ts` (branches on `kind === 'release'` to return the raw log).

---

## Completion hooks (`runCompletionHooks`)

Called by `markDone()` after every job finishes. Hooks run in order:

1. **Release meta-log**: For pipeline jobs, if an active release exists for the project, append a log section.
2. **Review mark**: If `review` exits 0, call `markReviewed(project, path)` to store a commit-aware review fingerprint (`git status` + `HEAD` + upstream) used by the fresh-LGTM skip.
3. **Review chaining**: If `review` exits 0 AND (in-release OR `auto_push_enabled`): LGTM → start PUSH; NEEDS ATTENTION / DO NOT SHIP → start FIX (within iteration cap), unless the new review repeats the previous findings or contradicts the most recent fix's `Status: fixed` claims for the same `Finding ID`s, in which case the release stops as non-converging.
4. **Fix chaining**: If `fix` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
5. **Test chaining**: If `test` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
6. **Push hook fix**: If `push` exits ≠0 and log matches hook rejection patterns: start FIX-PUSH (within attempt cap).
7. **Fix-push re-push**: If `fix-push` exits 0: start PUSH again.
8. **DoD (PR Workflow)**: If `push` exits 0 and `pr_workflow_enabled`: start MARK-DOD.
9. **PR merge wait (PR Workflow)**: If `mark-dod` completes and `auto_pr_merge_enabled`: start PR-MERGE-WAIT.
10. **Release finalization**: If a pipeline job ran but no chaining happened, write `# release finished — exit {code}` to meta-log and mark the release job done.
11. **Fix-CI auto-retry**: If `fix-ci` exits ≠0 and duration < `fix_ci_fast_crash_ms`: schedule retry after 500–3000ms backoff.

---

## Verdict detection (`getVerdict`)

Reads the **last 2000 chars** of the review job log. Returns `'LGTM'` | `'NEEDS ATTENTION'` | `'DO NOT SHIP'` | `null`.

**Priority 1 — multi-line form**:
```
[Vv]erdict[^A-Za-z]{1,80}?(LGTM|NEEDS ATTENTION|DO NOT SHIP)
```
Matches "Verdict" followed by up to 80 chars of whitespace/punctuation, then the token. Rejects if `/` immediately follows (guards against the prompt's own enum listing).

**Priority 2 — bare line form** (last 5 lines, fallback):
```
^[*_`]*(LGTM|NEEDS ATTENTION|DO NOT SHIP)[*_`]*(\s*[-–—:]|\s*$)
```
Accepts markdown wrapping (`**LGTM**`, `` `LGTM` ``) and optional colon/dash delimiter. Rejects `LGTM / NEEDS ATTENTION / DO NOT SHIP` (disambiguation list).

---

## Retry and iteration caps

| Cap | Limit | Window | Setting |
|-----|-------|--------|---------|
| Review→Fix loop | unbounded fixes; 3 verification iterations cap | per release; 30 min fallback for standalone chaining | `TAMTAM_MAX_FIX_ITERATIONS` (default 3), `FIX_WINDOW_SECONDS=1800`. Every NEEDS ATTENTION/DO NOT SHIP review or red test triggers a fix; the cap fires on the *next* verification step (fix→test, fix→review). After the budget is exhausted the trailing fix still runs unverified and the release stops without re-running test/review. |
| Fix-Push attempts | 2 attempts | 30 min | hardcoded `MAX_FIX_PUSH_ATTEMPTS=2` |
| Fix-CI auto-retry | configurable | configurable | `fix_ci_max_retries` (default 2), `fix_ci_retry_window_seconds` (default 120) |
| Fix-CI fast-crash | — | — | `fix_ci_fast_crash_ms` (default 5000ms) — only retries if job died in under this |

---

## Per-project pipeline flags

All stored in the `projects` DB table; editable via the project Config tab.

| Flag | Default | Description |
|------|---------|-------------|
| `auto_commit_enabled` | off | On LGTM, stage + commit automatically |
| `auto_push_enabled` | off | Push after auto-commit; also enables review→fix→push chaining for standalone review runs |
| `pr_workflow_enabled` | off | Use PR Workflow mode — push to feature branch, run DoD, optionally merge |
| `auto_pr_merge_enabled` | off | After DoD, poll CI and auto-merge the PR *(PR Workflow only)* |
| `release_after_run` | off | Trigger the full pipeline automatically after each successful agent/terminal run |

When `auto_push_enabled` is **off**: pipeline chaining only happens during an active Release run.
When `auto_push_enabled` is **on**: the same review→fix→push chaining happens for any standalone review job on that project.

---

## Hook rejection detection (`isHookRejection`)

Checks the push job log for strings from husky, lint-staged, eslint, pre-commit hooks, and pre-push hooks. If matched, the push failure triggers `fix-push` instead of a hard release failure.

---

## Helper entry points

| File | Function | Purpose |
|------|----------|---------|
| `lib/start-release.ts` | `startRelease(project)` | Pipeline entry point; creates meta-job, picks first step |
| `lib/start-review.ts` | `startProjectReview(project)` | Spawns review Claude job via PM2 |
| `lib/start-fix.ts` | `startFixFromJob(reviewJob)` | Resumes review session for fix, or starts fresh |
| `lib/start-test.ts` | `startProjectTest(project)` | Detects and runs test command |
| `lib/start-push.ts` | `startProjectPush(project)` | git add → commit message → push |
| `lib/start-fix-push.ts` | `startFixPush(project, log)` | Provides hook error context to Claude for fix |
| `lib/start-mark-dod.ts` | `startMarkDod(project)` | DoD verification + GitHub issue checkbox update *(PR Workflow)* |
| `lib/job-storage.ts` | `markDone(jobId, exitCode)` | Called by PM2 exit handler; triggers all completion hooks |

---

## Quick Reference

### Which entry point to use

| Goal | Use |
|------|-----|
| Full quality-gated release | `startRelease(project)` — or 🚀 Release button |
| Just review uncommitted changes | `startProjectReview(project)` |
| Fix issues from a previous review | `startFixFromJob(reviewJob)` |
| Run tests only | `startProjectTest(project)` |
| Commit + push only | `startProjectPush(project)` |
| Auto-chain on every review | Set `auto_push_enabled = true` on the project |

### Pipeline short-circuit conditions

| Condition | Result |
|-----------|--------|
| No uncommitted changes + no unpushed commits | 400 error — nothing to release |
| Fresh LGTM exists for current working-tree hash | Skip review+fix, go straight to PUSH |
| No `testCommand` configured, only unpushed commits | Review committed diff against `@{u}..HEAD` before push |

### Verdict detection cheat sheet

| Review output format | Detected? |
|----------------------|-----------|
| `Verdict: LGTM` | ✓ |
| `## Verdict\n**LGTM**` | ✓ |
| `` `LGTM` `` on last line | ✓ |
| `LGTM / NEEDS ATTENTION / DO NOT SHIP` (disambiguation list) | ✗ intentionally rejected |
| Verdict in first 80% of log only | ✗ reads last 2000 chars only |

---

## Pipeline Strip — Desired UX & Scoped Fix

### The problem

The strip currently shows misleading state when a **standalone test** runs on a clean repo:

```
test ✓  →  review ✓  →  commit ✓  →  push ✓
```

`commitState` and `pushState` are derived from git cleanliness (`hasChanges`, `unpushed`), not from actual job runs. On a repo with nothing uncommitted/unpushed, those steps are always green — even if the user just ran `test` in isolation and no release pipeline was ever triggered.

### Rule: strip is release-scoped

The pipeline strip should only reflect an **active or recently-completed Release run**. Standalone test/review/fix runs (not triggered by 🚀 Release) must **not** surface the strip.

### Desired step states

| Step | Shows as ✓ when | Shows as ○ (pending) when | Shows as ✗ when |
|------|-----------------|---------------------------|-----------------|
| **test** | test job in this release exited 0 | no test command, or not yet run | exit ≠ 0 |
| **review** | review job in this release has verdict `LGTM` | not yet run | exit ≠ 0 or verdict ≠ LGTM |
| **commit** | push job in this release exited 0 (commit is part of push) | not yet run | `last_push_error` starts with "Commit failed" |
| **push** | push job in this release exited 0 | not yet run | push job exit ≠ 0 |
| **dod** *(PR Workflow)* | mark-dod job exited 0 | not yet run | exit ≠ 0 |
| **merge** *(PR Workflow, auto-merge on)* | PR merged successfully | not yet run | CI failed or merge rejected |

### Visibility rule

Show the strip **only** when:
1. There is an active release job (`kind='release'`, `status='running'`) for this project, **or**
2. There is a release job that completed within the last hour

Hide it otherwise.

---

## Metrics

The `/pipeline` page (accessible from the main nav or via the **Pipeline** button on any project page) aggregates historical job data to answer operational questions about the release pipeline.

### Available metrics

| Metric | Description |
|---|---|
| **Pipeline success rate** | % of `release` jobs that finished with exit 0 |
| **Review LGTM rate** | % of completed `review` jobs with a `LGTM` verdict |
| **Fix loop convergence** | % of releases-with-fixes that eventually succeeded; "hit cap" = 3 fix jobs within 30 min without LGTM |
| **Median release time** | p50 wall-clock time from `release` start to finish (successful releases only) |
| **Step durations** | Median and p95 for each pipeline step: `test`, `review`, `fix`, `commit`, `push`, `fix-push`, `mark-dod` |
| **Verdict distribution** | Stacked breakdown of LGTM / NEEDS ATTENTION / DO NOT SHIP / parse-failed across all reviews |

All metrics support a **24h / 7d / 30d / all-time** filter.

### Per-project drill-down

The global `/pipeline` view shows all projects in a summary table. Clicking a project name (or using the **Pipeline** button on a project page) opens `/pipeline?project=<name>` — the same page scoped to that project's jobs only.

### Tuning guidance

| Metric | What it tells you | Action |
|---|---|---|
| LGTM rate < 50% | Reviews consistently block — rules may be too strict | Loosen `review_verdict_rules` in Settings → Behavior |
| Fix convergence low, hit-cap count high | Fix loop can't resolve issues within 3 iterations | Increase `TAMTAM_MAX_FIX_ITERATIONS` env var or adjust the review prompt |
| `review` p95 > 5 min | Review jobs are slow | Check model choice; consider switching to Haiku for review |
| Pipeline success < 80% | Releases failing frequently | Check step durations + History tab for the most recent failures |
| MTTR high | Long time from start to push | High `fix` median duration or many fix iterations — check fix loop stats |

### API

`GET /api/stats/pipeline?window=30d[&project=name]`

Returns `PipelineResponse` (see `app/api/stats/pipeline/route.ts` for full type). Cached 60 seconds per (window, project) pair.

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Pipeline stops after test with no next step | `auto_push_enabled` is off and no active Release | Use 🚀 Release button or enable `auto_push_enabled` |
| Review exits 0 but no verdict found | Verdict buried early in a long log | Check last 2000 chars of log; rephrase review prompt to emit verdict at the end |
| Fix loop runs 3 times then stops | `MAX_FIX_ITERATIONS=3` cap reached within 30 min | Fix manually or wait 30 min for window to reset |
| Push fails, no `fix-push` triggered | Hook strings not matched by `isHookRejection` | Check the push log for hook output; add new hook string patterns to `lib/start-fix-push.ts` |
| Release button grayed out / 400 | No changes and no unpushed commits | Make a change or verify `git status` |
| `DO NOT SHIP` verdict loops forever | Fix cap reached | Inspect fix logs; may need manual code changes |
| DoD step skipped | No linked GitHub issue on the run | DoD only runs when a `gh_issue_number` is set on the job |
| PR not created after push | `pr_workflow_enabled` is off, or not on a feature branch | Enable PR Workflow mode in project Config |
