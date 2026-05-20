# Release Pipeline — How It Works

The pipeline is a quality-gated sequence driven by the selected provider. The registry is unified per project: `test → review → fix → commit → push → dod → merge → soak`.

`soak` is opt-in: when the project's `post_merge_watch_minutes` is `0` (the default), the chain still ends at `merge` and the release is finalised. When it is positive (any value enables soak — the integer is no longer a duration cap), TamTam polls the default branch's CI on the merge commit until it terminates:

- **All checks pass** → soak exits 0, release finalises, project unlocks normally.
- **Any check fails** → soak pauses the project (`projects.paused = true` — admission gates reject new agent runs until a human resumes from Settings) and opens a revert PR. `auto_revert_enabled` controls whether the revert PR is auto-merged or left open for review.
- **No CI runs ever appear on the merge commit** → after a 90s grace period, soak treats this as "no default-branch CI configured" and passes.
- **CI stays pending forever** → soak keeps polling. There is no upper time cap. If a workflow is genuinely stuck, operators can cancel the soak job via `DELETE /api/jobs/<soak-job-id>` and resume the project manually.

## Auto-fix policy (requirements)

TamTam's release pipeline owns end-to-end recovery: when any pipeline step
fails, the same release should attempt to fix the failure automatically
before declaring the release dead. This is the contract:

| Step that failed | Recovery step | Re-verification | Cap                                  |
|------------------|---------------|-----------------|--------------------------------------|
| `test` exit ≠ 0  | `fix` (sees test log) | re-run `test` | `TAMTAM_MAX_STEP_ITERATIONS` (default 3) |
| `review` not LGTM | `fix` (sees review findings) | re-run `review` | `review_fix_max_iterations` |
| `commit` exit ≠ 0 | `fix` (sees commit log) | re-run `commit` | `TAMTAM_MAX_STEP_ITERATIONS` |
| `push` exit ≠ 0  | `fix` (reads hook log; bails if pre-push tests failed, branch protection blocks the direct push, or the remote moved and the push step could not recover) | re-run `push` | `getPushFixAttemptCap()=2` for hook-rejection fix; `TAMTAM_MAX_STEP_ITERATIONS` for review-driven push recovery |

Rules that hold for every recovery loop:

- **Fixes are unbounded.** The cap lives on the verification side: bail
  before launching the *(MAX+1)*-th `test` / `review` / `commit` / `push`,
  not before launching another `fix`. This guarantees that the trailing
  fix always lands; what we lose is *one* round of verification.
- **A hook that errors mid-flight must NOT leave the release in `running`.**
  For workflow-driven releases (the default), the orchestrator
  `finalizeReleaseStep` writes the terminal exit code on the meta-job when
  it sees a terminal dispatch decision. For standalone (no-`releaseId`)
  pipeline steps that still flow through the legacy chain, failure paths
  set `forcedReleaseExitCode = 1` and `markDone` wraps `runCompletionHooks`
  in a try/catch.
- **Recovery never silently skips a verification step.** When a recovery
  fix succeeds, the next call MUST be the verification step that
  originally failed (re-test after test-fail, re-review after
  needs-attention, re-commit after commit-fail, re-push after push-fail).
- **Review and non-review loops use different caps.**
  `review_fix_max_iterations` governs only the review→fix verification
  budget. It defaults to `3`; set it to `0` only when the review loop
  should run until LGTM or the release wall-clock timeout. Test/commit/push
  verification rounds use the shared `TAMTAM_MAX_STEP_ITERATIONS` env guard;
  the push-fix retry (when a pre-push hook rejects with lint/type nits) has
  its own hard cap (`getPushFixAttemptCap()=2`, counted as `fix` jobs whose
  parent is a `push` in the same release). When the cap trips on review-side
  exhaustion, the orchestrator's `finalizeReleaseStep` files a follow-up
  GitHub issue with the unresolved findings via `fileReviewExhaustionIssue`
  and continues to commit + push so partial work ships. Test/commit/push caps
  abort without filing an issue.
- **Remote push failures do not enter the code-edit fix loop.** `start-push`
  auto-rebases and retries concrete stale-remote cases such as
  non-fast-forward, fetch-first, and ref-lock races. If a push still fails
  because the remote moved, or because branch protection requires a PR or
  status check, the release stops with a clear push-blocked reason instead of
  spawning a fix job.

Implementation lives in two places: workflow-driven release-linked
flows go through `lib/workflows/release-orchestrator.ts` (`decideStep` →
`applyReleaseGuards` → `dispatchStep`), with the guards under
`lib/workflows/guards/`. Standalone (no-`releaseId`) pipeline steps fall
through the legacy `lib/jobs/lifecycle.ts` `runCompletionHooks` chain.
Any new pipeline step kind added to `PIPELINE_STEP_KINDS` must wire its
failure path into one of these recovery loops or document why it is
exempt.

## Budget Gate

Before any run/release path starts work, TamTam performs one shared async gate:

1. Check the global jobs pause flag.
2. Resolve a CLI provider using the same multi-provider chooser the eventual run will use.

Implications:

