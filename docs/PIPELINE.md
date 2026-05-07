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
- The shared start gate scores provider headroom using hard limit windows exposed by the CLI: 5-hour usage, 7-day usage, model-specific weekly windows where available, and provider credits. Scheduled agents also have a separate burn-rate throttle inside the internal scheduler.
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
  └─ exit ≠0 → completion hook → start FIX → re-run TEST (capped at 3 tests per release)
                                 → otherwise finalize release (exit 1)

REVIEW
  ├─ exit 0  → completion hook → extract verdict
  │   ├─ LGTM              → start PUSH
  │   ├─ NEEDS ATTENTION   → start FIX → re-run REVIEW (capped at 3 reviews per release)
  │   ├─ DO NOT SHIP       → start FIX → re-run REVIEW (capped at 3 reviews per release)
  │   └─ No verdict found  → finalize release (exit 1)
  └─ exit ≠0 → completion hook → finalize release (exit 1)

For working-tree reviews, TamTam scopes the prompt to the full non-`.tamtam`
working-tree diff computed before the model starts. That scope includes staged
tracked changes, unstaged tracked changes, and untracked files, so a manual
review or release review cannot silently skip code just because it is already
in the git index. Untracked-file previews are limited to repo-local regular
files; symlinks, sockets, directories, missing files, and unreadable files are
omitted instead of being read into the prompt. Successful working-tree reviews
still record a review stamp for the fresh-LGTM skip, but they do not mutate the
caller's git index. PR reviews do not update that local review stamp or the
incremental reviewed ref used to narrow later local-commit reviews.

Working-tree review prompts explicitly tell the reviewer that the pipeline owns test
execution. The reviewer should not run tests, audit which package test commands
are included, or cite passing/failing/skipped/partial suites as findings. Tests
are only review material when the code diff itself creates a concrete missing
coverage risk.

Working-tree reviewers are also told to resolve obvious documentation-only
findings during the review itself. If the only remaining issue is a clear docs
edit, the reviewer should apply that edit and return `LGTM` rather than forcing
a fix→review loop that spends another model call on the same documentation
change.

Project review prompts and PR review prompts both tell the reviewer to ignore
`.tamtam/` changes. Those files are TamTam scheduler/config metadata for the
tracked project, not product code, unless a review is explicitly about TamTam
configuration.

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
2. **Review mark**: If a working-tree `review` exits 0, call `markReviewed(project, path)` to store a commit-aware review fingerprint (`git status` + `HEAD` + upstream) used by the fresh-LGTM skip. PR-diff reviews (`sourceType: 'pr_review'`) do not update that local fingerprint or the incremental reviewed ref. On `LGTM` verdict from a working-tree review, also pin `refs/tamtam/reviewed/<branch>` to `HEAD` — the next pipeline review narrows its scope from `@{u}..HEAD` to `<ref>..HEAD` so already-approved commits aren't re-reviewed (gated by `incremental_review_enabled`, default on; falls back to full scope when the ref isn't an ancestor of HEAD, e.g. after a rebase).
3. **Review chaining**: If `review` exits 0 AND (in-release OR `auto_push_enabled`): LGTM → start PUSH; NEEDS ATTENTION / DO NOT SHIP → start FIX (within iteration cap), unless the new review repeats the previous findings or contradicts the most recent fix's `Status: fixed` claims for the same `Finding ID`s, in which case the release stops as non-converging.
4. **Fix chaining**: If `fix` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
5. **Test chaining**: If `test` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
6. **Push hook fix**: If `push` exits ≠0 and log matches hook rejection patterns: start FIX-PUSH (within attempt cap).
7. **Fix-push re-push**: If `fix-push` exits 0: start PUSH again.
8. **DoD (PR Workflow)**: If `push` exits 0 and `pr_workflow_enabled`: start MARK-DOD.
9. **PR merge wait (PR Workflow)**: If `mark-dod` completes and `auto_pr_merge_enabled`: start PR-MERGE-WAIT.
10. **Release finalization**: If a pipeline job ran but no chaining happened, write `# release finished — exit {code}` to meta-log and mark the release job done.
11. **Fix-CI auto-retry**: If `fix-ci` exits ≠0 within ~5 s of starting (boot crash): schedule retry after 500–3000 ms backoff. Capped at 2 retries within a 120-s window. These are hardcoded constants — not user-tunable.
12. **Review-exhaustion fallback**: If a **NEEDS ATTENTION** review→fix loop hits `review_fix_max_iterations`, repeats the same findings (`reviewIsStuck`), or the fixer claims a Finding ID was fixed but the reviewer still flags it (`fixContradictsReview`): file a `chore(review): finish review findings from release …` issue containing the unresolved Finding IDs, try to apply the canonical labels `tamtam` `review-followup` `priority-medium`, and skip any of those labels that do not exist in the repo, then chain to commit + push so the partial work ships. Falls back to the legacy abort if `gh issue create` fails. **DO NOT SHIP** reviews never use this path — they still stop the release before commit/push.

