import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPipelineSteps,
  registerPipelineStep,
  _resetExtraSteps,
  BUILT_IN_STEPS,
  type PipelineStep,
  type StepToggleContext,
} from '@/lib/pipeline-steps';

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

  it('returns five built-in steps in direct mode', () => {
    const ids = getPipelineSteps('direct').map(s => s.id);
    expect(ids).toEqual(['test', 'review', 'fix', 'commit', 'push']);
  });

  it('returns seven built-in steps in pr mode (dod + merge added)', () => {
    const ids = getPipelineSteps('pr').map(s => s.id);
    expect(ids).toEqual(['test', 'review', 'fix', 'commit', 'push', 'dod', 'merge']);
  });

  it('marks fix + dod as mandatory (review is toggleable; fix is always gated by review)', () => {
    const mandatory = BUILT_IN_STEPS.filter(s => s.mandatory).map(s => s.id).sort();
    expect(mandatory).toEqual(['dod', 'fix']);
  });

  it('review toggle flips review_disabled', () => {
    const review = BUILT_IN_STEPS.find(s => s.id === 'review')!;
    const calls: boolean[] = [];
    const ctx = makeCtx({ review_disabled: false });
    ctx.setters.setReviewDisabled = v => calls.push(v);
    review.onToggle!(ctx);
    expect(calls).toEqual([true]);
    const ctx2 = makeCtx({ review_disabled: true });
    const calls2: boolean[] = [];
    ctx2.setters.setReviewDisabled = v => calls2.push(v);
    review.onToggle!(ctx2);
    expect(calls2).toEqual([false]);
  });

  it('fix is inactive when review is disabled, active otherwise', () => {
    const fix = BUILT_IN_STEPS.find(s => s.id === 'fix')!;
    expect(fix.isActive(makeCtx({ review_disabled: false }))).toBe(true);
    expect(fix.isActive(makeCtx({ review_disabled: true }))).toBe(false);
  });

  it('fix has no onToggle (always gated by review)', () => {
    const fix = BUILT_IN_STEPS.find(s => s.id === 'fix')!;
    expect(fix.onToggle).toBeUndefined();
  });

  it('keeps plugin-registered steps in insertion order after built-ins when id is unknown', () => {
    const plugin: PipelineStep = {
      id: 'notify-slack',
      label: 'notify',
      modes: ['direct', 'pr'],
      mandatory: false,
      isActive: () => false,
      description: () => 'Send Slack notification',
    };
    registerPipelineStep(plugin);
    const ids = getPipelineSteps('direct').map(s => s.id);
    expect(ids[ids.length - 1]).toBe('notify-slack');
  });

  it('filters plugin steps by mode', () => {
    registerPipelineStep({
      id: 'pr-only-step',
      label: 'pr-only',
      modes: ['pr'],
      mandatory: false,
      isActive: () => true,
      description: () => '',
    });
    expect(getPipelineSteps('direct').map(s => s.id)).not.toContain('pr-only-step');
    expect(getPipelineSteps('pr').map(s => s.id)).toContain('pr-only-step');
  });
});

