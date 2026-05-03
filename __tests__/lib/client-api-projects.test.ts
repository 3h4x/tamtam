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
