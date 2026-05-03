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