describe('built-in step behavior', () => {
  beforeEach(() => { _resetExtraSteps(); });

  it('test is active when effective_test_command is set and tests_disabled is false', () => {
    const test = BUILT_IN_STEPS.find(s => s.id === 'test')!;
    expect(test.isActive(makeCtx({ effective_test_command: 'pnpm test' }))).toBe(true);
    expect(test.isActive(makeCtx({ effective_test_command: '' }))).toBe(false);
    expect(test.isActive(makeCtx({ effective_test_command: 'pnpm test', tests_disabled: true }))).toBe(false);
  });

  it('test chip: active command → click disables', () => {
    const test = BUILT_IN_STEPS.find(s => s.id === 'test')!;
    const calls: boolean[] = [];
    const ctx = makeCtx({ effective_test_command: 'pnpm test' });
    ctx.setters.setTestsDisabled = v => calls.push(v);
    test.onToggle!(ctx);
    expect(calls).toEqual([true]);
  });

  it('test chip: disabled → click re-enables', () => {
    const test = BUILT_IN_STEPS.find(s => s.id === 'test')!;
    const calls: boolean[] = [];
    const ctx = makeCtx({ effective_test_command: 'pnpm test', tests_disabled: true });
    ctx.setters.setTestsDisabled = v => calls.push(v);
    test.onToggle!(ctx);
    expect(calls).toEqual([false]);
  });

  it('test chip: no command + not disabled → click focuses input', () => {
    const test = BUILT_IN_STEPS.find(s => s.id === 'test')!;
    let focused: string | null = null;
    const disabledCalls: boolean[] = [];
    const ctx = makeCtx({ effective_test_command: '' });
    ctx.focusElement = id => { focused = id; };
    ctx.setters.setTestsDisabled = v => disabledCalls.push(v);
    test.onToggle!(ctx);
    expect(focused).toBe('test-command');
    expect(disabledCalls).toEqual([]);
  });

  it('commit toggle enables commit and cascades off push + merge when disabling', () => {
    const commit = BUILT_IN_STEPS.find(s => s.id === 'commit')!;
    const calls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const ctx = makeCtx({ auto_commit_enabled: true, auto_push_enabled: true, auto_pr_merge_enabled: true });
    ctx.setters.setAutoCommit = v => calls.commit.push(v);
    ctx.setters.setAutoPush = v => calls.push.push(v);
    ctx.setters.setAutoMerge = v => calls.merge.push(v);
    commit.onToggle!(ctx);
    expect(calls.commit).toEqual([false]);
    expect(calls.push).toEqual([false]);
    expect(calls.merge).toEqual([false]);
  });

  it('push toggle enables commit when enabling push', () => {
    const push = BUILT_IN_STEPS.find(s => s.id === 'push')!;
    const calls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const ctx = makeCtx({ auto_push_enabled: false });
    ctx.setters.setAutoCommit = v => calls.commit.push(v);
    ctx.setters.setAutoPush = v => calls.push.push(v);
    ctx.setters.setAutoMerge = v => calls.merge.push(v);
    push.onToggle!(ctx);
    expect(calls.push).toEqual([true]);
    expect(calls.commit).toEqual([true]);
  });

  it('push toggle off cascades merge off', () => {
    const push = BUILT_IN_STEPS.find(s => s.id === 'push')!;
    const calls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const ctx = makeCtx({ auto_push_enabled: true, auto_pr_merge_enabled: true });
    ctx.setters.setAutoCommit = v => calls.commit.push(v);
    ctx.setters.setAutoPush = v => calls.push.push(v);
    ctx.setters.setAutoMerge = v => calls.merge.push(v);
    push.onToggle!(ctx);
    expect(calls.push).toEqual([false]);
    expect(calls.merge).toEqual([false]);
  });

  it('merge toggle enabling cascades commit + push on', () => {
    const merge = BUILT_IN_STEPS.find(s => s.id === 'merge')!;
    const calls: Record<string, boolean[]> = { commit: [], push: [], merge: [] };
    const ctx = makeCtx({ auto_pr_merge_enabled: false });
    ctx.setters.setAutoCommit = v => calls.commit.push(v);
    ctx.setters.setAutoPush = v => calls.push.push(v);
    ctx.setters.setAutoMerge = v => calls.merge.push(v);
    merge.onToggle!(ctx);
    expect(calls.merge).toEqual([true]);
    expect(calls.commit).toEqual([true]);
    expect(calls.push).toEqual([true]);
  });

  it('dod has no onToggle (mandatory)', () => {
    const step = BUILT_IN_STEPS.find(s => s.id === 'dod')!;
    expect(step.onToggle).toBeUndefined();
  });

  it('description varies based on pr_workflow_enabled for push', () => {
    const push = BUILT_IN_STEPS.find(s => s.id === 'push')!;
    const direct = push.description(makeCtx({ auto_push_enabled: true, pr_workflow_enabled: false }));
    const pr = push.description(makeCtx({ auto_push_enabled: true, pr_workflow_enabled: true }));
    expect(direct).toMatch(/origin/);
    expect(pr).toMatch(/feature\/issue branch/);
  });
});
