import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('startFixPush', () => {
  let startFixPush: typeof import('@/lib/start-fix-push').startFixPush;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: `${project}-${kind}-id`,
      project,
      kind,
      pid: 0,
      logPath: '',
      prompt: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    }));
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(12345);

    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj') }));
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-test', claudeBin: 'claude', projects: {} }),
    }));
    vi.doMock('@/lib/job-storage', () => ({ createJob: createJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/config', () => ({ getPermissionModeFlag: vi.fn().mockReturnValue('--dangerously-skip-permissions'), getSettings: vi.fn().mockReturnValue({ default_model: 'sonnet' }) }));

    ({ startFixPush } = await import('@/lib/start-fix-push'));
  });

  afterEach(() => { vi.resetModules(); });

  it('returns 404 when project path cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('@/lib/project-data', () => ({ resolveProjectPath: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/scheduling', () => ({ getImproveConfig: () => ({ logDir: '/tmp', claudeBin: 'claude', projects: {} }) }));
    vi.doMock('@/lib/job-storage', () => ({ createJob: createJobMock, updateJob: updateJobMock }));
    vi.doMock('@/lib/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/config', () => ({ getPermissionModeFlag: vi.fn().mockReturnValue(''), getSettings: vi.fn().mockReturnValue({ default_model: 'sonnet' }) }));
    const { startFixPush: fn } = await import('@/lib/start-fix-push');

    const r = await fn('missing-proj', 'pre-commit hook failed');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.detail).toContain('not found');
    }
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns ok:true with jobId, pid, logPath on success', async () => {
    const r = await startFixPush('myproj', 'eslint found 3 errors');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toContain('myproj');
      expect(r.pid).toBe(12345);
      expect(r.logPath).toMatch(/\.log$/);
    }
    expect(startJobMock).toHaveBeenCalledTimes(1);
    expect(updateJobMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 and marks job failed when startJob throws', async () => {
    startJobMock.mockRejectedValue(new Error('pm2 not available'));
    const r = await startFixPush('myproj', 'husky pre-commit failed');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.detail).toContain('pm2 not available');
    }
    expect(updateJobMock).toHaveBeenCalled();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

  it('truncates hookError longer than 8000 chars and adds truncation marker', async () => {
    const longError = 'x'.repeat(9000);
    await startFixPush('myproj', longError);
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('...(truncated)...');
    expect(prompt.length).toBeLessThan(longError.length + 500);
  });

  it('includes project name and hook error verbatim in the prompt', async () => {
    await startFixPush('myproj', 'pre-push hook failed: eslint error on line 42');
    const [, , prompt] = startJobMock.mock.calls[0];
    expect(prompt).toContain('myproj');
    expect(prompt).toContain('pre-push hook failed: eslint error on line 42');
  });
});