- If `budget_block_runs_enabled` is off, the chooser still selects a provider but does not block on quota.
- If exactly one CLI is enabled and it is over `budget_block_at_pct`, the start is rejected with HTTP 429.
- If multiple CLIs are enabled, TamTam skips blocked providers and proceeds with the enabled provider that has the most remaining headroom.
- The shared start gate blocks on 5-hour usage and provider credits. When `budget_block_on_weekly_pace_enabled` is true, it also blocks on actual 7-day utilization; 7-day and model-specific weekly windows still influence provider headroom scoring. Scheduled agents also have a separate burn-rate throttle inside the internal scheduler.
- Release/test/push entrypoints no longer rely on the legacy active-provider snapshot, so a full Claude window does not block a release when another enabled CLI is healthy.
- Once a release starts, the chosen provider is stamped onto the release/test/push jobs so downstream review/fix/commit steps inherit the same provider instead of repicking mid-pipeline.

## Branch-derived PR behavior

There is no longer a per-project pipeline mode selector. Push behavior is decided at runtime:

| Working-copy branch | Push behavior | Downstream steps |
|---------------------|---------------|------------------|
| Default branch | Push directly to the current branch | `dod` runs only when the release is issue-linked; `merge` is skipped |
| Any non-default branch | Push current branch and open or reuse a PR | `dod` runs for issue-linked releases and for generic PR-backed pushes when auto-merge is off; `merge` runs when auto-merge is enabled |

`fix/issue-<n>-<slug>` branches are first-class release branches. They no longer auto-return to the default branch after push; the working copy returns to the default branch after PR merge.

### `decidePrContext`

`lib/pipeline/pr-context.ts` resolves:

- `currentBranch` via `git branch --show-current`
- `defaultBranch` via `detectMainBranch(projectPath)`
- `shouldOpenPr` via `currentBranch !== defaultBranch`

`start-push.ts` uses this helper for non-issue releases. Issue-linked pushes still always create an issue PR.

---

## When to read this

- Pipeline is stuck or not chaining to the next step
- Understanding why Release skipped straight to push (or stopped early)
- Configuring verdict rules or fix iteration limits
- Debugging why "LGTM" wasn't detected in a review log
- Setting up `auto_push_enabled` for continuous deployment

---

## State machine

### Unified pipeline

```
startRelease()
  ├─ No changes + no unpushed commits → 400 error
  ├─ Fresh LGTM on current working-tree hash → skip to PUSH
  └─ Otherwise:
      ├─ testCommand configured → start TEST
      └─ No testCommand:
          ├─ Has uncommitted changes → start REVIEW, or COMMIT when review_disabled is on
          └─ Only unpushed commits → start REVIEW against @{u}..HEAD, or PUSH when review_disabled is on

TEST
  ├─ exit 0  → completion hook → start REVIEW when uncommitted changes or unpushed commits exist
  │                              → when review_disabled is on: COMMIT for uncommitted changes, PUSH for unpushed commits
  │                              → otherwise start PUSH/no-op
  └─ exit ≠0 → completion hook → start FIX → re-run TEST (capped at 3 tests per release)
                                 → otherwise finalize release (exit 1)

REVIEW
  ├─ exit 0  → completion hook → extract verdict
  │   ├─ LGTM              → start PUSH
  │   ├─ NEEDS ATTENTION   → start FIX → re-run REVIEW (default cap: 3 reviews per release; 0 = unlimited)
  │   ├─ DO NOT SHIP       → policy from `review_do_not_ship_action`:
  │   │                       `fix` (default)  → start FIX → re-run REVIEW (cap-bounded)
  │   │                       `pass`           → file follow-up issue → start COMMIT
  │   │                       `abort`          → finalize release (exit 1)
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
  ├─ exit 0  → completion hook → start MARK-DOD when issue-linked, or when a generic push produced a PR and auto-merge is off
  │                              → start PR-MERGE-WAIT when a push produced a PR and auto-merge is on
  │                              → otherwise finalize release (exit 0)
  └─ exit ≠0 → completion hook
      ├─ isHookRejection(log) → start FIX-PUSH (if attempts < 2 per 30 min)
      └─ Not a hook error    → finalize release (exit 1)

FIX-PUSH
  ├─ exit 0  → completion hook → start PUSH (retry)
  └─ exit ≠0 → completion hook → finalize release (exit 1)
```

MARK-DOD
  ├─ auto_pr_merge_enabled + PR context → start PR-MERGE-WAIT
  └─ otherwise                          → finalize release (exit 0)

`mark-dod` is non-fatal: its exit code is ignored for phase routing because
its job is to tick acceptance-criteria checkboxes after the push has already
landed. If auto-merge is enabled and the push produced or reused a PR, TamTam
still continues into `pr-wait` even when `mark-dod` exits nonzero.

PR-MERGE-WAIT
  ├─ CI passes → merge PR → switch to default branch
  │              ├─ project has post_merge_watch_minutes > 0 → start SOAK
  │              └─ otherwise                                 → finalize release (exit 0)
  └─ CI fails  → seed failed CI URL → dispatch fix-ci → finalize release (exit 1)

SOAK
  ├─ default-branch CI on merge sha passes within window → finalize release (exit 0)
  ├─ default-branch CI on merge sha fails within window  → open revert PR
  │     ├─ auto_revert_enabled → enable squash auto-merge on the revert PR
  │     └─ otherwise           → leave revert PR open for review
  │     emit `post_merge_revert` notification (success | failure)
  │     finalize release (exit 1)
  └─ window elapsed with no failures → finalize release (exit 0)