### Pending-release recovery

When a release trigger arrives while the project pipeline lock is held or jobs
are paused globally, TamTam stores `pending_release:<project>=1` in the
`settings` table instead of dropping the request.

That queued release is retried from three places:

1. `releaseLock()` after the active pipeline finishes
2. `syncJobsPauseState(false)` when the user resumes jobs
3. server boot or stale-lock self-heal, if a queued project is found with no
   active pipeline lock

Retry semantics matter: a drain attempt only consumes the queue when the
release actually starts or reaches a terminal no-op such as "nothing to
release". Temporary blocks such as the global pause, a fresh budget/credits
429, another active pipeline, or an indeterminate pre-start failure (for
example PM2/boot-time startup errors before the release job is created) keep
the pending flag in place so a later drain can retry safely. Once a release
job exists and the pipeline has actually started, later step failures consume
the queue normally because that release attempt is no longer pending.

### Queued agent recovery

When an agent run arrives while an active release holds the project lock,
TamTam returns `202 { status: 'queued', code: 'pipeline_lock' }` and stores the
fire in `queued_agent_runs`. If no release is currently running but the
project still has an older `pending_release:<project>` flag, TamTam first tries
to drain that release; if it remains queued, the agent returns
`202 { status: 'queued', code: 'pending_release' }` and is also stored in
`queued_agent_runs`. Unlike the in-memory `pending-agent-run` queue, this
DB-backed queue survives restart.

That queued agent is retried from these paths:

1. `releaseLock()` after the active pipeline finishes
2. `syncJobsPauseState(false)` when jobs resume from a global pause
3. budget recovery, when the hard 5-hour gate drops back under
   `budget_block_at_pct`
4. server boot
5. the periodic queued-agent recovery ticker

Retry semantics are conservative: successful starts and handoff to the
in-memory same-project agent queue consume the DB row; transient blocks such as
another active release lock, global pause, quota/provider 429s, 5xxs, or
timeouts leave the row in place for a later retry.

