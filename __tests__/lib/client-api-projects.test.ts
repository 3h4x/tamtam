import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function stubFetch(ok: boolean, body: object, status = ok ? 200 : 400, statusText = ok ? 'OK' : 'Bad Request') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      statusText,
      json: async () => body,
    }),
  );
  return vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
}

describe('releaseProject', () => {
  async function getReleaseProject() {
    const { releaseProject } = await import('@/lib/client-api');
    return releaseProject;
  }

  it('encodes the project name and posts without a JSON body by default', async () => {
    const fetchMock = stubFetch(true, { status: 'started', message: 'ok', job_id: 'j1' });
    const releaseProject = await getReleaseProject();

    const result = await releaseProject('owner/repo name');

    expect(result).toEqual({ status: 'started', message: 'ok', job_id: 'j1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/owner%2Frepo%20name/release');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('sends queue_if_blocked when queueing is requested', async () => {
    const fetchMock = stubFetch(true, { status: 'queued', message: 'queued', release_job_id: 'r1' });
    const releaseProject = await getReleaseProject();

    await releaseProject('myproj', { queueIfBlocked: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ queue_if_blocked: true, source_job_id: undefined });
  });

  it('sends source_job_id when provided without queueing', async () => {
    const fetchMock = stubFetch(true, { status: 'started', message: 'ok', release_job_id: 'r2' });
    const releaseProject = await getReleaseProject();

    await releaseProject('myproj', { sourceJobId: 'job-42' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ queue_if_blocked: false, source_job_id: 'job-42' });
  });

  it('throws a pipeline-locked error with blocking job metadata', async () => {
    stubFetch(false, { detail: 'release already running', blocking_job_id: 'job-99' }, 409, 'Conflict');
    const releaseProject = await getReleaseProject();

    await expect(releaseProject('myproj')).rejects.toMatchObject({
      message: 'release already running',
      blockingJobId: 'job-99',
      isPipelineLocked: true,
    });
  });

  it('does not mark non-409 failures as pipeline locks', async () => {
    stubFetch(false, { detail: 'budget blocked' }, 429, 'Too Many Requests');
    const releaseProject = await getReleaseProject();

    await expect(releaseProject('myproj')).rejects.toMatchObject({
      message: 'budget blocked',
      blockingJobId: undefined,
      isPipelineLocked: false,
    });
  });

  it('falls back to the HTTP status text when detail is absent', async () => {
    stubFetch(false, {}, 500, 'Internal Server Error');
    const releaseProject = await getReleaseProject();

    await expect(releaseProject('myproj')).rejects.toThrow('Failed to start release: Internal Server Error');
  });
});

describe('project config client helpers', () => {
  async function getClientApi() {
    const { fetchProjectConfig, updateProjectConfig } = await import('@/lib/client-api');
    return { fetchProjectConfig, updateProjectConfig };
  }

  it('fetchProjectConfig encodes the project name in the URL', async () => {
    const fetchMock = stubFetch(true, { test_command: 'pnpm test' });
    const { fetchProjectConfig } = await getClientApi();

    const result = await fetchProjectConfig('owner/repo name');

    expect(result).toEqual({ test_command: 'pnpm test' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/by-project/owner%2Frepo%20name/config');
  });

  it('updateProjectConfig patches JSON to the encoded config endpoint', async () => {
    const fetchMock = stubFetch(true, { status: 'ok' });
    const { updateProjectConfig } = await getClientApi();

    const result = await updateProjectConfig('owner/repo name', {
      auto_push_enabled: true,
      review_disabled: false,
      test_command: 'pnpm test',
    });

    expect(result).toEqual({ status: 'ok' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/owner%2Frepo%20name/config');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      auto_push_enabled: true,
      review_disabled: false,
      test_command: 'pnpm test',
    });
  });

  it('updateProjectConfig surfaces API detail errors', async () => {
    stubFetch(false, { detail: 'invalid schedule' }, 400);
    const { updateProjectConfig } = await getClientApi();

    await expect(updateProjectConfig('proj', { test_cron_schedule: 'wat' })).rejects.toThrow('invalid schedule');
  });

  it('fetchProjectConfig uses the status text in fallback errors', async () => {
    stubFetch(false, {}, 503, 'Service Unavailable');
    const { fetchProjectConfig } = await getClientApi();

    await expect(fetchProjectConfig('proj')).rejects.toThrow('Failed to fetch project config: Service Unavailable');
  });
});

describe('project client helper fallbacks', () => {
  async function getClientApi() {
    const {
      createProjectPR,
      fetchRecommendations,
      fetchBehind,
      fetchCustomActions,
      runMarkDod,
      runCustomAction,
      saveCustomActions,
      updateRecommendation,
    } = await import('@/lib/client-api');
    return {
      createProjectPR,
      fetchRecommendations,
      fetchBehind,
      fetchCustomActions,
      runMarkDod,
      runCustomAction,
      saveCustomActions,
      updateRecommendation,
    };
  }

  it('fetchBehind falls back to zero counts on non-ok responses', async () => {
    stubFetch(false, { detail: 'boom' }, 500, 'Server Error');
    const { fetchBehind } = await getClientApi();

    await expect(fetchBehind('proj')).resolves.toEqual({ behind: 0, ahead: 0 });
  });

  it('fetchCustomActions encodes the project name and falls back to an empty list', async () => {
    const fetchMock = stubFetch(false, { detail: 'nope' }, 404, 'Not Found');
    const { fetchCustomActions } = await getClientApi();

    await expect(fetchCustomActions('owner/repo name')).resolves.toEqual({ actions: [] });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/by-project/owner%2Frepo%20name/action');
  });

  it('createProjectPR uses API detail errors and otherwise falls back to the default message', async () => {
    stubFetch(false, { detail: 'branch is default' }, 400, 'Bad Request');
    const { createProjectPR } = await getClientApi();

    await expect(createProjectPR('proj')).rejects.toThrow('branch is default');
  });

  it('createProjectPR falls back when the API does not return detail', async () => {
    stubFetch(false, {}, 500, 'Internal Server Error');
    const { createProjectPR } = await getClientApi();

    await expect(createProjectPR('proj')).rejects.toThrow('Failed to create PR');
  });

  it('runMarkDod posts JSON context and surfaces fallback errors', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', updated: 2, checked: ['A'] });
    const { runMarkDod } = await getClientApi();

    await expect(runMarkDod('proj', { issue_number: 12, repo: 'owner/repo' })).resolves.toEqual({
      status: 'ok',
      updated: 2,
      checked: ['A'],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/proj/mark-dod');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ issue_number: 12, repo: 'owner/repo' });
  });

  it('runMarkDod uses the generic fallback error when detail is absent', async () => {
    stubFetch(false, {}, 500, 'Internal Server Error');
    const { runMarkDod } = await getClientApi();

    await expect(runMarkDod('proj', { pr_number: 7, repo: 'owner/repo' })).rejects.toThrow(
      'Failed to run DoD verification',
    );
  });

  it('saveCustomActions sends the actions payload and runCustomAction surfaces detail errors', async () => {
    const fetchMock = stubFetch(true, {
      status: 'ok',
      actions: [{ name: 'Deploy', command: 'pnpm deploy', color: 'green' }],
    });
    const { runCustomAction, saveCustomActions } = await getClientApi();

    await expect(
      saveCustomActions('owner/repo name', [{ name: 'Deploy', command: 'pnpm deploy', color: 'green' }]),
    ).resolves.toEqual({
      status: 'ok',
      actions: [{ name: 'Deploy', command: 'pnpm deploy', color: 'green' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/owner%2Frepo%20name/action');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      actions: [{ name: 'Deploy', command: 'pnpm deploy', color: 'green' }],
    });

    stubFetch(false, { detail: 'action disabled' }, 409, 'Conflict');
    await expect(runCustomAction('proj', 'Deploy')).rejects.toThrow('action disabled');
  });

  it('fetchRecommendations encodes the project name and returns the payload', async () => {
    const fetchMock = stubFetch(true, {
      recommendations: [{ id: 'rec-1', type: 'agent_schedule_backoff', status: 'open' }],
    });
    const { fetchRecommendations } = await getClientApi();

    await expect(fetchRecommendations('owner/repo name')).resolves.toEqual({
      recommendations: [{ id: 'rec-1', type: 'agent_schedule_backoff', status: 'open' }],
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/by-project/owner%2Frepo%20name/recommendations');
  });

  it('updateRecommendation patches JSON and surfaces detail errors', async () => {
    const fetchMock = stubFetch(true, {
      recommendation: { id: 'rec-1', status: 'dismissed' },
    });
    const { updateRecommendation } = await getClientApi();

    await expect(updateRecommendation('proj', 'rec-1', 'dismissed')).resolves.toEqual({
      recommendation: { id: 'rec-1', status: 'dismissed' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/proj/recommendations');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ id: 'rec-1', status: 'dismissed' });

    stubFetch(false, { detail: 'invalid recommendation status' }, 400, 'Bad Request');
    await expect(updateRecommendation('proj', 'rec-1', 'dismissed')).rejects.toThrow('invalid recommendation status');
  });
});

describe('pullProject', () => {
  async function getPullProject() {
    const { pullProject, PullDivergedError } = await import('@/lib/client-api');
    return { pullProject, PullDivergedError };
  }

  it('resolves with status and output on success', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', output: 'Already up to date.' });
    const { pullProject } = await getPullProject();

    const result = await pullProject('myproj');

    expect(result).toEqual({ status: 'ok', output: 'Already up to date.' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/changes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ strategy: 'ff-only' });
  });

  it('throws PullDivergedError on 409 with diverged flag', async () => {
    stubFetch(false, { diverged: true, detail: 'branch has diverged' }, 409, 'Conflict');
    const { pullProject, PullDivergedError } = await getPullProject();

    await expect(pullProject('myproj')).rejects.toBeInstanceOf(PullDivergedError);
  });

  it('throws a detail error on 409 without diverged flag', async () => {
    stubFetch(false, { detail: 'merge conflict detected' }, 409, 'Conflict');
    const { pullProject, PullDivergedError } = await getPullProject();

    const err = await pullProject('myproj').catch(e => e);
    expect(err).not.toBeInstanceOf(PullDivergedError);
    expect(err.message).toBe('merge conflict detected');
  });

  it('falls back to status text when detail is absent', async () => {
    stubFetch(false, {}, 500, 'Internal Server Error');
    const { pullProject } = await getPullProject();

    await expect(pullProject('myproj')).rejects.toThrow('Pull failed: Internal Server Error');
  });

  it('passes the strategy param in the request body', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', output: '' });
    const { pullProject } = await getPullProject();

    await pullProject('myproj', 'rebase');

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ strategy: 'rebase' });
  });
});

describe('runProject', () => {
  async function getRunProject() {
    const { runProject } = await import('@/lib/client-api');
    return runProject;
  }

  it('sends a JSON body when no files or persona are provided', async () => {
    const fetchMock = stubFetch(true, { status: 'started', job_id: 'j1', pid: 42 });
    const runProject = await getRunProject();

    const result = await runProject('myproj', 'do the thing');

    expect(result).toEqual({ status: 'started', job_id: 'j1', pid: 42 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/run');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toMatchObject({ prompt: 'do the thing' });
  });

  it('sends a FormData body when a persona is provided', async () => {
    const fetchMock = stubFetch(true, { status: 'started', job_id: 'j2', pid: 43 });
    const runProject = await getRunProject();

    await runProject('myproj', 'audit this', { persona: 'security-expert' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get('prompt')).toBe('audit this');
    expect(fd.get('persona')).toBe('security-expert');
    expect(init.headers).toBeUndefined();
  });

  it('throws a detail error on failure', async () => {
    stubFetch(false, { detail: 'budget exceeded' }, 429, 'Too Many Requests');
    const runProject = await getRunProject();

    await expect(runProject('myproj', 'do something')).rejects.toThrow('budget exceeded');
  });
});

describe('pushProject', () => {
  async function getPushProject() {
    const { pushProject } = await import('@/lib/client-api');
    return pushProject;
  }

  it('posts without a JSON body by default', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', job_id: 'push-1' });
    const pushProject = await getPushProject();

    await expect(pushProject('myproj')).resolves.toEqual({ status: 'ok', job_id: 'push-1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/push');
    expect(init).toEqual({ method: 'POST' });
  });

  it('includes commit and release_id only when requested', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', job_id: 'push-2' });
    const pushProject = await getPushProject();

    await pushProject('myproj', { commit: true, releaseId: 'rel-7' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ commit: true, release_id: 'rel-7' });
  });

  it('falls back to the HTTP status text when the API omits detail', async () => {
    stubFetch(false, {}, 502, 'Bad Gateway');
    const pushProject = await getPushProject();

    await expect(pushProject('myproj')).rejects.toThrow('Failed to push: Bad Gateway');
  });
});

describe('branch and changes client helpers', () => {
  async function getClientApi() {
    const { checkoutDefaultBranch, fetchChanges } = await import('@/lib/client-api');
    return { checkoutDefaultBranch, fetchChanges };
  }

  it('checkoutDefaultBranch sends carryChanges only when requested', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', branch: 'main', deletedBranch: 'fix-123' });
    const { checkoutDefaultBranch } = await getClientApi();

    await expect(checkoutDefaultBranch('myproj', { carryChanges: true })).resolves.toEqual({
      status: 'ok',
      branch: 'main',
      deletedBranch: 'fix-123',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/checkout-default');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ carryChanges: true });
  });

  it('checkoutDefaultBranch uses detail errors and generic fallback', async () => {
    stubFetch(false, { detail: 'working tree is dirty' }, 409, 'Conflict');
    const { checkoutDefaultBranch } = await getClientApi();

    await expect(checkoutDefaultBranch('myproj')).rejects.toThrow('working tree is dirty');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: async () => {
          throw new Error('bad json');
        },
      }),
    );

    await expect(checkoutDefaultBranch('myproj')).rejects.toThrow('Failed to switch branch');
  });

  it('fetchChanges forwards AbortSignal and surfaces API detail errors', async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(true, { files: [], summary: { added: 0, modified: 0, deleted: 0 } });
    const { fetchChanges } = await getClientApi();

    await expect(fetchChanges('myproj', { signal: controller.signal })).resolves.toEqual({
      files: [],
      summary: { added: 0, modified: 0, deleted: 0 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/changes');
    expect(init.signal).toBe(controller.signal);

    stubFetch(false, { detail: 'git status failed' }, 500, 'Internal Server Error');
    await expect(fetchChanges('myproj')).rejects.toThrow('git status failed');
  });
});

describe('issue and PR client helpers', () => {
  async function getClientApi() {
    const { fetchIssuesAndPRs, mergePR, approvePR, reviewPR } = await import('@/lib/client-api');
    return { fetchIssuesAndPRs, mergePR, approvePR, reviewPR };
  }

  it('fetchIssuesAndPRs appends refresh when requested and falls back to status text', async () => {
    const fetchMock = stubFetch(true, { issues: [], pullRequests: [] });
    const { fetchIssuesAndPRs } = await getClientApi();

    await expect(fetchIssuesAndPRs('myproj', true)).resolves.toEqual({ issues: [], pullRequests: [] });
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/by-project/myproj/issues?refresh=1');

    stubFetch(false, {}, 503, 'Service Unavailable');
    await expect(fetchIssuesAndPRs('myproj')).rejects.toThrow('Failed to fetch issues: Service Unavailable');
  });

  it('mergePR posts merge metadata and surfaces API detail errors', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', pr: 17, repo: 'owner/repo' });
    const { mergePR } = await getClientApi();

    await expect(mergePR('myproj', 17, 'squash')).resolves.toEqual({
      status: 'ok',
      pr: 17,
      repo: 'owner/repo',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/issues');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      prNumber: 17,
      mergeMethod: 'squash',
      action: 'merge',
    });

    stubFetch(false, { detail: 'merge blocked by checks' }, 409, 'Conflict');
    await expect(mergePR('myproj', 17)).rejects.toThrow('merge blocked by checks');
  });

  it('approvePR and reviewPR send the expected payloads', async () => {
    const fetchMock = stubFetch(true, { status: 'ok', pr: 21, repo: 'owner/repo' });
    const { approvePR, reviewPR } = await getClientApi();

    await expect(approvePR('myproj', 21)).resolves.toEqual({
      status: 'ok',
      pr: 21,
      repo: 'owner/repo',
    });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      prNumber: 21,
      action: 'approve',
    });

    stubFetch(true, { status: 'started', job_id: 'job-7', pid: 101, log_path: '/tmp/log' });
    await expect(reviewPR('myproj', 21, 'Fix bug', 'feature', 'main')).resolves.toEqual({
      status: 'started',
      job_id: 'job-7',
      pid: 101,
      log_path: '/tmp/log',
    });
    expect(JSON.parse((vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      prNumber: 21,
      prTitle: 'Fix bug',
      headRef: 'feature',
      baseRef: 'main',
    });
  });
});
