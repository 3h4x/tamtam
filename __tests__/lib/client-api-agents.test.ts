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

describe('client agents helpers', () => {
  async function getClientAgents() {
    return import('@/lib/client/agents');
  }

  it('fetchAgents encodes the project name and unwraps the agents payload', async () => {
    const fetchMock = stubFetch(true, { agents: [{ id: 'agent-1', name: 'Docs' }] });
    const { fetchAgents } = await getClientAgents();

    await expect(fetchAgents('owner/repo name')).resolves.toEqual({
      agents: [{ id: 'agent-1', name: 'Docs' }],
    });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/agents?project=owner%2Frepo%20name');
  });

  it('fetchAgents falls back to an empty list on non-ok responses', async () => {
    stubFetch(false, {}, 'Service Unavailable');
    const { fetchAgents } = await getClientAgents();

    await expect(fetchAgents('proj')).resolves.toEqual({ agents: [] });
  });

  it('createAgent posts JSON and surfaces API detail errors', async () => {
    const fetchMock = stubFetch(true, { agent: { id: 'agent-1' } });
    const { createAgent } = await getClientAgents();

    await expect(
      createAgent({ name: 'Docs', project: 'proj', skillIds: ['agent-tests'], model: 'normal' }),
    ).resolves.toEqual({ agent: { id: 'agent-1' } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Docs',
      project: 'proj',
      skillIds: ['agent-tests'],
      model: 'normal',
    });

    stubFetch(false, { detail: 'duplicate agent name' });
    await expect(
      createAgent({ name: 'Docs', project: 'proj', skillIds: [], model: 'normal' }),
    ).rejects.toThrow('duplicate agent name');
  });

  it('runAgent falls back to the generic error when detail is absent', async () => {
    stubFetch(false, {}, 'Conflict');
    const { runAgent } = await getClientAgents();

    await expect(runAgent('agent-1', 'Run it')).rejects.toThrow('Failed to run agent');
  });
});