`pr-wait` polls the PR immediately, then every 30 seconds by default. When
GitHub reports an empty `statusCheckRollup`, TamTam does not treat that as "no
CI configured" right away: it preserves a 90-second grace window before merging
so a freshly opened PR has time to register workflow runs. The PR must also be
`mergeable=MERGEABLE`; `mergeable=UNKNOWN` keeps waiting because GitHub can
still flip that state to `CONFLICTING` on a later poll.

`pr-wait` is resumable across server restarts. The job row persists
`{ prNumber, prRepo, prUrl }` in `contextMeta`; on boot, unfinished `pr-wait`
rows are resumed against the existing job/log instead of being reaped like
other abandoned inline jobs. `mark-dod` remains non-resumable and is still
marked failed if a restart interrupts it.

When `pr-wait` observes failed PR checks, it stores the failed check URL in
`gh_status.ci_failed_url` and dispatches `fix-ci` for the project before
finalizing the `pr-wait` step. The `fix-ci` job then uses its normal completion
hook to start a fresh release after a successful CI fix, so the pipeline can
continue toward merge. If no failed check URL can be resolved from GitHub's
`statusCheckRollup`, the `fix-ci` endpoint reports the missing URL and the
release remains failed for manual follow-up.

Boot recovery also heals stranded `release` rows. If the server dies before
the first child step starts, TamTam reaps the orphaned release directly. If a
child step already finished before the restart, boot recovery gives the chain a
short 5-second handoff grace, then reconciles the release from the newest
finished child instead of force-marking the release failed. Releases are only
left alone when a child step is still genuinely running or another release now
owns the project lock.

When reconciliation detects a chain that ended at a non-terminal success step
(`test`, `fix`, `review`, `commit`) without a successor, it re-fires that
step's completion hook instead of silently finalizing the release green. This
covers interrupted handoffs such as a server rebuild between `markDone()` and
the downstream `start-*` helper. If operators need to revive an older
already-finished release manually, `POST /api/projects/by-project/<project>/release/<id>/resume`
re-acquires the project pipeline lock, reopens the release row, and re-fires
the last finished non-terminal step's completion hook. The route refuses to
resume while another active release owns the lock or while any other same-project
pipeline step is still running, and if the hook launch throws it restores the
original finished state before releasing the lock.
Both the manual resume path and the 5-minute `autoResumeStuckReleases` sweep
rebuild the same contiguous release chain as `reconcileStaleRelease`: children
must hand off within 60 seconds, and a trailing `mark-dod` is treated as a
side-step rather than the terminal chain tail. That keeps later manual retry
steps reusing the same `release_id` from being mistaken for the release's
authoritative stopping point. The background sweep only touches releases that
finished successfully within the last 24 hours.

The release meta-job (`kind='release'`) collects log sections from each step. Its own `finishedAt` is set when any step finalizes without chaining. On start, TamTam stores a `release_deadline_at` unix-ms deadline on that meta-job. The 30-second probe sweep checks unfinished release jobs and calls the same abort helper used by `POST /api/projects/by-project/<project>/release/abort` when the deadline has passed, emitting `release_aborted` with `reason: "wall_clock_timeout"`. The default budget is `release_wall_clock_timeout_minutes=60`; `.tamtam/config.yml` may override it per project with `pipeline.release_timeout_minutes`.

### History view — release grouping

In the per-project **History** tab, pipeline children (`test`, `review`, `fix`, `commit`, `push`, `mark-dod`, `pr-wait`) are folded under their parent `release` row client-side. Current jobs attach by persisted `release_id`, which is inherited from the release meta-job when each pipeline step is spawned. Rows without `release_id` still use the older `[startedAt, finishedAt ?? ∞]` time-window match as a conservative legacy fallback. Clicking the parent row opens `/terminal?job=<release-id>`, which serves the **raw** aggregated log (not parsed stream-json) because the release log is a mix of plain text (test/commit/push output) and NDJSON (review/fix). See `components/project-runs/utils.ts:groupReleaseChildren`, `components/TerminalTab.tsx:isClaudeJobKind` (deliberately excludes `release`), and `app/api/jobs/[jobId]/route.ts` (branches on `kind === 'release'` to return the raw log).

---

## Completion hooks (`runCompletionHooks`)

Called by `markDone()` after every job finishes. Hooks run in order:

