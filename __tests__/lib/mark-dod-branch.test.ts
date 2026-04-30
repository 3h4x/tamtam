import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ensureBranchForCtx', () => {
  let ensureBranchForCtx: typeof import('@/lib/pipeline/mark-dod-branch').ensureBranchForCtx;
  let execMock: ReturnType<typeof vi.fn>;
  const log = vi.fn();

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    ({ ensureBranchForCtx } = await import('@/lib/pipeline/mark-dod-branch'));
    log.mockClear();
  });

  it('isPr=true: switches to PR head branch when working tree is clean', async () => {
    execMock
      .mockReturnValueOnce(resp(0, JSON.stringify({ headRefName: 'feat/x' })))   // gh pr view
      .mockReturnValueOnce(resp(0, 'master\n'))                                   // git branch --show-current
      .mockReturnValueOnce(resp(0, ''))                                            // git status --porcelain (clean)
      .mockReturnValueOnce(resp(0, ''))                                            // git fetch
      .mockReturnValueOnce(resp(0, ''));                                           // git checkout
    const r = await ensureBranchForCtx('/proj', { number: 39, repo: 'o/r' }, true, log);
    expect(r.switched).toBe(true);
    if (r.switched) {
      expect(r.targetBranch).toBe('feat/x');
      expect(r.originalBranch).toBe('master');
    }
    const ghCall = execMock.mock.calls.find(([cmd, args]) => cmd === 'gh' && args.includes('pr') && args.includes('view'));
    expect(ghCall?.[1]).toContain('39');
    const checkoutCall = execMock.mock.calls.find(([cmd, args]) => cmd === 'git' && args.includes('checkout'));
    expect(checkoutCall?.[1]).toContain('feat/x');
  });

  it('isPr=false: finds linked PR via "closes #N" body match and switches', async () => {
    const prList = JSON.stringify([
      { number: 1, headRefName: 'unrelated', body: 'fixes #99' },
      { number: 2, headRefName: 'fix/issue-42', body: 'closes #42 and refactors X' },
    ]);
    execMock
      .mockReturnValueOnce(resp(0, prList))    // gh pr list
      .mockReturnValueOnce(resp(0, 'main\n'))  // git branch --show-current
      .mockReturnValueOnce(resp(0, ''))         // git status (clean)
      .mockReturnValueOnce(resp(0, ''))         // git fetch
      .mockReturnValueOnce(resp(0, ''));        // git checkout
    const r = await ensureBranchForCtx('/proj', { number: 42, repo: 'o/r' }, false, log);
    expect(r.switched).toBe(true);
    if (r.switched) expect(r.targetBranch).toBe('fix/issue-42');
  });

  it('skips when no linked PR exists for the issue', async () => {
    execMock.mockReturnValueOnce(resp(0, JSON.stringify([{ number: 1, headRefName: 'x', body: 'unrelated' }])));
    const r = await ensureBranchForCtx('/proj', { number: 42, repo: 'o/r' }, false, log);
    expect(r.switched).toBe(false);
    if (!r.switched) expect(r.skipped).toMatch(/no linked PR/);
  });

  it('skips when already on the target branch', async () => {
    execMock
      .mockReturnValueOnce(resp(0, JSON.stringify({ headRefName: 'feat/x' })))
      .mockReturnValueOnce(resp(0, 'feat/x\n'));
    const r = await ensureBranchForCtx('/proj', { number: 39, repo: 'o/r' }, true, log);
    expect(r.switched).toBe(false);
    if (!r.switched) expect(r.skipped).toMatch(/already on/);
  });

  it('refuses to switch when working tree has uncommitted changes', async () => {
    execMock
      .mockReturnValueOnce(resp(0, JSON.stringify({ headRefName: 'feat/x' })))
      .mockReturnValueOnce(resp(0, 'master\n'))
      .mockReturnValueOnce(resp(0, ' M lib/foo.ts\n')); // dirty
    const r = await ensureBranchForCtx('/proj', { number: 39, repo: 'o/r' }, true, log);
    expect(r.switched).toBe(false);
    if (!r.switched) expect(r.skipped).toMatch(/uncommitted/);
    const checkoutCall = execMock.mock.calls.find(([cmd, args]) => cmd === 'git' && args.includes('checkout'));
    expect(checkoutCall).toBeUndefined();
  });

  it('falls back to no-switch when checkout fails', async () => {
    execMock
      .mockReturnValueOnce(resp(0, JSON.stringify({ headRefName: 'feat/missing' })))
      .mockReturnValueOnce(resp(0, 'master\n'))
      .mockReturnValueOnce(resp(0, ''))                                  // clean
      .mockReturnValueOnce(resp(0, ''))                                  // git fetch (returns silently)
      .mockReturnValueOnce(resp(1, '', "error: pathspec 'feat/missing' did not match"));
    const r = await ensureBranchForCtx('/proj', { number: 39, repo: 'o/r' }, true, log);
    expect(r.switched).toBe(false);
    if (!r.switched) expect(r.skipped).toMatch(/checkout failed/);
  });

  it('tolerates gh failure (skips silently)', async () => {
    execMock.mockReturnValueOnce(resp(1, '', 'gh not authenticated'));
    const r = await ensureBranchForCtx('/proj', { number: 39, repo: 'o/r' }, true, log);
    expect(r.switched).toBe(false);
  });

  it('tolerates malformed gh JSON (skips silently)', async () => {
    execMock.mockReturnValueOnce(resp(0, 'not-json'));
    const r = await ensureBranchForCtx('/proj', { number: 39, repo: 'o/r' }, true, log);
    expect(r.switched).toBe(false);
  });
});
