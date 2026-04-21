# Release Pipeline — How It Works

The pipeline is a quality-gated sequence: **test → review → fix loop → push**. Each step is a normal job; chaining happens in completion hooks inside `lib/job-storage.ts`. The 🚀 Release button is the entry point; `auto_push_enabled` enables the same chaining for standalone review/fix runs.

## When to read this

- Pipeline is stuck or not chaining to the next step
- Understanding why Release skipped straight to push (or stopped early)
- Configuring verdict rules or fix iteration limits
- Debugging why "LGTM" wasn't detected in a review log
- Setting up `auto_push_enabled` for continuous deployment

---

---

## State machine

```
startRelease()
  ├─ No changes + no unpushed commits → 400 error
  ├─ Fresh LGTM on current working-tree hash → skip to PUSH
  └─ Otherwise:
      ├─ testCommand configured → start TEST
      └─ No testCommand:
          ├─ Has uncommitted changes → start REVIEW
          └─ Only unpushed commits → start PUSH directly

TEST
  ├─ exit 0  → completion hook → start REVIEW
  └─ exit ≠0 → completion hook → finalize release (exit 1)

REVIEW
  ├─ exit 0  → completion hook → extract verdict
  │   ├─ LGTM              → start PUSH
  │   ├─ NEEDS ATTENTION   → start FIX (if iterations < 3 per 30 min)
  │   ├─ DO NOT SHIP       → start FIX (if iterations < 3 per 30 min)
  │   └─ No verdict found  → finalize release (exit 1)
  └─ exit ≠0 → completion hook → finalize release (exit 1)

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

The release meta-job (`kind='release'`) collects log sections from each step. Its own `finishedAt` is set when any step finalizes without chaining.

---

## Completion hooks (`runCompletionHooks`)

Called by `markDone()` after every job finishes. Hooks run in order:

1. **Release meta-log**: For pipeline jobs (`test/review/fix/push/fix-push`), if an active release exists for the project, append a log section.
2. **Review mark**: If `review` exits 0, call `markReviewed(project, path)` to store the working-tree hash (used by the fresh-LGTM skip optimization).
3. **Review chaining**: If `review` exits 0 AND (in-release OR `auto_push_enabled`): LGTM → start PUSH; NEEDS ATTENTION / DO NOT SHIP → start FIX (within iteration cap).
4. **Fix chaining**: If `fix` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
5. **Test chaining**: If `test` exits 0 AND (in-release OR `auto_push_enabled`): start REVIEW.
6. **Push hook fix**: If `push` exits ≠0 and log matches hook rejection patterns: start FIX-PUSH (within attempt cap).
7. **Fix-push re-push**: If `fix-push` exits 0: start PUSH again.
8. **Release finalization**: If a pipeline job ran but no chaining happened, write `# release finished — exit {code}` to meta-log and mark the release job done.
9. **Fix-CI auto-retry**: If `fix-ci` exits ≠0 and duration < `fix_ci_fast_crash_ms`: schedule retry after 500–3000ms backoff (within `fix_ci_max_retries`).

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
| Review→Fix loop | 3 iterations | 30 min | hardcoded `MAX_FIX_ITERATIONS=3`, `FIX_WINDOW_SECONDS=1800` |
| Fix-Push attempts | 2 attempts | 30 min | hardcoded `MAX_FIX_PUSH_ATTEMPTS=2` |
| Fix-CI auto-retry | configurable | configurable | `fix_ci_max_retries` (default 2), `fix_ci_retry_window_seconds` (default 120) |
| Fix-CI fast-crash | — | — | `fix_ci_fast_crash_ms` (default 5000ms) — only retries if job died in under this |

---

## `auto_push_enabled`

Per-project boolean flag on the `projects` table (off by default).

- When **off**: pipeline chaining only happens during an active Release run.
- When **on**: the same review→fix→push chaining happens for any standalone review job on that project (even ones triggered manually or by an agent).

---

## `pr_pipeline` — Protected Branch Mode

Per-project boolean flag on the `projects` table (off by default). Controls whether the **push** step commits directly to the default branch or routes changes through a pull request.

### Direct push (default, `pr_pipeline = false`)

```
test → review → commit → git push → done
```

Changes are committed and pushed straight to the current branch (usually `main`/`master`). Suitable for small repos or repos without branch protection.

### PR pipeline (`pr_pipeline = true`)