0. **Agent action orchestrator** (issue-cruncher and other ghIssue-scoped agent runs): if the run's final assistant text contains a fenced ` ```tamtam-actions ` block, parse it (`lib/agents/action-block-parser.ts` + `action-schema.ts`), check eligibility (`canExecuteAgentActions` — exit 0, issue-scoped kind, action.number == job.ghIssueNumber), then dispatch each entry serially through `runAgentActions` (`lib/agents/action-orchestrator.ts`). Supported actions: `issue-close`, `issue-comment`, `issue-label`, `issue-edit-body`, `checkout-default`. The hook reads `job.logPath` **contents** (not the path) and runs awaited so the stranded-branch reconciler can't race the close and recreate an empty `fix/issue-N` branch. The agent runs in a sandbox that blocks localhost, so this server-side bridge is the only way an agent's declared intent becomes a real `gh issue close` / `git checkout` invocation. Results are recorded on `contextMeta.agentActions = { executed, errors }` for UI surfacing. For agents that emit actions, this hook is the pipeline-terminating step — `release-after-run` is intentionally skipped for `agent:issue-cruncher` and any run with `ghIssueNumber` (see `lib/workflows/triggers/release-after-run.ts`).
1. **Release meta-log**: For pipeline jobs, if an active release exists for the project, append a log section.
2. **Review mark**: If a working-tree `review` exits 0, call `markReviewed(project, path)` to store a commit-aware review fingerprint (`git status` + `HEAD` + upstream) used by the fresh-LGTM skip. PR-diff reviews (`sourceType: 'pr_review'`) do not update that local fingerprint or the incremental reviewed ref. On `LGTM` verdict from a working-tree review, also pin `refs/tamtam/reviewed/<branch>` to `HEAD` — the next pipeline review narrows its scope from `@{u}..HEAD` to `<ref>..HEAD` so already-approved commits aren't re-reviewed (gated by `incremental_review_enabled`, default on; falls back to full scope when the ref isn't an ancestor of HEAD, e.g. after a rebase).
3. **Review chaining**: If `review` exits 0 AND (in-release OR `auto_push_enabled`): LGTM → start PUSH; NEEDS ATTENTION → start FIX (within iteration cap); DO NOT SHIP follows `review_do_not_ship_action` in the workflow-driven release orchestrator (`fix` (default) starts FIX, `pass` files a follow-up issue and continues to commit, `abort` stops). Non-converging review loops still stop when the new review repeats the previous findings or contradicts the most recent fix's `Status: fixed` claims for the same `Finding ID`s.
4. **Fix chaining**: If `fix` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
5. **Test chaining**: If `test` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW, except when `review_disabled` is on. With review disabled, uncommitted changes go to COMMIT and existing unpushed commits go to PUSH.
6. **Push hook fix**: If `push` exits ≠0 and log matches hook rejection patterns: start a generic `fix` job whose `parentJobId` points at the failed push (within `getPushFixAttemptCap()=2`). The fix prompt reads the hook error from the parent push's log.
7. **Fix→push re-push**: When that `fix` (parent.kind === `push`) exits 0: re-run PUSH.
8. **DoD**: If `push` exits 0 and the release is issue-linked, or the push produced a PR without issue context: start MARK-DOD unless auto-merge defers it to post-merge.
9. **PR merge wait**: If a push produced a PR and `auto_pr_merge_enabled`: start PR-MERGE-WAIT; issue-linked DoD is deferred to post-merge on that path.
10. **Release finalization**: If a pipeline job ran but no chaining happened, write `# release finished — exit {code}` to meta-log and mark the release job done.
11. **Fix-CI auto-retry**: If `fix-ci` exits ≠0 within ~5 s of starting (boot crash): schedule retry after 500–3000 ms backoff. Capped at 2 retries within a 120-s window. These are hardcoded constants — not user-tunable.
12. **Fix-CI release chaining**: If `fix-ci` exits 0, TamTam immediately tries `startRelease(project, { queueIfBlocked: true, sourceJobId: fixCiJob.id })` so the uncommitted CI fix goes through the normal quality gate (`test → review → commit → push`). This includes `fix-ci` jobs auto-dispatched by `pr-wait` after failed PR checks. If release start is temporarily blocked by the same conditions as release-after-run (active pipeline lock, pause gate, budget block, retryable pre-start failure), the hook preserves that intent by setting the pending-release flag for the project.
13. **Review-exhaustion fallback**: If a **NEEDS ATTENTION** review→fix loop hits `review_fix_max_iterations`, repeats the same findings (`reviewIsStuck`), or the fixer claims a Finding ID was fixed but the reviewer still flags it (`fixContradictsReview`): file a follow-up issue titled `chore(review): <headline-finding-id> (+N more)` using the highest-severity structured `Finding ID` as the headline (or `chore(review): <headline-finding-id>` when exactly one finding exists, or `chore(review): unresolved review` when no structured findings were extracted). The issue body contains the structured unresolved findings or a quoted prose excerpt. The issue title/body intentionally omit release handles, job IDs, exhaustion reasons, shim launch lines, stream-json telemetry, and permission-mode flags. TamTam tries to apply the canonical labels `tamtam` `review-followup` `priority-medium`, skips any of those labels that do not exist in the repo, then chains to commit + push so the partial work ships. Falls back to the legacy abort if `gh issue create` fails. These follow-up issues intentionally keep the findings under `## Problem`, then emit `## Acceptance criteria` as unchecked `- [ ]` checkboxes so `mark-dod` can parse and tick them on later work; unlike the CTO issue-planning flow, they omit `## Proposed approach` because the reviewer findings are the source of truth. **DO NOT SHIP** reviews are routed by `review_do_not_ship_action` (default `fix`): `fix` drives the fix loop within the same review iteration cap; `pass` files the same follow-up issue and chains to commit; `abort` retains the legacy stop-before-commit behavior.

### Project sweep

When `project_sweep_enabled` is on, the graphile-worker project sweep runs
every 5 minutes. It starts release work only for non-default branches with
local changes or unpushed commits; work on the default branch is skipped until
a human or another explicit trigger starts a Release. For clean non-default
branches with a ready-to-merge PR, the sweep can start `pr-wait`. The sweep
does not dispatch release or `pr-wait` jobs while `jobs_paused` is enabled.

### Pending-release recovery

