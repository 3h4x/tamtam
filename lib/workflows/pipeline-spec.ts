// Single source of truth for the release pipeline state machine.
//
// Both `decideNextPhase` (runtime) and `scripts/gen-workflow-graph.mjs`
// (build-time diagram) read from this file. Adding or changing a transition
// requires editing exactly one row here; the matcher and the SVG both update.
//
// Guards (lib/workflows/guards/*) still run AFTER decideNextPhase and may
// rewrite a decision. The `guardable` field on a row marks which guards may
// apply, so the generated diagram can annotate those edges. Guards stay
// imperative because they read sibling-job counts and prior-finding
// fingerprints — state that doesn't compress into a pure transition row.

import type { DecisionInputs, NextPhase } from './decide-next-phase';

// ─── Triggers ──────────────────────────────────────────────────────────────
// Entry-side documentation only. The orchestrator doesn't consume TRIGGERS;
// entry-side dispatch lives in the trigger files and the API route. Listed
// here so the diagram renders the full picture of "what starts a release".

export const TRIGGERS = [
  { id: 'agent-run',  label: 'Agent run',                    via: 'release-after-run gate' },
  { id: 'manual',     label: 'Manual UI / API POST',         via: 'direct' },
  { id: 'scheduled',  label: 'Scheduled agent cron tick',    via: 'agent-run → release-after-run gate' },
] as const;

// ─── Phase names ───────────────────────────────────────────────────────────

export type PhaseName =
  | 'test' | 'review' | 'fix' | 'commit' | 'push' | 'mark-dod' | 'pr-wait' | 'soak';
export type TerminalName = 'done' | 'abort' | 'unknown';
export type ExternalPhaseName = 'fix-ci';
export type TransitionTarget = PhaseName | TerminalName | ExternalPhaseName;

// ─── Transition pattern types ──────────────────────────────────────────────

export type PatternMatcher =
  | { eq: unknown }
  | { ne: unknown }
  | { truthy: true }
  | { falsy: true };

export type WhenClause = {
  [K in keyof DecisionInputs]?: DecisionInputs[K] | PatternMatcher;
} & {
  /** Presence check on optional input fields. Truthy = field is set and
   *  truthy; falsy = field is unset or falsy. */
  hasPushPrContext?: boolean;
  /** Presence check on the soak context — true means a positive
   *  `post_merge_watch_minutes` was resolved before this transition. */
  hasSoakContext?: boolean;
  /** Sentinel marking transitions fired OUTSIDE decideNextPhase — included
   *  for diagram completeness only. Spec-driven matcher ignores them. */
  external?: 'checks_failed' | 'exit 0';
};

export type GuardName = 'do-not-ship-policy' | 'convergence' | 'iteration-cap';

export interface Transition {
  /** Source phase (kind that just finished). */
  from: PhaseName | ExternalPhaseName;
  /** Pattern over DecisionInputs. First matching row wins (order matters). */
  when: WhenClause;
  /** Destination phase or terminal. */
  to: TransitionTarget;
  /** Mermaid edge label. */
  label: string;
  /** Metadata field names the dispatcher must propagate from inputs to the
   *  NextPhase output (e.g. 'testExitCode', 'pushPrContext'). */
  carries?: ReadonlyArray<'testExitCode' | 'verdict' | 'pushPrContext' | 'stopReason' | 'soakContext'>;
  /** Constant projection fields the matcher should set on the NextPhase. */
  set?: Record<string, string>;
  /** Guards that may rewrite this decision before dispatch. Diagram annotates
   *  these edges so guard presence is visually discoverable. */
  guardable?: ReadonlyArray<GuardName>;
  /** True when the transition fires outside decideNextPhase (e.g. dispatched
   *  by the pr-wait phase itself). Included for diagram completeness only;
   *  the matcher skips these rows. */
  external?: boolean;
}

// ─── Transitions ───────────────────────────────────────────────────────────
//
// Order matters within a `from` group: the first matching row wins. More
// specific clauses (e.g. test + reviewDisabled + dirty) must precede the
// general fallback (test + exitCode 0 → review).

