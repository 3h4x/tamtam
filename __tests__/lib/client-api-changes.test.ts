import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function stubFetch(ok: boolean, body: object, status = ok ? 200 : 400) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? 'OK' : 'Bad Request',
      json: async () => body,
    }),
  );
  return vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
}

// ---------------------------------------------------------------------------
// pullProject + PullDivergedError
// ---------------------------------------------------------------------------

describe('pullProject', () => {
  async function getPullProject() {
    const { pullProject } = await import('@/lib/client-api');
    return pullProject;
  }

  it('returns status + output on success', async () => {
    stubFetch(true, { status: 'ok', output: 'Already up to date.' });
    const pullProject = await getPullProject();
    const result = await pullProject('myproj');
    expect(result).toEqual({ status: 'ok', output: 'Already up to date.' });
  });

  it('uses ff-only strategy by default', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', output: '' });
    const pullProject = await getPullProject();
    await pullProject('myproj');
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.strategy).toBe('ff-only');
  });

  it('passes the strategy to the server', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', output: '' });
    const pullProject = await getPullProject();
    await pullProject('myproj', 'rebase');
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.strategy).toBe('rebase');
  });

  it('throws PullDivergedError on 409 diverged response', async () => {
    stubFetch(false, { detail: 'diverged', diverged: true }, 409);
    const { pullProject, PullDivergedError } = await import('@/lib/client-api');
    await expect(pullProject('myproj')).rejects.toBeInstanceOf(PullDivergedError);
  });

  it('throws PullDivergedError with message "diverged"', async () => {
    stubFetch(false, { detail: 'diverged', diverged: true }, 409);
    const { pullProject, PullDivergedError } = await import('@/lib/client-api');
    await expect(pullProject('myproj')).rejects.toMatchObject({ message: 'diverged' });
    expect(PullDivergedError).toBeDefined();
  });

  it('throws generic error on non-diverged failure', async () => {
    stubFetch(false, { detail: 'network error' }, 422);
    const { pullProject } = await import('@/lib/client-api');
    await expect(pullProject('myproj')).rejects.toThrow('network error');
  });

  it('throws generic error using statusText when detail is absent', async () => {
    stubFetch(false, {}, 500);
    const { pullProject } = await import('@/lib/client-api');
    // response.json() succeeds with {} but detail is absent; falls back to statusText
    await expect(pullProject('myproj')).rejects.toThrow(/Pull failed/);
  });

  it('posts to the correct URL', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', output: '' });
    const pullProject = await getPullProject();
    await pullProject('my-project');
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain('/by-project/my-project/changes');
  });
});

// ---------------------------------------------------------------------------
// checkoutDefaultBranch
// ---------------------------------------------------------------------------

describe('checkoutDefaultBranch', () => {
  async function getCheckoutDefaultBranch() {
    const { checkoutDefaultBranch } = await import('@/lib/client-api');
    return checkoutDefaultBranch;
  }

  it('returns status and branch on success', async () => {
    stubFetch(true, { status: 'switched', branch: 'master' });
    const fn = await getCheckoutDefaultBranch();
    const result = await fn('myproj');
    expect(result).toEqual({ status: 'switched', branch: 'master' });
  });

  it('sends no body when carryChanges is not set', async () => {
    const fetchMock = stubFetch(true, { status: 'switched', branch: 'main' });
    const fn = await getCheckoutDefaultBranch();
    await fn('myproj');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.body).toBeUndefined();
  });

  it('sends carryChanges body when option is set', async () => {
    const fetchMock = stubFetch(true, { status: 'switched', branch: 'main' });
    const fn = await getCheckoutDefaultBranch();
    await fn('myproj', { carryChanges: true });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ carryChanges: true });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws with detail message on failure', async () => {
    stubFetch(false, { detail: 'uncommitted changes' }, 409);
    const fn = await getCheckoutDefaultBranch();
    await expect(fn('myproj')).rejects.toThrow('uncommitted changes');
  });

  it('throws fallback message when detail absent', async () => {
    stubFetch(false, {}, 500);
    const fn = await getCheckoutDefaultBranch();
    await expect(fn('myproj')).rejects.toThrow('Failed to switch branch');
  });
});

// ---------------------------------------------------------------------------
// pushProject
// ---------------------------------------------------------------------------

describe('pushProject', () => {
  async function getPushProject() {
    const { pushProject } = await import('@/lib/client-api');
    return pushProject;
  }

  it('returns status and job_id on success', async () => {
    stubFetch(true, { status: 'started', job_id: 'j1' });
    const fn = await getPushProject();
    const result = await fn('myproj');
    expect(result).toEqual({ status: 'started', job_id: 'j1' });
  });

  it('sends no body when commit option not set', async () => {
    const fetchMock = stubFetch(true, { status: 'started', job_id: 'j1' });
    const fn = await getPushProject();
    await fn('myproj');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('sends commit:true body when commit option is set', async () => {
    const fetchMock = stubFetch(true, { status: 'started', job_id: 'j1' });
    const fn = await getPushProject();
    await fn('myproj', { commit: true });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ commit: true });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws with detail on failure', async () => {
    stubFetch(false, { detail: 'pipeline is running' }, 409);
    const fn = await getPushProject();
    await expect(fn('myproj')).rejects.toThrow('pipeline is running');
  });

  it('throws fallback message when detail absent', async () => {
    stubFetch(false, {}, 500);
    const fn = await getPushProject();
    await expect(fn('myproj')).rejects.toThrow(/Failed to push/);
  });
});