When a release trigger arrives while the project pipeline lock is held or jobs
are paused globally, TamTam stores `pending_release:<project>=<queued epoch>`
in the `settings` table instead of dropping the request. Older queued flags
that still have the legacy value are treated as pending with an unknown queue
time.

That queued release is retried from five places:

1. `releaseLock()` after the active pipeline finishes
2. `syncJobsPauseState(false)` when the user resumes jobs
3. server boot or stale-lock self-heal, if a queued project is found with no
   active pipeline lock
4. the periodic recovery reconcile ticker, which drains pending releases before
   replaying queued agent work for the same project
5. manual retry from the automation queue surface

Lock release also writes a durable `pipeline_lock_events` row. The probe sweep
consumes unhandled rows and runs the same ordered recovery drain when
`legacy_pipeline_lock_inline_drain_enabled` is set to `false`, giving operators
a restart-safe path for replacing the inline fire-and-forget drain.

Retry semantics matter: a drain attempt only consumes the queue when the
release actually starts or reaches a terminal no-op such as "nothing to
release". Temporary blocks such as the global pause, a fresh budget/credits
429, another active pipeline, or an indeterminate pre-start failure (for
example spawn/boot-time startup errors before the release job is created) keep
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
6. manual retry from the automation queue surface

The durable `pipeline_lock_events` consumer uses the same release-before-agent
ordering as the inline `releaseLock()` drain, so disabling the legacy inline
drain does not allow queued agents to overtake a pending release.

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
| Review→Fix loop | unbounded fixes; configurable review verification rounds | per release; 30 min fallback for standalone chaining | `review_fix_max_iterations` (DB setting, default 3; explicit 0 = unlimited until LGTM or release timeout) governs the **review-side** verification budget only. Cap counts completed `review` runs, not fixes. On **NEEDS ATTENTION** review-side exhaustion (cap, stuck, fix-contradicts-review) TamTam files a follow-up issue and chains to commit+push (see step 13 above) instead of aborting. **DO NOT SHIP** verdicts follow `review_do_not_ship_action` (default `fix`): `fix` consumes the same review verification budget, `pass` files a follow-up issue and commits, and `abort` stops before commit/push. |
| Test / Commit / Push safety cap | configurable via env | per release; 30 min fallback for standalone chaining | `TAMTAM_MAX_STEP_ITERATIONS` (legacy alias `TAMTAM_MAX_FIX_ITERATIONS`, default 3) still guards `test`, `commit`, and `push` verification loops. `TAMTAM_STEP_WINDOW_SECONDS=1800` (alias `TAMTAM_FIX_WINDOW_SECONDS`) controls the standalone fallback window. These caps still abort when exhausted. |
| Push-fix attempts | 2 attempts | per release | hardcoded `getPushFixAttemptCap()=2`. Counts `fix` jobs whose `parentJobId` is a `push` job in the same release. |
| Fix-CI auto-retry | 2 attempts | 120 s | hardcoded constants in `lib/jobs/lifecycle.ts` (boot-crash recovery only — non-user-tunable since 2026-05) |
| Fix-CI fast-crash | — | — | hardcoded `5000` ms — only retries if job died in under this |

---

## Per-project pipeline flags

All stored in the `projects` DB table; editable via the project Config tab.

| Flag | Default | Description |
|------|---------|-------------|
| `auto_commit_enabled` | off | On LGTM, stage + commit automatically |
| `auto_push_enabled` | off | Push after auto-commit; also enables review→fix→push chaining for standalone review runs |
| `auto_pr_merge_enabled` | off | After DoD, poll CI and auto-merge the PR when the push path produced a PR |
| `release_after_run` | off | Trigger the full pipeline automatically after each successful agent/terminal run |
| `review_disabled` | off | Skip the review phase; after tests pass, uncommitted changes go to commit and unpushed commits go to push |
| `post_merge_watch_minutes` | 0 | **Boolean toggle (legacy integer column)**. `0` disables soak. Any positive value enables it; the watcher polls default-branch CI on the merge commit until terminal (no time cap). On any failed check the project is paused and a revert PR is opened |
| `auto_revert_enabled` | off | When the soak watcher opens a revert PR, also enable squash auto-merge so it lands without human review |

When `auto_push_enabled` is **off**: pipeline chaining only happens during an active Release run.
When `auto_push_enabled` is **on**: the same review→fix→push chaining happens for any standalone review job on that project.

`review_prerequisite_command` is a per-project pre-review command. When `.tamtam/config.yml` contains `pipeline.review_prerequisite_command`, that shared file-backed value wins; otherwise TamTam falls back to the DB value edited from the Config tab. When set, TamTam runs it from the project root before each review scope is detected, then appends up to 4000 characters of stdout/stderr to the review prompt. Non-zero exits fail review startup with the captured output.

---

## Hook rejection detection (`isHookRejection`)

Checks the push job log for explicit local hook-failure markers from husky, lint-staged, and the pre-commit framework, while ignoring logs that reached the remote (`remote:` output). If matched, the push failure triggers a generic `fix` job (with `parentJobId` pointing at the failed push) instead of a hard release failure. The fix prompt reads the hook error from the push log and edits the relevant files. When that fix exits 0, the orchestrator re-dispatches the push.

`isTestFailureRejection` (sibling helper in `lib/pipeline/push-rejection.ts`) detects when the pre-push hook failed because tests broke. In that case TamTam stops the pipeline for human triage — fix loops aren't tuned for diagnosing test failures (especially flakes).