export const TRANSITIONS: ReadonlyArray<Transition> = [
  // test
  { from: 'test', when: { exitCode: 0, reviewDisabled: true, hasUncommittedChanges: true },
    to: 'commit', label: 'review_disabled + dirty' },
  { from: 'test', when: { exitCode: 0, reviewDisabled: true },
    to: 'push',   label: 'review_disabled + clean' },
  { from: 'test', when: { exitCode: 0 },
    to: 'review', label: 'exit 0' },
  { from: 'test', when: { exitCode: { ne: 0 } },
    to: 'fix',    label: 'exit ≠ 0', carries: ['testExitCode'] },

  // review
  { from: 'review', when: { verdict: 'LGTM' },
    to: 'commit', label: 'LGTM' },
  { from: 'review', when: { verdict: 'DO NOT SHIP' },
    to: 'abort',  label: 'DO NOT SHIP',
    set: { verdict: 'DO NOT SHIP', stopReason: 'review verdict: DO NOT SHIP — release blocked' },
    guardable: ['do-not-ship-policy'] },
  // Anything else (NEEDS ATTENTION, null, unknown verdict) → fix.
  { from: 'review', when: {},
    to: 'fix',    label: 'NEEDS ATTENTION',
    set: { verdict: 'NEEDS ATTENTION' },
    guardable: ['convergence', 'iteration-cap'] },

  // commit
  { from: 'commit', when: { exitCode: 0 },
    to: 'push', label: 'exit 0' },
  { from: 'commit', when: { exitCode: { ne: 0 } },
    to: 'fix',  label: 'exit ≠ 0', guardable: ['iteration-cap'] },

  // push
  { from: 'push', when: { exitCode: 0 },
    to: 'mark-dod', label: 'exit 0' },
  { from: 'push', when: { exitCode: { ne: 0 } },
    to: 'fix',      label: 'exit ≠ 0', guardable: ['iteration-cap'] },

  // fix re-verifies its parent step
  { from: 'fix', when: { parentKind: 'test'   }, to: 'test',   label: 'parent test',   guardable: ['iteration-cap'] },
  { from: 'fix', when: { parentKind: 'review' }, to: 'review', label: 'parent review', guardable: ['iteration-cap'] },
  { from: 'fix', when: { parentKind: 'commit' }, to: 'commit', label: 'parent commit', guardable: ['iteration-cap'] },
  { from: 'fix', when: { parentKind: 'push'   }, to: 'push',   label: 'parent push',   guardable: ['iteration-cap'] },
  { from: 'fix', when: {},                       to: 'done',   label: 'no parent' },

  // mark-dod (ignores its own exitCode by design — see decide-next-phase.ts)
  { from: 'mark-dod', when: { autoPrMergeEnabled: true, hasPushPrContext: true },
    to: 'pr-wait', label: 'auto-merge + PR', carries: ['pushPrContext'] },
  { from: 'mark-dod', when: {},
    to: 'done',    label: 'otherwise' },

  // pr-wait → soak when the project opted in to a post-merge watch window;
  // otherwise pr-wait → done as before. checks_failed → fix-ci is dispatched
  // by the pr-wait phase itself, not by decideNextPhase; declared here so
  // the diagram shows the loop.
  { from: 'pr-wait', when: { exitCode: 0, hasSoakContext: true },
    to: 'soak', label: 'soak enabled', carries: ['soakContext'] },
  { from: 'pr-wait', when: {},
    to: 'done', label: 'merged' },
  { from: 'pr-wait', when: { external: 'checks_failed' },
    to: 'fix-ci', label: 'checks_failed', external: true },
  { from: 'fix-ci', when: { external: 'exit 0' },
    to: 'test', label: 'exit 0', external: true },

  // soak terminates the chain. Loop is verdict-driven (polls default-branch CI
  // on the merge commit until pass/fail; no time cap). On exit 0 the release
  // unlocks normally; on non-zero the soak step has already flipped
  // `projects.paused = true` and opened a revert PR, so the project stays
  // locked from new agent runs until a human resumes it from Settings.
  { from: 'soak', when: { exitCode: 0 }, to: 'done', label: 'ci passed — unlock' },
  { from: 'soak', when: {}, to: 'done', label: 'ci failed — project paused' },
];

// ─── Matcher ───────────────────────────────────────────────────────────────

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const m = expected as PatternMatcher & { eq?: unknown };
    if ('ne' in m) return actual !== m.ne;
    if ('eq' in m) return actual === m.eq;
    if ('truthy' in m) return !!actual;
    if ('falsy' in m) return !actual;
  }
  if (expected === true) return !!actual;
  if (expected === false) return !actual;
  return actual === expected;
}

export function matchesPattern(inputs: DecisionInputs, when: WhenClause): boolean {
  for (const [key, expected] of Object.entries(when)) {
    if (expected === undefined) continue;
    if (key === 'external') return false;          // never matched by runtime matcher
    if (key === 'hasPushPrContext') {
      const present = inputs.pushPrContext != null;
      if (expected === true && !present) return false;
      if (expected === false && present) return false;
      continue;
    }
    if (key === 'hasSoakContext') {
      const present = inputs.soakContext != null;
      if (expected === true && !present) return false;
      if (expected === false && present) return false;
      continue;
    }
    const actual = (inputs as unknown as Record<string, unknown>)[key];
    if (!matchValue(actual, expected)) return false;
  }
  return true;
}

// ─── Projection ────────────────────────────────────────────────────────────
//
// Build a NextPhase from a matched Transition + the DecisionInputs that
// matched it. Preserves the existing `NextPhase` union exactly so callers
// and tests stay compatible.

export function buildNextPhase(
  t: Transition,
  inputs: DecisionInputs,
): NextPhase {
  const from = inputs.kind as NextPhase['from'];
  const base: Record<string, unknown> = { next: t.to, from };
  if (t.set) Object.assign(base, t.set);
  if (t.carries) {
    for (const field of t.carries) {
      if (field === 'pushPrContext') {
        if (inputs.pushPrContext) base.pr = inputs.pushPrContext;
      } else if (field === 'soakContext') {
        if (inputs.soakContext) base.soak = inputs.soakContext;
      } else if (field === 'testExitCode') {
        base.testExitCode = inputs.exitCode;
      } else if (field === 'verdict') {
        if (inputs.verdict !== null && inputs.verdict !== undefined) base.verdict = inputs.verdict;
      } else if (field === 'stopReason') {
        // stopReason is set via `set`; carries['stopReason'] would be a passthrough
        // from inputs but DecisionInputs doesn't carry one. Kept for type completeness.
      }
    }
  }
  return base as NextPhase;
}
