import { describe, it, expect } from 'vitest';
import { isHookRejection } from '@/lib/start-fix-push';

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
