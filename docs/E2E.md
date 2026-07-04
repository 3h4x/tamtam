# E2E Pipeline Testing

This document covers the Playwright-based end-to-end harness for the release
pipeline. These tests exercise the **real Next.js API handlers** against an
**isolated Postgres database** with only the external processes mocked (Claude
CLI, git, gh).

Related: [PIPELINE.md](PIPELINE.md) — pipeline state machine.

---

## When to write a pipeline e2e test vs a unit test

| Scenario | Test type |
|---|---|
| New API route, lib function with branching | vitest unit test in `__tests__/` |
| Full pipeline chain (review → fix → commit → push) | pipeline e2e in `e2e/pipeline/` |
| UI-only rendering, component state | Playwright browser test in `e2e/` |
| Single pipeline helper in isolation | vitest unit test |

Write an e2e pipeline test when you need to verify that **completion hooks
chain correctly** across multiple pipeline steps, or that the probe sweep picks
up a detached child process exit code and triggers the right follow-on step.
Unit tests cannot catch these because they mock the async job lifecycle.

---

## Directory layout

```
e2e/pipeline/
  mocks/
    claude-shim.js          # Fake Claude CLI — emits scripted NDJSON / plain text
    bin/
      git                   # git shim — records calls, returns canned output
      gh                    # gh shim — records calls, succeeds silently
  scenarios/
    happy-path.json         # Steps for the happy-path spec
    review-needs-attention.json
    issue-release-auto-branch.json
    pr-workflow-auto-merge.json
  global-setup.ts           # Playwright globalSetup — creates temp dirs, configures server
  helpers.ts                # writeScenario, resetShimState, readShimCalls, waitForPipeline…
  happy-path.spec.ts        # review LGTM → commit → push
  review-needs-attention.spec.ts  # NEEDS ATTENTION → fix → LGTM → commit → push
  issue-release-auto-branch.spec.ts # issue-linked release creates a feature branch before commit
  issue-release-zombie-branch-recovery.spec.ts # issue-linked release deletes and recreates a merged zombie branch
  pr-workflow-auto-merge.spec.ts  # feature branch push → mark-dod → PR wait → merge
  pr-workflow-reuse-existing-pr.spec.ts # feature branch push reuses an existing PR before auto-merge
```

---

## What is mocked vs real

| Component | Status |
|---|---|
| Next.js API handlers | **Real** |
| Postgres database | **Real** (isolated DB via `E2E_DATABASE_URL`, default `tamtam_e2e_pipeline` on the local Postgres; recreated by the harness) |
| Probe sweep / completion hooks | **Real** (sped up via `TAMTAM_PROBE_INTERVAL_MS=500`) |
| Detached job lifecycle | **Real** (uses child processes started by the API handlers) |
| Claude CLI | **Mocked** (`e2e/pipeline/mocks/claude-shim.js`) |
| `git` binary | **Mocked** (`e2e/pipeline/mocks/bin/git`) |
| `gh` (GitHub CLI) | **Mocked** (`e2e/pipeline/mocks/bin/gh`) |

The Claude shim is configured as the server's `claude_bin` setting via the API
(absolute path, no PATH lookup needed). The git and gh shims are placed first
on `PATH` in the webServer env so all `exec('git', …)` calls in the server
process are intercepted.

> **Note on detached jobs**: Review and fix jobs run as detached child
> processes. The claude shim is invoked with its absolute path, so PATH is
> only relevant for inline server calls such as git and gh.

---

## Scenario JSON schema

A scenario file is a plain JSON object with a `steps` array. Each step has:

```json
{
  "description": "Human-readable summary of the scenario",
  "steps": [
    {
      "label": "review",
      "text": "The code looks good.\n\nVerdict: LGTM"
    },
    {
      "label": "commit-message",
      "text": "feat: add feature"
    }
  ]
}
```

The Claude shim uses a counter (persisted in
`/tmp/tamtam-e2e-pipeline/shim-state/<project>/counter`) to advance through
steps sequentially. Step 0 is the first Claude call, step 1 is the second, and
so on. If the counter exceeds the array length the last step is replayed.