```
test → review → commit → push feature branch → gh pr create → checkout main → done
```

When a push is triggered and the project has `pr_pipeline` enabled:

1. **Branch**: If currently on the default branch (`main`/`master`), a timestamped feature branch `tamtam/<yyyymmddHHMMSS>` is created. If already on a feature branch, it is reused.
2. **Commit**: Changes are committed to the feature branch exactly as in direct-push mode (AI-generated conventional commit message).
3. **Push**: The feature branch is pushed to the remote (with `-u origin <branch>` if no upstream exists).
4. **PR**: `gh pr create` opens a PR from the feature branch into the default branch. The PR title is derived from the most recent commit subject and validated against the conventional commits format.
5. **Checkout**: After PR creation, the local repo is checked out back to the default branch so the project is never left on a stale feature branch.

### Issue context takes precedence

When a run was started from a GitHub issue (the job has `ghIssueNumber` set), issue-context branching (`fix/issue-N-title`) and PR creation always apply regardless of the `pr_pipeline` flag. The flag only changes behavior for regular (non-issue) push runs.

### Push result

On success, `PushResult.message` contains `PR created: <url>`. If PR creation fails (e.g. `gh` not authenticated), the result is still `ok: true` with message `pushed (PR creation failed — see log)` — the commits and push succeeded; only the PR step failed.

### Configuration

Set via `PATCH /api/projects/by-project/[name]/config`:
```json
{ "pr_pipeline": true }
```

Or toggle in the project config UI (Project → Config tab).

### Required tooling

`gh` (GitHub CLI) must be installed and authenticated (`gh auth login`) for PR creation to work. The pipeline does not fail if `gh` is missing — PR creation is best-effort; a degraded message is returned.

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
| `lib/job-storage.ts` | `markDone(jobId, exitCode)` | Called by PM2 exit handler; triggers all hooks |

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
| No `testCommand` configured, only unpushed commits | Skip review, go straight to PUSH |

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

Steps should **never** derive state from ambient git state (`hasChanges`, `unpushed`) — only from actual job runs within the release.

### Visibility rule

Show the strip **only** when:
1. There is an active release job (`kind='release'`, `status='running'`) for this project, **or**
2. There is a release job that completed within the last hour

Hide it otherwise. Stale ✓s from yesterday's release are noise.

### Scoped implementation changes

1. **`ProjectDetailPage.tsx`** — look up the most recent `release` job (new `kind` lookup). Drive strip visibility from `releaseJob !== null && releaseJob.started_at >= hourAgo`. Remove the current collection of booleans (`pipelineRunning`, `recentFailedJob`, `recentReviewNotLgtm`, `recentLgtmWithWorkRemaining`).

2. **Step job lookup** — filter candidate jobs by `release_id === releaseJob.id` instead of the flat 24h window. This requires `release_id` to be present on child jobs (it already is set in `start-release.ts`).

3. **`commitState` / `pushState`** — derive from `pushJob` (exit code, `last_push_error`) only. Remove git-state fallback (`hasChanges`, `unpushed`) from step coloring. Git state can remain as tooltip text ("nothing to push") but must not make a step green.

4. **Standalone runs** — test/review/fix run outside a release → strip is hidden. The individual buttons (Run Tests, Review) continue to work; they just don't hijack the pipeline strip.

### Non-goals for this fix

- No change to how chaining works (completion hooks in `job-storage.ts`)
- No change to the 🚀 Release button behavior
- No change to how `release_id` is set on child jobs
- `auto_push_enabled` behavior unchanged

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Pipeline stops after test with no next step | `auto_push_enabled` is off and no active Release | Use 🚀 Release button or enable `auto_push_enabled` |
| Review exits 0 but no verdict found | Verdict buried early in a long log | Check last 2000 chars of log; rephrase review prompt to emit verdict at the end |
| Fix loop runs 3 times then stops | `MAX_FIX_ITERATIONS=3` cap reached within 30 min | Fix manually or wait 30 min for window to reset |
| Push fails, no `fix-push` triggered | Hook strings not matched by `isHookRejection` | Check the push log for hook output; add new hook string patterns to `lib/start-fix-push.ts` |
| Release button grayed out / 400 | No changes and no unpushed commits | Make a change or verify `git status` |
| `DO NOT SHIP` verdict loops forever | Fix cap reached | Inspect fix logs; may need manual code changes |
