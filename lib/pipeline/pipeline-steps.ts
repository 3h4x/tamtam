// Registry of release-pipeline steps — drives the clickable chip row in the
// project Config tab. Built-in steps are declared here; third-party code can
// append steps via `registerPipelineStep` (e.g. from instrumentation at boot).
//
// The UI half only reads this registry — nothing in this file has side effects
// on the server, and nothing here imports React, so it is safe to unit-test in
// a Node-only vitest context.
//
// Forward-compatibility: `PipelineStep.id` is intentionally the same string as
// the server-side job `kind` (see `lib/job-storage.ts`). When a later PR adds a
// parallel server-side `registerStepRunner()` for execution logic, plugins will
// not have to coordinate two naming systems.

// The chip registry does not depend on the full ProjectConfig — it only needs
// the handful of fields the built-in steps inspect. Keeping the shape narrow
// lets plugins implement their own steps without depending on `lib/client-api`.
export interface StepConfigView {
  effective_test_command?: string;
  tests_disabled?: boolean;
  review_disabled?: boolean;
  auto_commit_enabled?: boolean;
  auto_push_enabled?: boolean;
  auto_pr_merge_enabled?: boolean;
}

export interface StepSetters {
  setAutoCommit: (v: boolean) => void;
  setAutoPush: (v: boolean) => void;
  setAutoMerge: (v: boolean) => void;
  setTestsDisabled: (v: boolean) => void;
  setReviewDisabled: (v: boolean) => void;
}

export interface StepToggleContext {
  config: StepConfigView;
  setters: StepSetters;
  focusElement: (id: string) => void;
}

export interface PipelineStep {
  id: string;
  label: string;
  mandatory: boolean;
  isActive: (ctx: StepToggleContext) => boolean;
  onToggle?: (ctx: StepToggleContext) => void;
  description: (ctx: StepToggleContext) => string;
}

export const BUILT_IN_STEPS: PipelineStep[] = [
  {
    id: 'test',
    label: 'test',
    mandatory: false,
    isActive: ({ config }) => !config.tests_disabled && !!config.effective_test_command,
    onToggle: ({ config, setters, focusElement }) => {
      // If currently running: disable. If disabled: re-enable (or focus input when no command).
      if (!config.tests_disabled && config.effective_test_command) {
        setters.setTestsDisabled(true);
      } else if (config.tests_disabled) {
        setters.setTestsDisabled(false);
      } else {
        focusElement('test-command');
      }
    },
    description: ({ config }) => {
      if (config.tests_disabled) return 'Tests are disabled. Click to re-enable.';
      if (config.effective_test_command) return `Runs \`${config.effective_test_command}\` before review. Click to disable.`;
      return 'No test command set. Click to configure.';
    },
  },
  {
    id: 'review',
    label: 'review',
    mandatory: false,
    isActive: ({ config }) => !config.review_disabled,
    onToggle: ({ config, setters }) => setters.setReviewDisabled(!config.review_disabled),
    description: ({ config }) => config.review_disabled
      ? 'Review is disabled — commit/push run without an AI verdict. Click to re-enable.'
      : 'Claude reviews the uncommitted diff and emits a verdict (LGTM / NEEDS ATTENTION / DO NOT SHIP). Click to disable when the agent prompt already covers review.',
  },
  {
    id: 'fix',
    label: 'fix',
    mandatory: true,
    isActive: ({ config }) => !config.review_disabled,
    description: ({ config }) => config.review_disabled
      ? 'Fix is skipped because review is disabled.'
      : 'On a NEEDS ATTENTION or DO NOT SHIP verdict, Claude applies fixes and re-reviews (capped at 3 iterations). Runs automatically when review is on.',
  },
  {
    id: 'commit',
    label: 'commit',
    mandatory: false,
    isActive: ({ config }) => !!config.auto_commit_enabled,
    onToggle: ({ config, setters }) => {
      const next = !config.auto_commit_enabled;
      setters.setAutoCommit(next);
      if (!next) {
        setters.setAutoPush(false);
        setters.setAutoMerge(false);
      }
    },
    description: ({ config }) => config.auto_commit_enabled
      ? 'On LGTM, stage and commit changes automatically. Click to disable (also disables push and merge).'
      : 'On LGTM, stage and commit changes automatically. Click to enable.',
  },
  {
    id: 'push',
    label: 'push',
    mandatory: false,
    isActive: ({ config }) => !!config.auto_push_enabled,
    onToggle: ({ config, setters }) => {
      const next = !config.auto_push_enabled;
      setters.setAutoPush(next);
      if (next) setters.setAutoCommit(true);
      if (!next) setters.setAutoMerge(false);
    },
    description: ({ config }) => config.auto_push_enabled
      ? 'Push to the current branch after auto-commit. Opens a PR when the branch is not the default. Click to disable.'
      : 'Push to the current branch after auto-commit. Opens a PR when the branch is not the default. Click to enable (also enables commit).',
  },
  {
    id: 'dod',
    label: 'dod',
    mandatory: true,
    isActive: () => true,
    description: () => 'Verifies DoD against the linked issue or the PR created by push. Skipped when the release has neither issue nor PR context.',
  },
  {
    id: 'merge',
    label: 'merge',
    mandatory: false,
    isActive: ({ config }) => !!config.auto_pr_merge_enabled,
    onToggle: ({ config, setters }) => {
      const next = !config.auto_pr_merge_enabled;
      setters.setAutoMerge(next);
      if (next) {
        setters.setAutoCommit(true);
        setters.setAutoPush(true);
      }
    },
    description: ({ config }) => config.auto_pr_merge_enabled
      ? 'Poll CI and auto-merge the PR once checks pass. Click to disable (PR stays open for manual merge).'
      : 'Poll CI and auto-merge the PR once checks pass. Click to enable (also enables commit + push).',
  },
];

// Built-in ordering — used to sort any plugin-registered steps that happen to
// reuse a built-in id (extras with unknown ids sort after the last built-in).
const BUILT_IN_ORDER = ['test', 'review', 'fix', 'commit', 'push', 'dod', 'merge'];

const EXTRA_STEPS: PipelineStep[] = [];

// Plugin seam — external code can call this at app startup to add steps.
export function registerPipelineStep(step: PipelineStep): void {
  EXTRA_STEPS.push(step);
}

// Test-only hook to reset registry between cases.
export function _resetExtraSteps(): void {
  EXTRA_STEPS.length = 0;
}

export function getPipelineSteps(): PipelineStep[] {
  const all = [...BUILT_IN_STEPS, ...EXTRA_STEPS];
  return all.sort((a, b) => {
    const ai = BUILT_IN_ORDER.indexOf(a.id);
    const bi = BUILT_IN_ORDER.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}