`isRemoteRaceRejection` detects stale-remote failures and branch-protection denials that cannot be fixed by editing code. `start-push` first tries to recover concrete stale-head cases with `git pull --rebase` and a push retry; if the residual failure still reaches lifecycle handling, TamTam stops the release with a push-blocked reason rather than launching a fix job.

---

## Helper entry points

| File | Function | Purpose |
|------|----------|---------|
| `lib/start-release.ts` | `startRelease(project)` | Pipeline entry point; creates meta-job, picks first step |
| `lib/start-review.ts` | `startProjectReview(project)` | Spawns review Claude job as a detached child |
| `lib/start-fix.ts` | `startFixFromJob(reviewJob)` | Resumes review session for fix, or starts fresh |
| `lib/start-test.ts` | `startProjectTest(project)` | Detects and runs test command |
| `lib/start-push.ts` | `startProjectPush(project)` | git add → commit message → push |
| `lib/pipeline/push-rejection.ts` | `isHookRejection`, `isTestFailureRejection` | Classifies push failure kind |
| `lib/start-mark-dod.ts` | `startMarkDod(project)` | DoD verification against the linked issue or PR, with checkbox updates when issue criteria exist |
| `lib/pipeline/start-soak.ts` | `launchSoak`, `classifyDefaultBranchCi`, `openRevertPr`, `notifyPostMergeRevert` | Post-merge CI watcher + revert-PR opener. Pure helpers are unit-tested; the side-effectful loop is driven by `lib/workflows/phases/soak-phase.ts` |
| `lib/job-storage.ts` | `markDone(jobId, exitCode)` | Called by the child-process exit handler; triggers all completion hooks |

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
| **Avg successful release time** | mean wall-clock time from `release` start to finish across successful releases only; the card also shows median and p95 |
| **Step durations** | Avg, median, and p95 for each pipeline step: `release`, `test`, `review`, `fix`, `commit`, `push`, `pr-wait`, `mark-dod` |
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

Recovery-loop attribution prefers explicit `releaseId` links on `fix` jobs. For historical rows or partially stamped data where `releaseId` is absent, the stats API falls back to the release's `[startedAt, finishedAt]` window so older dashboards do not silently lose recovery iterations.

The `configSnapshot` section reflects the same shared recovery-budget helper used by runtime enforcement:
- review/test cap: `TAMTAM_MAX_STEP_ITERATIONS` with legacy fallback to `TAMTAM_MAX_FIX_ITERATIONS`
- fallback window: `TAMTAM_STEP_WINDOW_SECONDS` (legacy alias: `TAMTAM_FIX_WINDOW_SECONDS`)
- push-fix cap: hardcoded `2` (counted as `fix` jobs whose parent is a `push` in the same release)

---

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Pipeline stops after test with no next step | `auto_push_enabled` is off and no active Release | Use 🚀 Release button or enable `auto_push_enabled` |
| Review exits 0 but no verdict found | Verdict buried early in a long log | Check last 2000 chars of log; rephrase review prompt to emit verdict at the end |
| Fix loop runs 3 times then stops | Review/test verification cap reached within the configured fallback window | Fix manually, increase `TAMTAM_MAX_STEP_ITERATIONS` (legacy alias: `TAMTAM_MAX_FIX_ITERATIONS`), or wait for `TAMTAM_STEP_WINDOW_SECONDS` to reset |
| Push fails, no `fix` job spawned to recover | Hook strings not matched by `isHookRejection` | Check the push log for hook output; add new hook string patterns to `lib/pipeline/push-rejection.ts` |
| Release button grayed out / 400 | No changes and no unpushed commits | Make a change or verify `git status` |
| `DO NOT SHIP` verdict loops forever | Fix cap reached | Inspect fix logs; may need manual code changes |
| DoD step skipped | No linked GitHub issue and no PR context from the push | DoD only runs when the release is issue-linked or the push produced a PR |
| PR not created after push | The working copy is already on the default branch | Re-run from a non-default branch if you want PR flow |

## Vercel Workflow orchestrator

Every release routes through the `workflow` runtime state machine. There is no direct-call bypass and no opt-out flag — the runtime is always on for release pipelines. TamTam pins the local workflow world by default (`WORKFLOW_TARGET_WORLD=local`, `WORKFLOW_LOCAL_DATA_DIR=data/workflow-data`), so release workflow traces are file-backed unless operators explicitly configure another workflow world such as a Postgres-backed runtime.

### Dataflow

```
HTTP POST /api/projects/by-project/<name>/release
  ↓
releaseWorkflow         (lib/workflows/release.ts)
  ├── kickoffReleaseStep            — calls startRelease, gets first sub-step jobId
  ├── dispatchOrchestratorStep      — dispatches:
  │     ↓
  │   releaseOrchestratorWorkflow(firstStepJobId, { projectName, parentJobId })
  │     ├── waitStep                — waitForJobCompletion(jobId)
  │     ├── decideStep              — decideNextPhase + applyReleaseGuards
  │     └── dispatchStep            — dispatchPhase(decision, { ...ctx, prevJobId })
  │           ↓
  │         release<Phase>PhaseWorkflow(...)  ←─ one of the 7 phase workflows
  │           ├── spawn<Phase>Step  — wraps startProject<Phase> in runWithParent(releaseJobId,…)
  │           ├── await<Phase>Step  — waitForJobCompletion(spawned jobId)
  │           └── re-dispatchOrchestratorTick — start(orchestrator, [thisJobId, ctx])
  │           ↓ (when sub-step finishes, completion hook fires markDone, which sees
  │           ↓  releaseId set and short-circuits the legacy chain — the orchestrator
  │           ↓  already observed the same finishedAt via waitForJobCompletion)
  │         [phase workflow returns; orchestrator decides next; dispatch repeats]
  │         [terminal decision → finalizeReleaseStep stamps release.exit_code + stop_reason]
  ↓
HTTP response with release.jobId
```