Recovery ordering is per-project: if the same project also has a
`pending_release:<project>` flag, TamTam drains that release first and only
starts or replays agent work after the pending release was cleared and no
pipeline lock was reacquired. This applies to DB-backed queued agents, the
in-memory same-project agent queue, and fresh `POST /api/agents/[agentId]/run`
requests, preserving the same "release before queued agents" order used by the
normal `releaseLock()` completion path.

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
| Review→Fix loop | unbounded fixes; configurable review verification rounds | per release; 30 min fallback for standalone chaining | `review_fix_max_iterations` (DB setting, default 3) governs the **review-side** verification budget only. Cap counts completed `review` runs, not fixes. On **NEEDS ATTENTION** review-side exhaustion (cap, stuck, fix-contradicts-review) TamTam files a follow-up issue and chains to commit+push (see step 12 above) instead of aborting. **DO NOT SHIP** review exhaustion still aborts before commit/push. |
| Test / Commit / Push safety cap | configurable via env | per release; 30 min fallback for standalone chaining | `TAMTAM_MAX_STEP_ITERATIONS` (legacy alias `TAMTAM_MAX_FIX_ITERATIONS`, default 3) still guards `test`, `commit`, and `push` verification loops. `TAMTAM_STEP_WINDOW_SECONDS=1800` (alias `TAMTAM_FIX_WINDOW_SECONDS`) controls the standalone fallback window. These caps still abort when exhausted. |
| Fix-Push attempts | 2 attempts | 30 min | hardcoded `MAX_FIX_PUSH_ATTEMPTS=2` |
| Fix-CI auto-retry | 2 attempts | 120 s | hardcoded constants in `lib/jobs/lifecycle.ts` (boot-crash recovery only — non-user-tunable since 2026-05) |
| Fix-CI fast-crash | — | — | hardcoded `5000` ms — only retries if job died in under this |

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

## Pipeline Strip

### Model: job-driven rendering

The strip renders **only the jobs that actually ran** in the current pipeline chain. There are no placeholder "pending" chips for steps that have not started yet. This means:

- A fresh pipeline with only a `test` job running shows a leading summary chip (`pipeline`, `test running`, `0/1`) followed by the `test` step chip.
- A pipeline that ran `test → review → fix` with `fix` still running shows three chips in chronological order.
- Steps that the pipeline bypassed (e.g. review/fix/commit on the short-circuit push path) are simply absent.

### Chain detection

The strip derives the current chain from persisted job linkage, not from timestamps:

1. Start with the currently-running pipeline job.
2. If that job has `release_id`, include every visible pipeline step with the same `release_id`.
3. If `release_id` is absent, walk `parent_job_id` upward:
   - if the chain reaches a `release` job, treat that release id as the chain key and include siblings that resolve to the same release ancestor
   - otherwise, show only the running job plus any visible pipeline ancestors directly linked by `parent_job_id`

Release scope is inherited from parentage, not ambient project state. A standalone manual `test` / `review` / `fix` started while some other release is active does not join that release chain unless it was launched from a release-linked parent job.

The `trace →` link is shown only when the visible chain resolves to an actual `release` job. Parent-only fallback chains stay on the terminal view because there is no release trace route to open.

The `abort` control is also release-scoped. It appears only while a real `release` job is still running, because the abort route stops the release lock and its current child step. Standalone `test` / `review` / `fix` chains remain inspectable in the strip but do not expose an abort button.

This keeps unrelated manual `test` / `review` / `fix` runs out of the strip even if they happened moments before an active release step on the same project.

### Visibility rule

The strip is visible whenever any pipeline-kind job (`test`, `review`, `fix`, `commit`, `push`, `mark-dod`) has `status='running'`. It disappears as soon as no pipeline job is running.

### Step chip states

The strip starts with a non-clickable summary chip. It mirrors the most salient state in the visible chain:

- running step present: summary reads `<step> running`
- warning step present with nothing running: summary reads `<step> needs attention`
- failed step present with nothing running: summary reads `<step> failed`
- otherwise: summary falls back to `<done>/<total> done`

The trailing counter in the summary chip always shows `<done>/<total>` for the currently visible steps.

| State | Visual | When |
|-------|--------|------|
| running | spinning ring, accent color | `job.status === 'running'` |
| done (✓) | green | `job.exit_code === 0` |
| attention (!) | yellow | review job with `verdict === 'NEEDS ATTENTION'` |
| failed (✗) | red | `job.exit_code !== 0`; review with `verdict === 'DO NOT SHIP'` |

The `mark-dod` kind maps to a `dod` chip label. All other kinds use their `job.kind` as the chip label directly.

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

### Per-project prompt addenda

