import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isHookRejection, isTestFailureRejection } from '@/lib/pipeline/push-rejection';

describe('isHookRejection', () => {
  it('returns false for null/undefined/empty', () => {
    expect(isHookRejection(null)).toBe(false);
    expect(isHookRejection(undefined)).toBe(false);
    expect(isHookRejection('')).toBe(false);
  });

  it('detects husky', () => {
    expect(isHookRejection('husky - pre-commit hook exited with code 1')).toBe(true);
  });

  it('detects pre-commit', () => {
    expect(isHookRejection('pre-commit hook failed')).toBe(true);
  });

  it('detects pre-push', () => {
    expect(isHookRejection('pre-push hook rejected the push')).toBe(true);
  });

  it('detects lint-staged', () => {
    expect(isHookRejection('lint-staged found errors')).toBe(true);
  });

  it('detects eslint', () => {
    expect(isHookRejection('eslint found 3 errors')).toBe(true);
    expect(isHookRejection('ESLint: 1 error')).toBe(true);
  });

  it('detects @typescript-eslint rules', () => {
    expect(isHookRejection('@typescript-eslint/no-unused-vars')).toBe(true);
    expect(isHookRejection('error  Unnecessary escape character  @typescript-eslint/no-useless-escape')).toBe(true);
  });

  it('returns false for network/permission errors', () => {
    expect(isHookRejection('remote: permission denied')).toBe(false);
    expect(isHookRejection('error: failed to push some refs')).toBe(false);
    expect(isHookRejection('network timeout')).toBe(false);
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

  it('does not match plain lint/typecheck rejection text', () => {
    expect(isTestFailureRejection('eslint found 3 errors')).toBe(false);
    expect(isTestFailureRejection('@typescript-eslint/no-unused-vars')).toBe(false);
    expect(isTestFailureRejection('husky - pre-push script failed (code 1)')).toBe(false);
  });

  it('does not match the bare push-failed line', () => {
    expect(isTestFailureRejection('error: failed to push some refs to origin')).toBe(false);
  });
});
