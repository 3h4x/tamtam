import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILT_IN_STEPS,
  _resetExtraSteps,
  getPipelineSteps,
  registerPipelineStep,
  type PipelineStep,
  type StepToggleContext,
} from '@/lib/pipeline/pipeline-steps';

function makeCtx(overrides: Partial<StepToggleContext['config']> = {}): StepToggleContext {
  return {
    config: { ...overrides },
    setters: {
      setAutoCommit: () => {},
      setAutoPush: () => {},
      setAutoMerge: () => {},
      setTestsDisabled: () => {},
      setReviewDisabled: () => {},
    },
    focusElement: () => {},
  };
}

describe('getPipelineSteps', () => {
  beforeEach(() => { _resetExtraSteps(); });

  it('returns the unified built-in step registry in order', () => {
    expect(getPipelineSteps().map(s => s.id)).toEqual(['test', 'review', 'fix', 'commit', 'push', 'dod', 'merge', 'soak']);
  });

  it('marks fix and dod as mandatory', () => {
    const mandatory = BUILT_IN_STEPS.filter(s => s.mandatory).map(s => s.id).sort();
    expect(mandatory).toEqual(['dod', 'fix']);
  });

  it('keeps plugin steps after built-ins when their ids are unknown', () => {
    const plugin: PipelineStep = {
      id: 'notify-slack',
      label: 'notify',
      mandatory: false,
      isActive: () => false,
      description: () => 'Send Slack notification',
    };
    registerPipelineStep(plugin);
    expect(getPipelineSteps().at(-1)?.id).toBe('notify-slack');
  });
});

describe('built-in step behavior', () => {
  beforeEach(() => { _resetExtraSteps(); });

  it('test step toggles between disable, re-enable, and focus-configure states', () => {
    const test = BUILT_IN_STEPS.find(s => s.id === 'test')!;

    const disableCalls: boolean[] = [];
    const activeCtx = makeCtx({ effective_test_command: 'pnpm test' });
    activeCtx.setters.setTestsDisabled = v => disableCalls.push(v);
    test.onToggle!(activeCtx);
    expect(disableCalls).toEqual([true]);

    const enableCalls: boolean[] = [];
    const disabledCtx = makeCtx({ effective_test_command: 'pnpm test', tests_disabled: true });
    disabledCtx.setters.setTestsDisabled = v => enableCalls.push(v);
    test.onToggle!(disabledCtx);
    expect(enableCalls).toEqual([false]);

    let focused: string | null = null;
    const focusCtx = makeCtx({ effective_test_command: '' });
    focusCtx.focusElement = id => { focused = id; };
    test.onToggle!(focusCtx);
    expect(focused).toBe('test-command');
  });

  it('review toggle flips review_disabled', () => {
    const review = BUILT_IN_STEPS.find(s => s.id === 'review')!;
    const calls: boolean[] = [];
    const ctx = makeCtx({ review_disabled: false });
    ctx.setters.setReviewDisabled = v => calls.push(v);
    review.onToggle!(ctx);
    expect(calls).toEqual([true]);
  });

  it('fix stays mandatory, untoggleable, and only active when review is enabled', () => {
    const fix = BUILT_IN_STEPS.find(s => s.id === 'fix')!;
    expect(fix.onToggle).toBeUndefined();
    expect(fix.isActive(makeCtx({ review_disabled: false }))).toBe(true);
    expect(fix.isActive(makeCtx({ review_disabled: true }))).toBe(false);
  });

  it('commit toggle disables push and merge when turning commit off', () => {
    const commit = BUILT_IN_STEPS.find(s => s.id === 'commit')!;
    const calls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const ctx = makeCtx({ auto_commit_enabled: true, auto_push_enabled: true, auto_pr_merge_enabled: true });
    ctx.setters.setAutoCommit = v => calls.commit.push(v);
    ctx.setters.setAutoPush = v => calls.push.push(v);
    ctx.setters.setAutoMerge = v => calls.merge.push(v);
    commit.onToggle!(ctx);
    expect(calls).toEqual({ commit: [false], push: [false], merge: [false] });
  });

  it('push toggle enables commit on the way up and disables merge on the way down', () => {
    const push = BUILT_IN_STEPS.find(s => s.id === 'push')!;

    const enableCalls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const enableCtx = makeCtx({ auto_push_enabled: false });
    enableCtx.setters.setAutoCommit = v => enableCalls.commit.push(v);
    enableCtx.setters.setAutoPush = v => enableCalls.push.push(v);
    enableCtx.setters.setAutoMerge = v => enableCalls.merge.push(v);
    push.onToggle!(enableCtx);
    expect(enableCalls).toEqual({ commit: [true], push: [true], merge: [] });

    const disableCalls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const disableCtx = makeCtx({ auto_push_enabled: true, auto_pr_merge_enabled: true });
    disableCtx.setters.setAutoCommit = v => disableCalls.commit.push(v);
    disableCtx.setters.setAutoPush = v => disableCalls.push.push(v);
    disableCtx.setters.setAutoMerge = v => disableCalls.merge.push(v);
    push.onToggle!(disableCtx);
    expect(disableCalls).toEqual({ commit: [], push: [false], merge: [false] });
  });

  it('push description describes both direct pushes and PR creation', () => {
    const push = BUILT_IN_STEPS.find(s => s.id === 'push')!;
    expect(push.description(makeCtx({ auto_push_enabled: true }))).toMatch(/current branch/);
    expect(push.description(makeCtx({ auto_push_enabled: true }))).toMatch(/Opens a PR/);
  });

  it('dod is always active and describes both issue and PR context', () => {
    const dod = BUILT_IN_STEPS.find(s => s.id === 'dod')!;
    expect(dod.onToggle).toBeUndefined();
    expect(dod.isActive(makeCtx())).toBe(true);
    expect(dod.description(makeCtx())).toMatch(/linked issue or the PR created by push/);
    expect(dod.description(makeCtx())).toMatch(/issue nor PR context/);
  });

  it('merge toggle enables commit and push when auto-merge is turned on', () => {
    const merge = BUILT_IN_STEPS.find(s => s.id === 'merge')!;
    const calls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const ctx = makeCtx({ auto_pr_merge_enabled: false });
    ctx.setters.setAutoCommit = v => calls.commit.push(v);
    ctx.setters.setAutoPush = v => calls.push.push(v);
    ctx.setters.setAutoMerge = v => calls.merge.push(v);
    merge.onToggle!(ctx);
    expect(calls).toEqual({ commit: [true], push: [true], merge: [true] });
  });
});
