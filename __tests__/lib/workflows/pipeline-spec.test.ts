import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRANSITIONS, TRIGGERS, matchesPattern, buildNextPhase } from '@/lib/workflows/pipeline-spec';
import { decideNextPhase, type DecisionInputs } from '@/lib/workflows/decide-next-phase';

// Drift check: the spec is the single source of truth for the state machine,
// and the spec must stay valid against the imperative dispatcher
// (lib/workflows/dispatch-phase.ts). If someone adds a transition that points
// at a phase the dispatcher doesn't know how to spawn, the orchestrator will
// fail at runtime — catch it here at test time instead.

const DISPATCHABLE_PHASES = new Set([
  'test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait',
]);
const TERMINAL_NAMES = new Set(['done', 'abort', 'unknown']);
const EXTERNAL_PHASES = new Set(['fix-ci']);

describe('pipeline-spec', () => {
  it('every transition.from is a dispatchable phase', () => {
    for (const t of TRANSITIONS) {
      expect(DISPATCHABLE_PHASES.has(t.from) || EXTERNAL_PHASES.has(t.from)).toBe(true);
    }
  });

  it('every transition.to is a dispatchable phase, a terminal, or an external phase', () => {
    for (const t of TRANSITIONS) {
      const target = t.to;
      const ok =
        DISPATCHABLE_PHASES.has(target as string) ||
        TERMINAL_NAMES.has(target as string) ||
        EXTERNAL_PHASES.has(target as string);
      expect({ row: `${t.from} -> ${target} (${t.label})`, ok }).toEqual(
        { row: `${t.from} -> ${target} (${t.label})`, ok: true },
      );
    }
  });

  it('dispatch-phase.ts handles every non-external phase listed as a TRANSITIONS.from', () => {
    const dispatchSrc = readFileSync(
      resolve(__dirname, '../../../lib/workflows/dispatch-phase.ts'),
      'utf-8',
    );
    const phasesFromSpec = new Set(
      TRANSITIONS.filter((t) => !t.external).map((t) => t.from),
    );
    for (const phase of phasesFromSpec) {
      expect(dispatchSrc).toContain(`case '${phase}'`);
    }
  });

  it('declares the entry-side trigger nodes the diagram renders', () => {
    const ids = TRIGGERS.map((t) => t.id);
    expect(ids).toContain('agent-run');
    expect(ids).toContain('manual');
    expect(ids).toContain('scheduled');
  });

  it('matchesPattern + buildNextPhase agree with decideNextPhase on representative cases', () => {
    const cases: Array<{ name: string; inputs: DecisionInputs }> = [
      { name: 'test pass → review',  inputs: { kind: 'test', exitCode: 0, verdict: null } },
      { name: 'test fail → fix',     inputs: { kind: 'test', exitCode: 2, verdict: null } },
      { name: 'review LGTM → commit', inputs: { kind: 'review', exitCode: 0, verdict: 'LGTM' } },
      { name: 'review DNS → abort',  inputs: { kind: 'review', exitCode: 0, verdict: 'DO NOT SHIP' } },
      { name: 'commit ok → push',    inputs: { kind: 'commit', exitCode: 0, verdict: null } },
      { name: 'push ok → mark-dod',  inputs: { kind: 'push', exitCode: 0, verdict: null } },
      { name: 'fix from push',       inputs: { kind: 'fix', exitCode: 0, verdict: null, parentKind: 'push' } },
      { name: 'mark-dod auto-merge', inputs: { kind: 'mark-dod', exitCode: 0, verdict: null, autoPrMergeEnabled: true, pushPrContext: { prNumber: 1, prRepo: 'x/y', prUrl: 'u' } } },
    ];
    for (const c of cases) {
      const fromDecide = decideNextPhase(c.inputs);
      const match = TRANSITIONS.find((t) => !t.external && t.from === c.inputs.kind && matchesPattern(c.inputs, t.when));
      expect(match, `no spec match for ${c.name}`).toBeDefined();
      const fromSpec = buildNextPhase(match!, c.inputs);
      expect({ case: c.name, out: fromDecide }).toEqual({ case: c.name, out: fromSpec });
    }
  });
});
