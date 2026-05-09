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

  it('runAgent returns queued responses without pretending a job started', async () => {
    stubFetch(true, {
      status: 'queued',
      code: 'pipeline_lock',
      detail: 'Agent queued behind active release',
      agent: 'Docs',
      blockingJobId: 'release-1',
    });
    const { runAgent } = await getClientAgents();

    await expect(runAgent('agent-1', 'Run it')).resolves.toEqual({
      status: 'queued',
      code: 'pipeline_lock',
      detail: 'Agent queued behind active release',
      agent: 'Docs',
      blockingJobId: 'release-1',
    });
  });

  it('updateAgent patches the agent and returns the updated record', async () => {
    const fetchMock = stubFetch(true, { agent: { id: 'agent-1', model: 'smart' } });
    const { updateAgent } = await getClientAgents();

    await expect(updateAgent('agent-1', { model: 'smart' })).resolves.toEqual({
      agent: { id: 'agent-1', model: 'smart' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'smart' });
  });

  it('updateAgent surfaces API detail errors', async () => {
    stubFetch(false, { detail: 'agent not found' });
    const { updateAgent } = await getClientAgents();

    await expect(updateAgent('missing', { model: 'fast' })).rejects.toThrow('agent not found');
  });

  it('updateAgent falls back to generic error when detail is absent', async () => {
    stubFetch(false, {}, 'Internal Server Error');
    const { updateAgent } = await getClientAgents();

    await expect(updateAgent('agent-1', { enabled: false })).rejects.toThrow(
      'Failed to update agent',
    );
  });

  it('deleteAgent sends DELETE to the agent endpoint', async () => {
    const fetchMock = stubFetch(true, {});
    const { deleteAgent } = await getClientAgents();

    await expect(deleteAgent('agent-1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('deleteAgent throws on failure', async () => {
    stubFetch(false, {}, 'Not Found');
    const { deleteAgent } = await getClientAgents();

    await expect(deleteAgent('ghost')).rejects.toThrow('Failed to delete agent');
  });

  it('improveAgentPrompt posts the draft context and returns the improved prompt', async () => {
    const fetchMock = stubFetch(true, { improvedPrompt: 'Run pnpm test and summarize failures.' });
    const { improveAgentPrompt } = await getClientAgents();

    await expect(
      improveAgentPrompt({
        project: 'proj',
        draftPrompt: 'make tests better',
        skillIds: ['agent-tests'],
        docPaths: ['docs/testing.md'],
      }),
    ).resolves.toEqual({ improvedPrompt: 'Run pnpm test and summarize failures.' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/improve-prompt');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      project: 'proj',
      draftPrompt: 'make tests better',
      skillIds: ['agent-tests'],
      docPaths: ['docs/testing.md'],
    });
  });

  it('improveAgentPrompt surfaces API detail errors', async () => {
    stubFetch(false, { detail: 'providers are over budget' });
    const { improveAgentPrompt } = await getClientAgents();

    await expect(
      improveAgentPrompt({
        project: 'proj',
        draftPrompt: 'x',
        skillIds: [],
        docPaths: [],
      }),
    ).rejects.toThrow('providers are over budget');
  });
});
