import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function stubFetch(ok: boolean, body: object, statusText = ok ? 'OK' : 'Bad Request') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      statusText,
      json: async () => body,
    }),
  );
  return vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
}

describe('client jobs helpers', () => {
  async function getClientJobs() {
    return import('@/lib/client/jobs');
  }

  it('fetchJobs encodes query params and returns the response payload', async () => {
    const fetchMock = stubFetch(true, {
      jobs: [{ id: 'job-1' }],
      pendingReleaseProjects: ['proj-a'],
    });
    const { fetchJobs } = await getClientJobs();

    await expect(fetchJobs('owner/repo name', { limit: 25, offset: 50, kind: 'run' })).resolves.toEqual({
      jobs: [{ id: 'job-1' }],
      pendingReleaseProjects: ['proj-a'],
    });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      '/api/jobs?project=owner%2Frepo+name&limit=25&offset=50&kind=run',
    );
  });

  it('fetchJobs throws with the HTTP status text on failure', async () => {
    stubFetch(false, {}, 'Service Unavailable');
    const { fetchJobs } = await getClientJobs();

    await expect(fetchJobs('proj')).rejects.toThrow('Failed to fetch jobs: Service Unavailable');
  });

  it('markNotificationsSeen posts to the mark-seen endpoint', async () => {
    const fetchMock = stubFetch(true, { status: 'ok' });
    const { markNotificationsSeen } = await getClientJobs();

    await expect(markNotificationsSeen()).resolves.toEqual({ status: 'ok' });

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/notifications/mark-seen', {
      method: 'POST',
    });
  });

  it('syncJobBoard surfaces API detail errors before falling back to status text', async () => {
    const response = {
      ok: false,
      statusText: 'Conflict',
      json: async () => ({ detail: 'board sync disabled' }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const { syncJobBoard } = await getClientJobs();

    await expect(syncJobBoard('job-99')).rejects.toThrow('board sync disabled');
  });

  it('syncJobBoard falls back to the status text when detail is absent', async () => {
    const response = {
      ok: false,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const { syncJobBoard } = await getClientJobs();

    await expect(syncJobBoard('job-99')).rejects.toThrow(
      'Failed to sync board item: Internal Server Error',
    );
  });

  it('fetchNotifications returns count and job arrays', async () => {
    const payload = {
      count: 2,
      jobs: [{ id: 'job-1' }, { id: 'job-2' }],
      runningCount: 1,
      runningJobs: [{ id: 'job-2' }],
    };
    const fetchMock = stubFetch(true, payload);
    const { fetchNotifications } = await getClientJobs();

    await expect(fetchNotifications()).resolves.toEqual(payload);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/jobs/notifications');
  });

  it('fetchNotifications throws with status text on failure', async () => {
    stubFetch(false, {}, 'Service Unavailable');
    const { fetchNotifications } = await getClientJobs();

    await expect(fetchNotifications()).rejects.toThrow(
      'Failed to fetch notifications: Service Unavailable',
    );
  });

  it('markJobSeen posts to the job seen endpoint and returns status', async () => {
    const fetchMock = stubFetch(true, { status: 'ok' });
    const { markJobSeen } = await getClientJobs();

    await expect(markJobSeen('job-42')).resolves.toEqual({ status: 'ok' });

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-42/seen', { method: 'POST' });
  });

  it('markJobSeen throws with status text on failure', async () => {
    stubFetch(false, {}, 'Not Found');
    const { markJobSeen } = await getClientJobs();

    await expect(markJobSeen('ghost')).rejects.toThrow('Failed to mark seen: Not Found');
  });
});
