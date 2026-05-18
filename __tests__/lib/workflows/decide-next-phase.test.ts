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

    it('exit 0 + review disabled + uncommitted changes → commit', () => {
      expect(decideNextPhase({
        kind: 'test',
        exitCode: 0,
        verdict: null,
        reviewDisabled: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: false,
      })).toEqual({
        next: 'commit',
        from: 'test',
      });
    });

    it('exit 0 + review disabled + clean with unpushed commits → push', () => {
      expect(decideNextPhase({
        kind: 'test',
        exitCode: 0,
        verdict: null,
        reviewDisabled: true,
        hasUncommittedChanges: false,
        hasUnpushedCommits: true,
      })).toEqual({
        next: 'push',
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
    it('verdict LGTM → commit (then commit→push chains in next tick)', () => {
      // Routing through commit lets the pipeline pick up agent-produced
      // uncommitted edits before push, which would otherwise return "No
      // changes to push" for an untracked working tree.
      expect(decideNextPhase({ kind: 'review', exitCode: 0, verdict: 'LGTM' })).toEqual({
        next: 'commit',
        from: 'review',
      });
    });

    it('verdict DO NOT SHIP → abort with stopReason', () => {
      expect(decideNextPhase({ kind: 'review', exitCode: 0, verdict: 'DO NOT SHIP' })).toEqual({
        next: 'abort',
        from: 'review',
        verdict: 'DO NOT SHIP',
        stopReason: 'review verdict: DO NOT SHIP — release blocked',
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

    it('soak → done regardless of exit code', () => {
      expect(decideNextPhase({ kind: 'soak', exitCode: 0, verdict: null }))
        .toEqual({ next: 'done', from: 'soak' });
      expect(decideNextPhase({ kind: 'soak', exitCode: 1, verdict: null }))
        .toEqual({ next: 'done', from: 'soak' });
    });
  });

  describe('pr-wait → soak', () => {
    const soak = {
      mergeSha: 'deadbeef1234',
      prNumber: 7,
      prRepo: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/7',
      defaultBranch: 'main',
      watchMinutes: 15,
      autoRevert: false,
    };

    it('pr-wait exit 0 + soakContext present → soak', () => {
      expect(decideNextPhase({
        kind: 'pr-wait',
        exitCode: 0,
        verdict: null,
        soakContext: soak,
      })).toEqual({ next: 'soak', from: 'pr-wait', soak });
    });

    it('pr-wait exit 0 + soakContext absent → done', () => {
      expect(decideNextPhase({
        kind: 'pr-wait',
        exitCode: 0,
        verdict: null,
        soakContext: null,
      })).toEqual({ next: 'done', from: 'pr-wait' });
    });

    it('pr-wait exit nonzero + soakContext present → done (no soak after failed merge)', () => {
      expect(decideNextPhase({
        kind: 'pr-wait',
        exitCode: 1,
        verdict: null,
        soakContext: soak,
      })).toEqual({ next: 'done', from: 'pr-wait' });
    });
  });

  describe('mark-dod → pr-wait under auto-merge', () => {
    const pr = { prNumber: 113, prRepo: 'owner/repo', prUrl: 'https://github.com/owner/repo/pull/113' };

    it('mark-dod exit 0 + auto-merge + PR → pr-wait', () => {
      expect(decideNextPhase({
        kind: 'mark-dod',
        exitCode: 0,
        verdict: null,
        pushPrContext: pr,
        autoPrMergeEnabled: true,
      })).toEqual({ next: 'pr-wait', from: 'mark-dod', pr });
    });

    it('mark-dod exit 0 + auto-merge but no PR → done', () => {
      expect(decideNextPhase({
        kind: 'mark-dod',
        exitCode: 0,
        verdict: null,
        pushPrContext: null,
        autoPrMergeEnabled: true,
      })).toEqual({ next: 'done', from: 'mark-dod' });
    });

    it('mark-dod exit 0 + PR but auto-merge off → done', () => {
      expect(decideNextPhase({
        kind: 'mark-dod',
        exitCode: 0,
        verdict: null,
        pushPrContext: pr,
        autoPrMergeEnabled: false,
      })).toEqual({ next: 'done', from: 'mark-dod' });
    });

    it('mark-dod exit nonzero + auto-merge + PR → still pr-wait', () => {
      // Regression for "mark-dod-coercion-skips-auto-merge": mark-dod's
      // exit code is non-fatal (its job is to tick checkboxes; the push
      // already landed). Auto-merge releases must still poll the PR
      // regardless of mark-dod's exit, otherwise a PM2 restart that
      // exits mark-dod with -1 strands the PR open forever.
      expect(decideNextPhase({
        kind: 'mark-dod',
        exitCode: 1,
        verdict: null,
        pushPrContext: pr,
        autoPrMergeEnabled: true,
      })).toEqual({ next: 'pr-wait', from: 'mark-dod', pr });
    });

    it('mark-dod exit nonzero without auto-merge → done', () => {
      expect(decideNextPhase({
        kind: 'mark-dod',
        exitCode: 1,
        verdict: null,
        pushPrContext: pr,
        autoPrMergeEnabled: false,
      })).toEqual({ next: 'done', from: 'mark-dod' });
    });
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