**Step text for reviews** must end with the formal verdict line:
```
Verdict: LGTM          # or NEEDS ATTENTION / DO NOT SHIP
```

**Step text for commit messages** must contain a conventional commit title that
matches `^(feat|fix|docs|…): .{3,}` — the server's `generateCommitMessage`
parser extracts this via regex.

**Step text for fix jobs** is free-form (Claude is applying fixes; no verdict).

---

## Shim state directory

Each test project gets its own subdirectory under the shim-state root:

```
/tmp/tamtam-e2e-pipeline/shim-state/<project>/
  scenario.json      # current scenario (written by helpers.ts writeScenario)
  counter            # current Claude call index (incremented by claude-shim.js)
  git-state.json     # { committed: false, pushed: false }
  git-branch         # current branch returned by the git shim
  git-merged-branches.json # scripted `git branch --merged <base>` output
  git-failures.json  # one-shot or persistent scripted command failures
  gh-open-pr.json    # scripted existing PR metadata for `gh pr view` / `gh pr list`
  gh-pr-statuses.json # scripted PR statusCheckRollup responses for pr-wait
  gh-pr-status-index # next scripted PR status response index
  git-calls.jsonl    # JSONL log of every git invocation
```

Call `resetShimState(project)` from `helpers.ts` in `beforeAll` to wipe and
reinitialize this directory before each test run.

## PR Workflow shim knobs

Use `writeGitBranch(project, '<feature-branch>')` to make the git shim report a
non-default branch. Release pushes from a non-default branch exercise the PR
Workflow path: `gh pr create`, then `mark-dod` (the orchestrator runs DoD after
push and *before* `pr-wait`), `pr-wait`, `gh pr merge`, and post-merge checkout
back to `master`. `pr-wait` also re-runs a post-merge `mark-dod` (a no-op here).
Only the legacy standalone chain defers DoD entirely to post-merge.

Use `writeGhPrStatuses(project, statuses)` to script the `gh pr view --json
state,mergeable,statusCheckRollup` responses consumed by `start-pr-wait`.
Each poll advances one entry and then repeats the last entry. A pending then
passing sequence looks like:

```typescript
writeGhPrStatuses(project, [
  {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }],
  },
  {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  },
]);
```

