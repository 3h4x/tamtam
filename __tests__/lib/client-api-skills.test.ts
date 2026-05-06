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

describe('client skills helpers', () => {
  async function getClientSkills() {
    return import('@/lib/client/skills');
  }

  it('fetchSkills returns an empty list when the API is unavailable', async () => {
    stubFetch(false, {}, 'Service Unavailable');
    const { fetchSkills } = await getClientSkills();

    await expect(fetchSkills()).resolves.toEqual({ skills: [] });
  });

  it('createSkill posts JSON to the skills endpoint', async () => {
    const fetchMock = stubFetch(true, { skill: { id: 'skill-1' } });
    const { createSkill } = await getClientSkills();

    await expect(
      createSkill({ name: 'Docs', description: 'Writes docs', content: 'Be concise.' }),
    ).resolves.toEqual({ skill: { id: 'skill-1' } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/skills');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Docs',
      description: 'Writes docs',
      content: 'Be concise.',
    });
  });

  it('updateSkill prefers API detail errors', async () => {
    stubFetch(false, { detail: 'name is required' });
    const { updateSkill } = await getClientSkills();

    await expect(updateSkill('skill-1', { name: '' })).rejects.toThrow('name is required');
  });

  it('deleteSkill throws the generic error on failure', async () => {
    stubFetch(false, {}, 'Internal Server Error');
    const { deleteSkill } = await getClientSkills();

    await expect(deleteSkill('skill-1')).rejects.toThrow('Failed to delete skill');
  });
});