### The 9 phase workflows

Each follows the same kickoff/await/return shape (with minor variations: push/commit are inline so they have no await step; review has an extra verdict-read step; pr-wait has a 60-min wait ceiling). All under `lib/workflows/phases/`:

| Phase | File | Result shape |
|-------|------|--------------|
| `test` | `test-phase.ts` | `TestPhaseResult` — `{ jobId, finished, reason, exitCode, testCmd }` |
| `test` with `plain_test_phase_enabled=true` | `pnpm-test-phase.ts` | `PnpmTestPhaseResult` — `{ jobId, exitCode, reason }`; reuses `startProjectTest` to run the detected test command directly without a Claude test agent |
| `review` | `review-phase.ts` | `ReviewPhaseResult` — `{ jobId, finished, reason, exitCode, verdict }` |
| `fix` | `fix-phase.ts` | `FixPhaseResult` — `{ jobId, sourceJobId, finished, reason, exitCode }` |
| `push` | `push-phase.ts` | `PushPhaseResult` — `{ commitSha, message, prUrl?, prNumber?, prRepo? }` |
| `commit` | `commit-phase.ts` | `CommitPhaseResult` — `{ commitSha, message, jobId? }` |
| `mark-dod` | `mark-dod-phase.ts` | `MarkDodPhaseResult` — `{ jobId, issueNumber, verified, total, changed }` |
| `pr-wait` | `pr-wait-phase.ts` | `PrWaitPhaseResult` — `{ jobId, finished, merged, reason, exitCode }` |
| `soak` | `soak-phase.ts` | `SoakPhaseResult` — `{ jobId, verdict, revertPrUrl, autoMerged }` (or `{ skipped: true, reason }`) |

All seven return discriminated unions with `ok: true | false` and a `reason` for the failure branch (`start_failed` / `launch_failed` / `mark_dod_failed`). Each has a focused unit test file with directive-source guards. The push-hook fix path no longer has its own phase — hook rejections spawn the generic `fix` phase with `parentJobId` pointing at the failed push.

The `plain_test_phase_enabled` setting swaps only the workflow implementation for `test`: dispatch uses `pnpm-test-phase.ts`, which delegates to `startProjectTest` and records a normal `test` job/log row. The state-machine contract is unchanged: exit 0 routes to review, non-zero routes to fix, and a successful fix re-dispatches another test verification.

Each spawn step wraps its `startProject*` call in `runWithParent(releaseJobId, ...)` (from `lib/jobs/parent-context.ts`) so the spawned `test`/`review`/`commit`/`push`/`fix` row inherits `release_id` correctly via `parentContext` AsyncLocalStorage. This is load-bearing for the lifecycle hook's release-linked short-circuit: a missed `release_id` causes the legacy chain to double-dispatch alongside the orchestrator.

### Decision logic

`lib/workflows/decide-next-phase.ts` exports the pure function:

```ts
decideNextPhase({ kind, exitCode, verdict }) → NextPhase
```

Pure data → data: takes the just-finished step's `kind`, `exitCode`, and (for review) `verdict`, plus the parent step's `kind` (used for `fix → re-verify` routing back to test/review/commit/push). Returns the next phase to dispatch. Shared by the orchestrator alone now — the legacy completion-hook chain owned the equivalent rules pre-migration. ~30 dedicated tests in `__tests__/lib/workflows/decide-next-phase.test.ts`.

### Dispatch logic

`lib/workflows/dispatch-phase.ts` exports:

```ts
dispatchPhase(decision: NextPhase, ctx: DispatchContext) → DispatchPhaseOutcome
```

Picks the right `release*PhaseWorkflow` and calls `start()`. Validates required context **before** invoking the runtime (e.g. `fix` needs `prevJobId` to point at the source job whose log it should read). Surfaces structured outcomes: `dispatched` / `terminal` / `missing_context` / `dispatch_failed`. 14 tests.

### Pre-dispatch guard layer

`lib/workflows/guards/apply-release-guards.ts` runs after `decideNextPhase` and before `dispatchPhase`. When a guard trips, the original decision is rewritten to `{ next: 'abort', stopReason }`. The orchestrator's `finalizeReleaseStep` persists the stop reason on the release row + log so the trace UI explains the abort.

Three guards:

- **`reviewIsStuck`** (`lib/workflows/guards/review-convergence.ts`) — aborts when the current review's findings fingerprint matches a previous review in the same release. Same fingerprint = same findings = fix not converging.
- **`fixContradictsReview`** (same file) — aborts when the most recent fix in the release claimed `Status: fixed` for one or more `Finding ID`s that the current review still flags. The model and its own reviewer disagree; another iteration won't help.
- **`checkIterationCap`** (`lib/workflows/guards/iteration-caps.ts`) — aborts when a `fix → re-verify` dispatch would exceed `maxStepIterations` (test/commit/push), `reviewFixMaxIterations` (review), or `getPushFixAttemptCap` (push-hook fix retry, special case where parent.kind === 'push').