The gh shim records PR status polls with `result: "checks:<status>"` in
`git-calls.jsonl`, so specs can prove `gh pr merge` was invoked only after a
passing check response. PR body and issue checkbox updates remain mocked: the
default PR body is empty, so `mark-dod` (both the pre-`pr-wait` orchestrator DoD
and `pr-wait`'s post-merge re-run) records a successful no-op unless the test
overrides the shim behavior.

Use `writeGhOpenPr(project, pr)` to script an already-open PR for the current
feature branch. That drives both production reuse paths:

- `createGenericPR(...)` → `gh pr view --json url`
- `createIssuePR(...)` → `gh pr list --head <branch> --json url`

Example:

```typescript
writeGhOpenPr(project, {
  number: 7,
  url: 'https://github.com/test/repo/pull/7',
  headBranch: 'feature/reuse-existing-pr',
  title: 'Existing PR',
  body: '',
  state: 'OPEN',
  author: { login: 'trusted-user' },
});
```

If the shim handles a `gh pr create`, it also persists that PR into
`gh-open-pr.json`, so later release attempts on the same branch can reuse it
without extra setup.

Use `writeGitMergedBranches(project, branches)` when a test needs the git shim
to report pre-merged local refs for `git branch --merged <defaultBranch>`.
This is mainly for zombie-branch recovery flows that must distinguish
"branch already exists locally" from "branch exists and is already merged, so
delete it and recreate a fresh branch".

Use `writeGitFailures(project, failures)` to force the git shim down fallback
paths. Checkout failures accept `matchArgs` and `once`, so a test can fail only
the first `git checkout -b <branch>` attempt and then allow the retry or plain
checkout fallback:

```typescript
writeGitFailures(project, {
  checkout: {
    exitCode: 128,
    stderr: 'branch already exists',
    matchArgs: ['-b', 'fix/issue-42-test-issue'],
    once: true,
  },
});
```

That pairs with `writeGitMergedBranches(...)` for the real `start-commit`
zombie-branch path: first `checkout -b` fails, `git branch --merged` reports
the stale ref, TamTam deletes it with `git branch -D`, then retries
`checkout -b`.

---

## How to add a new pipeline e2e test

1. **Write a scenario JSON** in `e2e/pipeline/scenarios/<name>.json`. Follow
   the schema above: list steps in the order Claude will be called.

2. **Create a spec file** `e2e/pipeline/<name>.spec.ts`:
   ```typescript
   import { test, expect } from '@playwright/test';
   import { readFileSync } from 'fs';
   import { join } from 'path';
   import { writeScenario, resetShimState, readShimCalls,
            enableProject, waitForPipelineCompletion } from './helpers';

   const SCENARIO = JSON.parse(readFileSync(join(__dirname, 'scenarios', '<name>.json'), 'utf-8'));
   const PROJECT = '<project-name>';  // must match a dir in /tmp/.../workspace/

   test.describe('<description>', () => {
     test.beforeAll(async ({ request }) => {
       writeScenario(PROJECT, SCENARIO.steps);
       resetShimState(PROJECT);
       await enableProject(request, PROJECT, { testsDisabled: true });
     });

     test('<assertion>', async ({ request }) => {
       await request.post(`/api/projects/by-project/${PROJECT}/release`);
       const result = await waitForPipelineCompletion(request, PROJECT);
       expect(result.status).toBe('done');
       // …assert on readShimCalls(PROJECT), job kinds, exit codes, etc.
     });
   });
   ```

3. **Register the project** in `global-setup.ts` — add it to the `PROJECTS`
   array so its workspace directory and initial state files are created before
   the server starts.

4. **Run it**:
   ```sh
   pnpm test:e2e:pipeline --grep "<description>"
   ```

---

## Running the tests

```sh
pnpm test:e2e:pipeline
```

This uses `playwright.pipeline.config.ts`, which:
- Starts a fresh Next.js dev server on **port 1338** (not 1337)
- Uses a Postgres database created, migrated, and dropped by the harness; `DATABASE_URL` is injected into the dev server
- Sets `TAMTAM_PROBE_INTERVAL_MS=500` for fast job probing
- Prepends `e2e/pipeline/mocks/bin` to PATH

**Prerequisites**: PM2 must be installed and the daemon must be startable
(`pm2 status` or `pm2 start` auto-bootstraps it). Node.js and pnpm must be
on PATH. No real Claude account or git credentials are required.

## Manual QA Docker stack

For manual browser QA against the deterministic seeded workspace, start the
Docker Compose stack with:

```sh
scripts/qa-stack-up.sh
```

The helper is idempotent. It anchors `docker-compose.qa.yml` to the repository
root, starts the `tamtam-qa` service in detached mode when needed, and only
reports readiness after that compose service is running and
`http://localhost:1338/` responds. The service runs `next dev` with the
repository bind-mounted at `/app`, so local code edits are picked up by the
container watcher without a production rebuild.

---

## Debugging a failing run

1. **Job logs**: after the pipeline runs, open the review/fix output log
   shown in the TamTam UI under
   `/project/<name>/history`).

2. **Shim call log**: read
   `/tmp/tamtam-e2e-pipeline/shim-state/<project>/git-calls.jsonl` to see
   every git command the server called and in what order.

3. **Shim counter**: check
   `/tmp/tamtam-e2e-pipeline/shim-state/<project>/counter` to see how many
   Claude calls were made. If it didn't advance, the review PM2 job may have
   failed to find the scenario file.

4. **Server logs**: `pnpm logs` (the test server runs on PM2 as well — look
   for the `tamtam` entry on port 1338). Check for `[release]` and `[probe]`
   log lines.

5. **Scenario file**: verify
   `/tmp/tamtam-e2e-pipeline/shim-state/<project>/scenario.json` was written
   before the release was triggered (global-setup writes it; beforeAll also
   writes it, but that runs after the server starts).

6. **Increase timeouts**: `TAMTAM_PROBE_INTERVAL_MS` can be lowered further
   (e.g. `200`) by editing `playwright.pipeline.config.ts` — but below 200 ms
   the PM2 daemon may not have had time to record the exit code.
