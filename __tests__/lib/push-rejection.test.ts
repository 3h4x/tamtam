import { describe, it, expect } from 'vitest';
import { isHookRejection, isTestFailureRejection, isRemoteRaceRejection } from '@/lib/pipeline/push-rejection';

describe('isHookRejection', () => {
  it('returns false for null/undefined/empty', () => {
    expect(isHookRejection(null)).toBe(false);
    expect(isHookRejection(undefined)).toBe(false);
    expect(isHookRejection('')).toBe(false);
  });

  it('detects husky pre-commit script failure', () => {
    expect(isHookRejection('husky - pre-commit script failed (code 1)')).toBe(true);
  });

  it('detects husky pre-push script failure', () => {
    expect(isHookRejection('husky - pre-push script failed (code 1)')).toBe(true);
  });

  it('detects lint-staged failure banner', () => {
    expect(isHookRejection('lint-staged failed due to a git error.')).toBe(true);
  });

  it('detects pre-commit framework "hook id: … Failed" banner', () => {
    const log = 'check yaml..............................................................Failed\nhook id: check-yaml\n';
    expect(isHookRejection(log)).toBe(true);
  });

  // The whole point of the rewrite: a *successful* pre-push hook echoes
  // command names like "eslint", "husky", "pre-push" into the log even when
  // it passes. Those bare appearances must not match.
  it('does NOT match successful hook output that mentions eslint / husky', () => {
    const successfulPrePushLog = [
      'husky - pre-push hook started',
      '→ lint',
      '$ eslint app components lib hooks',
      '→ type-check',
      '$ tsc --noEmit',
      '→ tests',
      ' Test Files  324 passed (324)',
      '      Tests  4435 passed | 89 skipped (4524)',
    ].join('\n');
    expect(isHookRejection(successfulPrePushLog)).toBe(false);
  });

  // The reason this matters: when the hook passes but the push is rejected
  // by the remote (ref-lock race, branch protection), the log contains both
  // the successful hook output AND a `remote: …` rejection. We must not
  // misclassify that as a hook problem.
  it('does NOT match when the remote saw the push (remote: lines present)', () => {
    const remoteRejectedAfterCleanHook = [
      '$ eslint app components lib hooks',
      '$ tsc --noEmit',
      '$ vitest run --no-color',
      'remote: Bypassed rule violations for refs/heads/master:',
      'remote: - Changes must be made through a pull request.',
      'To github.com:owner/repo.git',
      " ! [remote rejected] master -> master (cannot lock ref 'refs/heads/master': is at A but expected B)",
      "error: failed to push some refs to 'github.com:owner/repo.git'",
    ].join('\n');
    expect(isHookRejection(remoteRejectedAfterCleanHook)).toBe(false);
  });

  it('returns false for plain network / permission errors', () => {
    expect(isHookRejection('remote: Permission denied')).toBe(false);
    expect(isHookRejection('error: failed to push some refs')).toBe(false);
    expect(isHookRejection('fatal: unable to access … Connection timed out')).toBe(false);
  });
});

describe('isRemoteRaceRejection', () => {
  it('returns false for null/undefined/empty', () => {
    expect(isRemoteRaceRejection(null)).toBe(false);
    expect(isRemoteRaceRejection(undefined)).toBe(false);
    expect(isRemoteRaceRejection('')).toBe(false);
  });

  it('detects the GitHub ref-lock race', () => {
    expect(isRemoteRaceRejection(
      " ! [remote rejected] master -> master (cannot lock ref 'refs/heads/master': is at A but expected B)"
    )).toBe(true);
  });

  it('detects classic non-fast-forward rejection', () => {
    expect(isRemoteRaceRejection(' ! [rejected]        master -> master (non-fast-forward)')).toBe(true);
  });

  it('detects "fetch first" hint', () => {
    expect(isRemoteRaceRejection('hint: Updates were rejected because the remote contains work that you do not have. Run git pull and fetch first.')).toBe(true);
  });

  it('detects "Updates were rejected" banner', () => {
    expect(isRemoteRaceRejection('hint: Updates were rejected because the tip of your current branch is behind')).toBe(true);
  });

  it('detects GitHub branch-protection "must be made through a pull request"', () => {
    expect(isRemoteRaceRejection('remote: - Changes must be made through a pull request.')).toBe(true);
  });

  it('detects GitHub "required status check" rejection', () => {
    expect(isRemoteRaceRejection('remote: error: Required status check "Lint and Test" is expected.')).toBe(true);
  });

  it('detects "protected branch" rejection', () => {
    expect(isRemoteRaceRejection('remote: error: refusing to allow a Personal Access Token to push to a protected branch')).toBe(true);
  });

  it('does not treat generic remote rejection as a remote race', () => {
    expect(isRemoteRaceRejection('! [remote rejected] feature-x -> feature-x (pre-receive hook declined)')).toBe(false);
  });

  it('returns false for hook / lint output', () => {
    expect(isRemoteRaceRejection('husky - pre-push script failed (code 1)')).toBe(false);
    expect(isRemoteRaceRejection('✖ 3 problems (3 errors, 0 warnings)')).toBe(false);
  });
});

describe('isTestFailureRejection', () => {
  it('returns false for null/undefined/empty', () => {
    expect(isTestFailureRejection(null)).toBe(false);
    expect(isTestFailureRejection(undefined)).toBe(false);
    expect(isTestFailureRejection('')).toBe(false);
  });

  it('detects vitest FAIL line', () => {
    expect(isTestFailureRejection(' FAIL  src/lib/api/sbt/merkle.integration.test.ts')).toBe(true);
  });

  it('detects "Tests failed" in script output', () => {
    expect(isTestFailureRejection('❌ Tests failed (exit: 1)')).toBe(true);
  });

  it('detects vitest summary "Test Files  1 failed"', () => {
    expect(isTestFailureRejection(' Test Files  1 failed | 130 passed | 2 skipped (133)')).toBe(true);
  });

  it('detects vitest summary "Tests  1 failed"', () => {
    expect(isTestFailureRejection('      Tests  1 failed | 1620 passed | 45 skipped (1666)')).toBe(true);
  });

  it('detects named test:* script failure', () => {
    expect(isTestFailureRejection('❌ FAILED: test:integration')).toBe(true);
    expect(isTestFailureRejection('test:unit failed')).toBe(true);
  });

  it('detects vitest runner output containing "vitest" and "fail"', () => {
    expect(isTestFailureRejection('vitest failed to run')).toBe(true);
    expect(isTestFailureRejection('running vitest… 3 tests fail')).toBe(true);
  });

  it('detects jest runner output containing "jest" and "fail"', () => {
    expect(isTestFailureRejection('jest: test suite failed to run')).toBe(true);
  });

  it('detects test:e2e script failure', () => {
    expect(isTestFailureRejection('test:e2e failed')).toBe(true);
  });

  it('detects "failing tests:" output', () => {
    expect(isTestFailureRejection('failing tests: 3')).toBe(true);
    expect(isTestFailureRejection('failing test: auth.spec.ts')).toBe(true);
  });

  it('does not match the bare push-failed line', () => {
    expect(isTestFailureRejection('error: failed to push some refs to origin')).toBe(false);
  });
});