**Dispatch failures finalize the release.** The orchestrator's terminal-finalize branch covers `terminal`, `dispatch_failed`, and `missing_context` outcomes — the last two coerce to an aborted release with `stopReason = "failed to dispatch <phase>: <error>"` or `"missing context for <phase>: <missing>"` and exit 1. Without this, a `start(child)` that threw would leave the release in `running` until the wall-clock sweep reaped it.

**External reconciler** (`lib/jobs/release-reconcile.ts`). Runs inside the 30s probe sweep. Finds releases that are `running` with no in-flight pipeline children and whose latest terminal child finished >90 s ago, and re-dispatches `releaseOrchestratorWorkflow(childJobId, ctx)`. The tick is idempotent — `waitStep` returns immediately on an already-finished job, and `decideStep` re-evaluates state — so re-running is safe. Capped at 12 attempts per release per server lifetime to ride out restart/reseat churn without thrashing forever on a genuinely broken chain.

When a NEEDS-ATTENTION review-side guard aborts, `finalizeReleaseStep` calls `fileReviewExhaustionIssue` to file a follow-up GitHub issue with the persistent findings (see "Review-exhaustion fallback" above). DO NOT SHIP review verdicts are handled by `applyReleaseGuards` per `review_do_not_ship_action`: `fix` (default) rewrites to `{ next: 'fix', verdict: 'DO NOT SHIP' }`; `pass` rewrites the abort to `{ next: 'commit', fileIssueForReviewId }` so the orchestrator files the same follow-up issue inline before dispatching commit; `abort` keeps the legacy stop.

### Release-linked chain short-circuit

`lib/jobs/lifecycle.ts:~496` gates the legacy chain on `job.releaseId` directly:

```ts
if (['test','review','fix','commit','push','mark-dod'].includes(job.kind) && job.releaseId) {
  console.log(`[release] job ${job.id} (${job.kind}) is release-linked — orchestrator owns chaining; skipping legacy hook chain`);
  return;
}
```

Every release-linked pipeline step is owned by the orchestrator. Standalone (no-`releaseId`) jobs still flow through the chain blocks below — those have no orchestrator and the chain remains the only way they can recover (manual `Run review`, manual push, etc.).

The previous `workflowDriven` contextMeta flag (and the `lib/workflows/workflow-driven-flag.ts` module that managed it) was removed when this gate moved to `releaseId`-based: a stale flag stamp could let the chain fire alongside the orchestrator if the spawn site lost release linkage (cascade #3 was the canonical regression). Gating on linkage directly is robust by construction.

### Determinism note

Any `Date.now()`, `Math.random()`, settings read, env read, or branch-state read MUST live inside a `'use step'` body, not in the workflow body itself. The workflow body is replayed across restarts to short-circuit completed steps; non-deterministic reads outside steps corrupt replay.

### Visibility

- **API**: `GET /api/workflow-runs` (list, supports `?limit=`) and `GET /api/workflow-runs/[runId]` (run + steps). Local-world runs (`WORKFLOW_TARGET_WORLD=local`, the default) are read from `WORKFLOW_LOCAL_DATA_DIR` / `data/workflow-data`, including `runs/*.json` and matching `steps/<runId>-*.json`, and decode the raw base64 `devl` payloads via `lib/workflows/local-world-runs.ts`. Postgres-world rows, when an operator explicitly configures that runtime, decode the runtime's CBOR + devalue payload format via `lib/workflows/decode-workflow-payload.ts`.
- **UI**: `/workflow-runs` lists recent runs with name/args/status/duration/completed/runId columns + name + status filters; row click → `/workflow-runs/[runId]` shows the run with all its steps, including input/output JSON.
- **Nav**: "Workflows" link in `components/Header.tsx`.

### Building blocks summary

| File | Purpose |
|------|---------|
| `lib/workflows/release.ts` | Entry workflow + observation workflow + drive-mode branching |
| `lib/workflows/release-orchestrator.ts` | The 3-step orchestrator: wait → decide → dispatch |
| `lib/workflows/wait-for-job.ts` | Bounded polling helper for sub-step completion |
| `lib/workflows/decide-next-phase.ts` | Pure NextPhase decision logic |
| `lib/workflows/dispatch-phase.ts` | NextPhase → start(matching phase workflow) |
| `lib/workflows/find-next-substep.ts` | Sibling-job matcher for observation-only mode |
| `lib/workflows/decode-workflow-payload.ts` | CBOR + devalue payload decoder for the API |
| `lib/workflows/phases/*.ts` | 9 per-phase driver workflows |
| `lib/pipeline/start-soak.ts` | Soak-phase pure helpers (`classifyDefaultBranchCi`, `revertBranchName`, `buildRevertPrBody`) plus side-effectful `queryDefaultBranchCi`, `openRevertPr`, `autoMergeRevertPr`, `notifyPostMergeRevert`, `launchSoak` |
| `__tests__/lib/workflows/*.test.ts` | ~140 unit tests with directive guards |
