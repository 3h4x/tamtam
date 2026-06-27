// Side-effect-free release planner.
//
// Computes the ordered execution plan the Release button would run *without*
// performing any of it: no git writes, no job creation, no PM2 start, no
// GitHub mutation, no webhook send. It reuses the exact decision helpers that
// `startRelease` (lib/pipeline/start-release.ts) and the release orchestrator
// (lib/workflows/decide-next-phase.ts) use at runtime, so the plan stays in
// lock-step with what actually happens.
//
// Two-part computation:
//   1. Entry step — mirrors `startRelease`'s first-step decision (the only
//      place that understands the fresh-LGTM fast path).
//   2. Downstream — simulates the happy path forward by feeding success
//      inputs (test exit 0, review LGTM, push exit 0, …) through
//      `decideNextPhase`, the same pure transition matcher the orchestrator
//      uses between steps.

import { resolveProjectPath } from '@/lib/shared/project-data';
import { isProjectArchived, isProjectPaused } from '@/lib/shared/enabled-projects';
import { detectTestCommand } from './start-test';
import { getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { hasFreshLgtm, hasLocalCommitsAhead } from './release-state';
import { decidePrContext } from './pr-context';
import { exec } from '@/lib/shared/shell';
import {
  statusHasAnyPath,
  statusHasOnlyCommittedTamtamMetadataPaths,
} from '@/lib/pipeline/review-scope';
import { listJobs } from '@/lib/jobs/job-storage';
import { findActivePrWait, RELEASE_PIPELINE_KINDS } from './start-release';
import { decideNextPhase, type DecisionInputs } from '@/lib/workflows/decide-next-phase';

export type PlanStepKind =
  | 'test'
  | 'review'
  | 'commit'
  | 'push'
  | 'mark-dod'
  | 'pr-wait'
  | 'soak';

export interface PlanStep {
  kind: PlanStepKind;
  /** True when this step runs on the projected happy path. */
  willRun: boolean;
  /** Human-readable explanation of why the step runs or is skipped. */
  reason: string;
  /** Side effects the step would perform when it runs. Empty for skipped
   *  steps. */
  sideEffects: string[];
  /** Range the step compares, where relevant (review/push). */
  comparisonRange?: string;
}

export interface ReleaseBlocker {
  code:
    | 'not_found'
    | 'archived'
    | 'paused'
    | 'nothing_to_release'
    | 'job_running'
    | 'pipeline_running'
    | 'pr_wait_open';
  detail: string;
  blockingJobId?: string;
}

export interface ReleasePlan {
  project: string;
  /** True when no blocking precondition stands in the way of a release. */
  canRelease: boolean;
  blockers: ReleaseBlocker[];
  /** 'pr' opens/reuses a PR (non-default branch); 'direct' pushes to the
   *  default branch. Decided from branch context, same as runtime. */
  mode: 'pr' | 'direct';
  currentBranch: string;
  targetBranch: string;
  /** The git range review/push compare (e.g. `@{u}..HEAD` or
   *  `<default>..HEAD`), or null when it can't be determined. */
  comparisonRange: string | null;
  /** The step `startRelease` would launch first, or null when blocked. */
  entryStep: PlanStepKind | null;
  /** Canonical-order steps with willRun + reason; skipped steps included. */
  steps: PlanStep[];
}

const CANONICAL_ORDER: PlanStepKind[] = [
  'test',
  'review',
  'commit',
  'push',
  'mark-dod',
  'pr-wait',
  'soak',
];

interface PlanFacts {
  changes: boolean;
  unpushed: boolean;
  onlyTamtamMetadata: boolean;
  freshLgtm: boolean;
  testCmd: string | null;
  testsDisabled: boolean;
  reviewDisabled: boolean;
  shouldOpenPr: boolean;
  autoPrMergeEnabled: boolean;
  postMergeWatchMinutes: number;
  comparisonRange: string | null;
}

// Mirrors the first-step decision inside `startRelease`'s runWithParent block.
function computeEntryStep(f: PlanFacts): PlanStepKind {
  const testsRunnable = !!f.testCmd && !f.testsDisabled;
  if (!f.changes) {
    if (testsRunnable) return 'test';
    if (f.freshLgtm) return 'push';
    if (f.reviewDisabled) return 'push';
    return 'review';
  }
  if (f.freshLgtm) return 'commit';
  if (testsRunnable) return 'test';
  if (f.reviewDisabled || f.onlyTamtamMetadata) return 'commit';
  return 'review';
}

// Build the success-path DecisionInputs for a given finished kind. Every phase
// is assumed to pass so we trace the happy path: test exit 0, review LGTM,
// commit/push exit 0, mark-dod ignores its own exit.
function successInputs(kind: PlanStepKind, f: PlanFacts): DecisionInputs {
  return {
    kind,
    exitCode: 0,
    verdict: kind === 'review' ? 'LGTM' : null,
    parentKind: null,
    reviewDisabled: f.reviewDisabled,
    hasUncommittedChanges: f.changes,
    hasUnpushedCommits: f.unpushed,
    hostTestsAvailable: !!f.testCmd && !f.testsDisabled,
    autoPrMergeEnabled: f.autoPrMergeEnabled,
    pushPrContext: f.shouldOpenPr
      ? { prNumber: 0, prRepo: '', prUrl: '' }
      : null,
    soakContext:
      f.postMergeWatchMinutes > 0
        ? {
            mergeSha: '',
            prNumber: 0,
            prRepo: '',
            prUrl: '',
            defaultBranch: '',
            watchMinutes: f.postMergeWatchMinutes,
            autoRevert: false,
          }
        : null,
  };
}

// Walk the happy path from the entry step using the same transition matcher
// the orchestrator uses, collecting the ordered kinds that would run.
function simulateChain(entry: PlanStepKind, f: PlanFacts): PlanStepKind[] {
  const chain: PlanStepKind[] = [entry];
  let cur: PlanStepKind = entry;
  // Bounded: the pipeline has 7 phase kinds; 12 iterations is well clear of
  // any acyclic happy path while still capping a hypothetical cycle.
  for (let i = 0; i < 12; i++) {
    const next = decideNextPhase(successInputs(cur, f));
    const n = next.next;
    if (
      n === 'test' ||
      n === 'review' ||
      n === 'commit' ||
      n === 'push' ||
      n === 'mark-dod' ||
      n === 'pr-wait' ||
      n === 'soak'
    ) {
      if (chain.includes(n)) break; // defensive: never loop the plan
      chain.push(n);
      cur = n;
      continue;
    }
    // done / abort / fix / unknown — happy path terminates.
    break;
  }
  return chain;
}

function skipReason(kind: PlanStepKind, f: PlanFacts): string {
  switch (kind) {
    case 'test':
      if (f.testsDisabled) return 'Tests disabled for this project';
      if (!f.testCmd) return 'No test command configured or detected';
      if (f.freshLgtm) return 'Fresh LGTM — skipping tests';
      return 'Not on the projected path';
    case 'review':
      if (f.reviewDisabled) return 'Review disabled for this project';
      if (f.freshLgtm) return 'Fresh LGTM — review already passed for this tree';
      if (f.onlyTamtamMetadata)
        return 'Only committed .tamtam metadata changed (excluded from review scope)';
      return 'Not on the projected path';
    case 'commit':
      if (!f.changes) return 'No uncommitted changes to commit';
      return 'Not on the projected path';
    case 'push':
      return 'Not on the projected path';
    case 'mark-dod':
      return 'Not on the projected path';
    case 'pr-wait':
      if (!f.shouldOpenPr)
        return 'Direct push to default branch — no PR to wait on';
      if (!f.autoPrMergeEnabled)
        return 'Auto PR merge disabled — PR opened but not auto-merged';
      return 'Not on the projected path';
    case 'soak':
      if (f.postMergeWatchMinutes <= 0)
        return 'No post-merge watch window configured';
      if (!f.shouldOpenPr || !f.autoPrMergeEnabled)
        return 'Nothing merges (no auto-merged PR), so no post-merge soak';
      return 'Not on the projected path';
  }
}

function runReason(kind: PlanStepKind, f: PlanFacts): string {
  switch (kind) {
    case 'test':
      return `Run tests (${f.testCmd ?? 'detected command'})`;
    case 'review':
      return 'Run review agent over the change scope';
    case 'commit':
      return f.changes
        ? 'Commit the working-tree changes'
        : 'Commit reviewed changes (no-op if tree is clean)';
    case 'push':
      return f.shouldOpenPr
        ? `Push '${f.comparisonRange ?? 'HEAD'}' and open/reuse a PR`
        : 'Push directly to the default branch';
    case 'mark-dod':
      return 'Mark Definition of Done on the linked issue/PR';
    case 'pr-wait':
      return 'Wait for the PR to merge (auto-merge when checks are green)';
    case 'soak':
      return 'Watch default-branch CI on the merge commit';
  }
}

function sideEffectsFor(kind: PlanStepKind, f: PlanFacts): string[] {
  switch (kind) {
    case 'test':
      return ['Runs the project test command (no git writes)'];
    case 'review':
      return ['Runs a review agent (read-only; records a verdict)'];
    case 'commit':
      return ['Creates a git commit'];
    case 'push':
      return f.shouldOpenPr
        ? ['Pushes the branch upstream', 'Opens or reuses a GitHub PR']
        : ['Pushes commits to the default branch'];
    case 'mark-dod':
      return ['Updates Definition-of-Done state on the issue/PR'];
    case 'pr-wait':
      return [
        'Polls the PR until merged',
        ...(f.autoPrMergeEnabled ? ['Auto-merges when checks pass'] : []),
      ];
    case 'soak':
      return ['Polls default-branch CI; may pause the project / open a revert PR'];
  }
}

async function computeComparisonRange(projPath: string): Promise<string | null> {
  try {
    const upstream = await exec(
      'git',
      ['-C', projPath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { timeout: 5000 },
    );
    if (upstream.exitCode === 0 && upstream.stdout.trim()) {
      return `${upstream.stdout.trim()}..HEAD`;
    }
  } catch {
    /* fall through to default-branch comparison */
  }
  try {
    const { getDefaultBranchSync } = await import('@/lib/git/git-branch');
    const def = getDefaultBranchSync(projPath);
    if (def) return `${def}..HEAD`;
  } catch {
    /* ignore */
  }
  return null;
}

async function readWorkingTreeStatus(projPath: string): Promise<string> {
  const r = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
  if (r.exitCode !== 0) return '';
  return r.stdout;
}

/**
 * Compute the dry-run release plan for a project. Performs only read-only git
 * and DB reads — never mutates state. Runtime-only gates (provider budget,
 * readiness `prerequisiteCommand`, CLI start gate) are intentionally NOT
 * evaluated here because they can have side effects; they are enforced at
 * launch by `startRelease`.
 */
export async function computeReleasePlan(projectName: string): Promise<ReleasePlan> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return {
      project: projectName,
      canRelease: false,
      blockers: [{ code: 'not_found', detail: 'project not found' }],
      mode: 'direct',
      currentBranch: '',
      targetBranch: '',
      comparisonRange: null,
      entryStep: null,
      steps: [],
    };
  }

  const blockers: ReleaseBlocker[] = [];
  if (isProjectArchived(projectName)) {
    blockers.push({ code: 'archived', detail: 'project archived' });
  }
  if (isProjectPaused(projectName)) {
    blockers.push({ code: 'paused', detail: 'project paused' });
  }

  // Gather the same facts startRelease reads, all read-only.
  const status = await readWorkingTreeStatus(projPath);
  const changes = statusHasAnyPath(status);
  const unpushed = await hasLocalCommitsAhead(projPath);
  const onlyTamtamMetadata =
    changes && statusHasOnlyCommittedTamtamMetadataPaths(status) && !unpushed;

  if (!changes && !unpushed) {
    blockers.push({
      code: 'nothing_to_release',
      detail: 'Nothing to release — no changes and no unpushed commits',
    });
  }

  // Non-probing job-state read. `startRelease` uses `findBlockingRunningJob` /
  // `isReleasePipelineRunning`, but those call `probeJobStatus`, which
  // `markDone()`s a dead-pid job — releasing the pipeline lock and firing
  // completion-hook webhooks. That would break this planner's read-only
  // guarantee, so the dry-run reads `finishedAt === null` rows directly. A
  // dead-but-unfinalized zombie can therefore surface as a blocker until the
  // 30s probe sweep finalizes it — the safe, conservative direction for a
  // preview (startRelease re-probes and clears it at launch).
  const unfinishedJobs = listJobs().filter(
    (j) => j.project === projectName && j.finishedAt === null,
  );
  const blockingJob = unfinishedJobs.find((j) => !RELEASE_PIPELINE_KINDS.has(j.kind));
  if (blockingJob) {
    blockers.push({
      code: 'job_running',
      detail: `Job '${blockingJob.kind}' is already running (job ${blockingJob.id})`,
      blockingJobId: blockingJob.id,
    });
  } else if (unfinishedJobs.some((j) => RELEASE_PIPELINE_KINDS.has(j.kind))) {
    blockers.push({
      code: 'pipeline_running',
      detail: 'Release pipeline already running',
    });
  }

  const activePrWait = findActivePrWait(listJobs(), projectName);
  if (activePrWait) {
    blockers.push({
      code: 'pr_wait_open',
      detail: `A PR is awaiting merge (pr-wait ${activePrWait.id}); holding to avoid concurrent-PR conflicts`,
      blockingJobId: activePrWait.id,
    });
  }

  const freshLgtm = await hasFreshLgtm(projectName, projPath);
  const config = await getProjectTestConfig(projectName);
  const testsDisabled = !!config?.testsDisabled;
  // Skip detection when tests are disabled: the plan never marks `test` as
  // willRun in that case anyway, and `detectTestCommand` would re-issue the
  // same `getProjectTestConfig` lookup we already have.
  const testCmd = testsDisabled ? null : await detectTestCommand(projPath, projectName);
  const reviewDisabled = !!config?.reviewDisabled;
  const autoPrMergeEnabled = !!config?.autoPrMergeEnabled;
  const postMergeWatchMinutes = config?.postMergeWatchMinutes ?? 0;
  const prDecision = await decidePrContext(projPath);
  const comparisonRange = await computeComparisonRange(projPath);

  const facts: PlanFacts = {
    changes,
    unpushed,
    onlyTamtamMetadata,
    freshLgtm,
    testCmd,
    testsDisabled,
    reviewDisabled,
    shouldOpenPr: prDecision.shouldOpenPr,
    autoPrMergeEnabled,
    postMergeWatchMinutes,
    comparisonRange,
  };

  // The plan only describes steps; entry/steps are still computed even when
  // blocked so the operator can see what *would* run once the blocker clears,
  // except when there is literally nothing to release.
  const nothingToRelease = !changes && !unpushed;
  const entryStep = nothingToRelease ? null : computeEntryStep(facts);
  const runChain = entryStep ? simulateChain(entryStep, facts) : [];
  const runSet = new Set(runChain);

  const steps: PlanStep[] = CANONICAL_ORDER.map((kind) => {
    const willRun = runSet.has(kind);
    const step: PlanStep = {
      kind,
      willRun,
      reason: willRun ? runReason(kind, facts) : skipReason(kind, facts),
      sideEffects: willRun ? sideEffectsFor(kind, facts) : [],
    };
    if ((kind === 'review' || kind === 'push') && comparisonRange) {
      step.comparisonRange = comparisonRange;
    }
    return step;
  });

  return {
    project: projectName,
    canRelease: blockers.length === 0,
    blockers,
    mode: prDecision.shouldOpenPr ? 'pr' : 'direct',
    currentBranch: prDecision.currentBranch,
    targetBranch: prDecision.defaultBranch,
    comparisonRange,
    entryStep,
    steps,
  };
}
