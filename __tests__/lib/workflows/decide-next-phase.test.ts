import { describe, it, expect } from 'vitest';
import { decideNextPhase } from '@/lib/workflows/decide-next-phase';

describe('decideNextPhase', () => {
  describe('test kind', () => {
    it('exit 0 → review', () => {
      expect(decideNextPhase({ kind: 'test', exitCode: 0, verdict: null })).toEqual({
        next: 'review',
        from: 'test',
      });
    });

    it('exit 1 → fix with testExitCode', () => {
      expect(decideNextPhase({ kind: 'test', exitCode: 1, verdict: null })).toEqual({
        next: 'fix',
        from: 'test',
        testExitCode: 1,
      });
    });

    it('exit 137 (SIGKILL) → fix with that exit code', () => {
      expect(decideNextPhase({ kind: 'test', exitCode: 137, verdict: null })).toEqual({
        next: 'fix',
        from: 'test',
        testExitCode: 137,
      });
    });
  });

  describe('review kind', () => {
    it('verdict LGTM → push', () => {
      expect(decideNextPhase({ kind: 'review', exitCode: 0, verdict: 'LGTM' })).toEqual({
        next: 'push',
        from: 'review',
      });
    });

    it('verdict DO NOT SHIP → abort', () => {
      expect(decideNextPhase({ kind: 'review', exitCode: 0, verdict: 'DO NOT SHIP' })).toEqual({
        next: 'abort',
        from: 'review',
        verdict: 'DO NOT SHIP',
      });
    });

    it('verdict NEEDS ATTENTION → fix', () => {
      expect(decideNextPhase({ kind: 'review', exitCode: 0, verdict: 'NEEDS ATTENTION' })).toEqual({
        next: 'fix',
        from: 'review',
        verdict: 'NEEDS ATTENTION',
      });
    });

    it('verdict null → fix (treated as NEEDS ATTENTION)', () => {
      expect(decideNextPhase({ kind: 'review', exitCode: 0, verdict: null })).toEqual({
        next: 'fix',
        from: 'review',
        verdict: 'NEEDS ATTENTION',
      });
    });

    it('verdict null but exitCode failed → still fix (kind takes precedence)', () => {
      // Review jobs with non-zero exit still go through verdict logic;
      // a failed review run is "review didn't conclude" → fix.
      expect(decideNextPhase({ kind: 'review', exitCode: 1, verdict: null })).toEqual({
        next: 'fix',
        from: 'review',
        verdict: 'NEEDS ATTENTION',
      });
    });
  });

  describe('push kind', () => {
    it('exit 0 → mark-dod', () => {
      expect(decideNextPhase({ kind: 'push', exitCode: 0, verdict: null })).toEqual({
        next: 'mark-dod',
        from: 'push',
      });
    });

    it('exit 1 → fix (generic fix handles hook rejection from push)', () => {
      expect(decideNextPhase({ kind: 'push', exitCode: 1, verdict: null })).toEqual({
        next: 'fix',
        from: 'push',
      });
    });
  });

  describe('commit kind', () => {
    it('exit 0 → push', () => {
      expect(decideNextPhase({ kind: 'commit', exitCode: 0, verdict: null })).toEqual({
        next: 'push',
        from: 'commit',
      });
    });

    it('exit 1 → fix (commit hook rejected — fix and re-commit)', () => {
      expect(decideNextPhase({ kind: 'commit', exitCode: 1, verdict: null })).toEqual({
        next: 'fix',
        from: 'commit',
      });
    });
  });

  describe('fix kind — re-verifies the parent step', () => {
    it('parent test → next: test (re-run tests after fix)', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null, parentKind: 'test' })).toEqual({
        next: 'test',
        from: 'fix',
      });
    });

    it('parent review → next: review (re-run review after fix)', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null, parentKind: 'review' })).toEqual({
        next: 'review',
        from: 'fix',
      });
    });

    it('parent commit → next: commit (re-attempt commit after fix)', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null, parentKind: 'commit' })).toEqual({
        next: 'commit',
        from: 'fix',
      });
    });

    it('parent push → next: push (re-attempt push after fix-from-hook-rejection)', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null, parentKind: 'push' })).toEqual({
        next: 'push',
        from: 'fix',
      });
    });

    it('no parent → done (no step to re-verify)', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null })).toEqual({
        next: 'done',
        from: 'fix',
      });
    });

    it('null parent → done', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null, parentKind: null })).toEqual({
        next: 'done',
        from: 'fix',
      });
    });

    it('unknown parent kind → done (defensive fallback)', () => {
      expect(decideNextPhase({ kind: 'fix', exitCode: 0, verdict: null, parentKind: 'agent:foo' })).toEqual({
        next: 'done',
        from: 'fix',
      });
    });
  });

  describe('terminal kinds', () => {
    it.each(['mark-dod', 'pr-wait'] as const)(
      '%s → done',
      (kind) => {
        expect(decideNextPhase({ kind, exitCode: 0, verdict: null })).toEqual({
          next: 'done',
          from: kind,
        });
      },
    );
  });

  describe('unknown kinds', () => {
    it('release meta-job → unknown', () => {
      const r = decideNextPhase({ kind: 'release', exitCode: 0, verdict: null });
      expect(r).toMatchObject({ next: 'unknown', from: 'release' });
    });

    it('agent:* → unknown', () => {
      const r = decideNextPhase({ kind: 'agent:tests', exitCode: 0, verdict: null });
      expect(r).toMatchObject({ next: 'unknown', from: 'agent:tests' });
    });

    it('run → unknown', () => {
      const r = decideNextPhase({ kind: 'run', exitCode: 0, verdict: null });
      expect(r).toMatchObject({ next: 'unknown', from: 'run' });
    });

    it('empty kind → unknown', () => {
      const r = decideNextPhase({ kind: '', exitCode: 0, verdict: null });
      expect(r).toMatchObject({ next: 'unknown', from: '' });
    });
  });
});
