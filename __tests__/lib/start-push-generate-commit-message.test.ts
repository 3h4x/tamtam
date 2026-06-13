import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── generateCommitMessage ────────────────────────────────────────────────────
//
// These tests need the *real* start-commit module (the rest of the start-push
// suite mocks it). We `vi.doUnmock` it and rebuild the module graph per test so
// the real implementation is loaded with our local mocks for its deps.
// This is the same pattern the original file used; it's the slowest block
// but only ~16 tests, and the alternative (extracting to a separate file)
// would create more I/O than it would save.

describe('generateCommitMessage', () => {
  let generateCommitMessage: typeof import('@/lib/pipeline/start-commit').generateCommitMessage;
  let execMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(async () => {
    vi.resetModules();
    // Ensure @/lib/pipeline/start-commit is NOT mocked so we test the real implementation.
    vi.doUnmock('@/lib/pipeline/start-commit');
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ commit_style: '' }),
      getPipelineModel: () => 'haiku',
      getPermissionModeFlag: () => '',
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
      getJob: vi.fn(() => null),
      createJob: vi.fn(),
      markDone: vi.fn(),
      updateJob: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => null,
    }));
    ({ generateCommitMessage } = await import('@/lib/pipeline/start-commit'));
  });

  afterEach(() => { vi.resetModules(); });

  it('passes --tools "" and --system-prompt to claude to prevent tool use and CLAUDE.md injection', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'file.ts | 1 +'))    // git diff --cached --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/file.ts')) // git diff --cached
      .mockImplementationOnce(() => resp(0, 'feat: add feature')); // claude

    await generateCommitMessage('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    expect(claudeCall).toBeTruthy();
    const args: string[] = claudeCall![1];
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('--print');
  });

  it('returns the commit message from a single-line claude response', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'fix(auth): correct token expiry logic'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('fix(auth): correct token expiry logic');
  });

  it('extracts conventional title from multiline response that includes prose', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'Here is the commit title:\n\nfeat(api): add rate limiting middleware'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('feat(api): add rate limiting middleware');
  });

  it('retries when first response matches generic GENERIC_RE pattern', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))                              // git diff --stat
      .mockImplementationOnce(() => resp(0, ''))                              // git diff
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))       // first claude → generic
      .mockImplementationOnce(() => resp(0, 'refactor(push): improve retry logic')); // retry claude

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('refactor(push): improve retry logic');
    const claudeCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'claude');
    expect(claudeCalls).toHaveLength(2);
  });

  it('retries when first response is "chore: update" (bare generic)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: update'))
      .mockImplementationOnce(() => resp(0, 'test(lib): add coverage for push helper'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('test(lib): add coverage for push helper');
  });

  it('retries when first response is empty', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))                              // empty first attempt
      .mockImplementationOnce(() => resp(0, 'chore(deps): bump dependencies'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore(deps): bump dependencies');
  });

  it('returns fallback when both attempts produce no usable output', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))   // first attempt: empty
      .mockImplementationOnce(() => resp(0, ''));  // retry: also empty

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update files');
  });

  it('does not return msg2 when it is also a generic placeholder', async () => {
    // msg1 is empty (triggers retry); msg2 is a generic placeholder.
    // Old behavior: returned msg2 because it was truthy.
    // New behavior: generic msg2 is filtered, falls through to 'chore: update files'.
    execMock
      .mockImplementationOnce(() => resp(0, ''))   // git diff --stat (no files)
      .mockImplementationOnce(() => resp(0, ''))   // git diff (no content)
      .mockImplementationOnce(() => resp(0, ''))   // first claude attempt: empty
      .mockImplementationOnce(() => resp(0, 'chore: update'));  // retry: generic

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).not.toBe('chore: update');
    expect(msg).toBe('chore: update files');
  });

  it('derives chore:update <files> from stat when both claude attempts are generic', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'lib/foo.ts | 3 +++\nlib/bar.ts | 1 -\n 2 files changed'))
      .mockImplementationOnce(() => resp(0, 'diff --git a/lib/foo.ts'))
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))  // first: generic
      .mockImplementationOnce(() => resp(0, 'chore: update'));           // retry: generic

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update lib/foo.ts, lib/bar.ts');
  });

  it('caps file-name fallback at 3 files', async () => {
    const stat = ['a.ts | 1', 'b.ts | 1', 'c.ts | 1', 'd.ts | 1'].join('\n');
    execMock
      .mockImplementationOnce(() => resp(0, stat))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: automated update'))
      .mockImplementationOnce(() => resp(0, 'chore: update'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore: update a.ts, b.ts, c.ts');
  });

  it('does not retry when first response is a specific conventional commit (not generic)', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore(ci): update workflow permissions'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('chore(ci): update workflow permissions');
    const claudeCalls = execMock.mock.calls.filter(([cmd]: any) => cmd === 'claude');
    expect(claudeCalls).toHaveLength(1);
  });

  it('prefers specific conventional line over generic one when both are in output', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'chore: automated update\nfeat(push): add stale-tracking rebase\nchore: update'));

    const msg = await generateCommitMessage('/proj', 'myrepo');
    expect(msg).toBe('feat(push): add stale-tracking rebase');
  });

  it('includes style guide in prompt when commit_style is set', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/pipeline/start-commit');
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({ commit_style: 'Always include a ticket number like PROJ-123.' }),
      getPipelineModel: () => 'haiku',
      getPermissionModeFlag: () => '',
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ claudeBin: 'claude', projects: {}, logDir: '/tmp' }),
      getProjectTestConfig: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: vi.fn().mockReturnValue([]),
      getJob: vi.fn(() => null),
      createJob: vi.fn(),
      markDone: vi.fn(),
      updateJob: vi.fn(),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock: vi.fn().mockReturnValue(null),
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('@/lib/skills/tamtam-file-config', () => ({
      loadFileConfig: () => null,
    }));
    const { generateCommitMessage: fn } = await import('@/lib/pipeline/start-commit');

    execMock
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, ''))
      .mockImplementationOnce(() => resp(0, 'feat: add something'));

    await fn('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    const prompt: string = claudeCall![1][claudeCall![1].indexOf('-p') + 1];
    expect(prompt).toContain('STYLE GUIDE');
    expect(prompt).toContain('Always include a ticket number');
  });

  it('includes diff context (stat + patch) in the prompt', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'lib/foo.ts | 5 +++++'))        // git diff --stat
      .mockImplementationOnce(() => resp(0, 'diff --git a/lib/foo.ts\n+const x = 1;')) // git diff
      .mockImplementationOnce(() => resp(0, 'feat: add foo'));

    await generateCommitMessage('/proj', 'myrepo');

    const claudeCall = execMock.mock.calls.find(([cmd]: any) => cmd === 'claude');
    const prompt: string = claudeCall![1][claudeCall![1].indexOf('-p') + 1];
    expect(prompt).toContain('lib/foo.ts');
    expect(prompt).toContain('myrepo');
  });
});