Each project can define text appended to the standard review and fix prompts via the **Config** tab:

- **Review prompt addendum** — appended after `review_verdict_rules` under a `## Project-specific review guidance` heading. Use to tighten or loosen a single project's rigor without changing global settings.
- **Fix prompt addendum** — appended to the fix instructions under `## Project-specific fix guidance`. Use to constrain scope (e.g. "minimal diffs only") or signal patterns specific to this codebase.

Both are stored in the `projects` table (`review_prompt_addendum`, `fix_prompt_addendum`) and are DB-only — they do not sync to `.tamtam/config.yml`. Empty/whitespace-only values are a no-op.

The recommended **`agent:review-tuner`** built-in agent reads the last ~20 releases for a project (verdicts, fix iterations, durations) and proposes addenda edits in its run report; the user applies them in the Config tab.

### Tuning guidance

| Metric | What it tells you | Action |
|---|---|---|
| LGTM rate < 50% | Reviews consistently block — rules may be too strict | Loosen `review_verdict_rules` in Settings → Behavior, or add a per-project `review_prompt_addendum` in the project Config tab |
| Fix convergence low, hit-cap count high | Recovery loops cannot converge inside the configured review/test cap | Increase `TAMTAM_MAX_STEP_ITERATIONS` (legacy alias: `TAMTAM_MAX_FIX_ITERATIONS`) or adjust the review prompt |
| `review` p95 > 5 min | Review jobs are slow | Check model choice; consider switching to Haiku for review |
| Pipeline success < 80% | Releases failing frequently | Check step durations + History tab for the most recent failures |
| MTTR high | Long time from start to push | High `fix` median duration or many fix iterations — check fix loop stats |

### API

`GET /api/stats/pipeline?window=30d[&project=name]`

Returns `PipelineResponse` (see `app/api/stats/pipeline/route.ts` for full type). Cached 60 seconds per (window, project) pair.

Recovery-loop attribution prefers explicit `releaseId` links on `fix` / `fix-push` jobs. For historical rows or partially stamped data where `releaseId` is absent, the stats API falls back to the release's `[startedAt, finishedAt]` window so older dashboards do not silently lose recovery iterations.

The `configSnapshot` section reflects the same shared recovery-budget helper used by runtime enforcement:
- review/test cap: `TAMTAM_MAX_STEP_ITERATIONS` with legacy fallback to `TAMTAM_MAX_FIX_ITERATIONS`
- fallback window: `TAMTAM_STEP_WINDOW_SECONDS` (legacy alias: `TAMTAM_FIX_WINDOW_SECONDS`)
- fix-push cap: hardcoded `2`

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Pipeline stops after test with no next step | `auto_push_enabled` is off and no active Release | Use 🚀 Release button or enable `auto_push_enabled` |
| Review exits 0 but no verdict found | Verdict buried early in a long log | Check last 2000 chars of log; rephrase review prompt to emit verdict at the end |
| Fix loop runs 3 times then stops | Review/test verification cap reached within the configured fallback window | Fix manually, increase `TAMTAM_MAX_STEP_ITERATIONS` (legacy alias: `TAMTAM_MAX_FIX_ITERATIONS`), or wait for `TAMTAM_STEP_WINDOW_SECONDS` to reset |
| Push fails, no `fix-push` triggered | Hook strings not matched by `isHookRejection` | Check the push log for hook output; add new hook string patterns to `lib/start-fix-push.ts` |
| Release button grayed out / 400 | No changes and no unpushed commits | Make a change or verify `git status` |
| `DO NOT SHIP` verdict loops forever | Fix cap reached | Inspect fix logs; may need manual code changes |
| DoD step skipped | No linked GitHub issue on the run | DoD only runs when a `gh_issue_number` is set on the job |
| PR not created after push | `pr_workflow_enabled` is off, or not on a feature branch | Enable PR Workflow mode in project Config |
