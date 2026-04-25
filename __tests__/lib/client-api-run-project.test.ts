import { describe, it, expect, vi, afterEach } from 'vitest';

// Stub fetch before each test; restore after.
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

async function importRunProject() {
  const mod = await import('@/lib/client-api');
  return mod.runProject;
}

// ---------------------------------------------------------------------------
// JSON path (no files, no persona)
// ---------------------------------------------------------------------------

describe('runProject — JSON path', () => {
  it('posts prompt only when no optional opts are provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j1', pid: 123 });
    const runProject = await importRunProject();

    const result = await runProject('myproj', 'do something');

    expect(result).toEqual({ status: 'ok', job_id: 'j1', pid: 123 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/by-project/myproj/run');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ prompt: 'do something' });
  });

  it('includes model when provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j2', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { model: 'claude-opus-4-7' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.prompt).toBe('prompt');
  });

  it('includes personas when array is non-empty', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j3', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { personas: ['senior-qa', 'cto'] });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.personas).toEqual(['senior-qa', 'cto']);
  });

  it('omits personas when array is empty', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j4', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { personas: [] });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('personas');
  });

  it('includes resumeSessionId when provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j5', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { resumeSessionId: 'sess-abc' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.resumeSessionId).toBe('sess-abc');
  });

  it('includes ghIssueNumber=0 (falsy but not null) in the body', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j6', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { ghIssueNumber: 0 });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.ghIssueNumber).toBe(0);
  });

  it('omits ghIssueNumber when undefined', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j7', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', {});

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('ghIssueNumber');
  });

  it('includes ghIssueRepo and ghIssueTitle when provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j8', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', {
      ghIssueNumber: 42,
      ghIssueRepo: 'owner/repo',
      ghIssueTitle: 'Fix the bug',
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.ghIssueNumber).toBe(42);
    expect(body.ghIssueRepo).toBe('owner/repo');
    expect(body.ghIssueTitle).toBe('Fix the bug');
  });

  it('includes contextMeta and userPrompt when provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j9', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { contextMeta: 'ctx', userPrompt: 'user asked' });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contextMeta).toBe('ctx');
    expect(body.userPrompt).toBe('user asked');
  });

  it('throws with detail message on non-ok response', async () => {
    stubFetch(false, { detail: 'project not found' }, 404);
    const runProject = await importRunProject();

    await expect(runProject('unknown', 'prompt')).rejects.toThrow('project not found');
  });

  it('throws generic message when error response has no detail', async () => {
    stubFetch(false, {}, 500);
    const runProject = await importRunProject();

    await expect(runProject('proj', 'prompt')).rejects.toThrow('Failed to start');
  });

  it('uses empty opts object by default (no third argument)', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'j10', pid: 1 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt');

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    // Only prompt — no stray undefined keys
    expect(Object.keys(body)).toEqual(['prompt']);
  });
});

// ---------------------------------------------------------------------------
// FormData path (files present or persona set)
// ---------------------------------------------------------------------------

describe('runProject — FormData path', () => {
  it('sends multipart/form-data when persona is provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'f1', pid: 2 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { persona: 'senior-qa' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    // No Content-Type header — browser sets it with boundary automatically
    expect((init.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined();
    const fd = init.body as FormData;
    expect(fd.get('prompt')).toBe('prompt');
    expect(fd.get('persona')).toBe('senior-qa');
  });

  it('sends multipart/form-data when files are provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'f2', pid: 2 });
    const runProject = await importRunProject();

    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    await runProject('proj', 'prompt', { files: [file] });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get('files')).toBeInstanceOf(File);
  });

  it('appends ghIssueNumber as string in FormData', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'f3', pid: 2 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { persona: 'cto', ghIssueNumber: 7 });

    const fd = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(fd.get('ghIssueNumber')).toBe('7');
  });

  it('omits falsy optional fields from FormData', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'f4', pid: 2 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', { persona: 'cto' });

    const fd = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(fd.get('model')).toBeNull();
    expect(fd.get('resumeSessionId')).toBeNull();
    expect(fd.get('ghIssueNumber')).toBeNull();
    expect(fd.get('ghIssueRepo')).toBeNull();
  });

  it('includes all optional fields in FormData when provided', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'f5', pid: 2 });
    const runProject = await importRunProject();

    await runProject('proj', 'prompt', {
      persona: 'cto',
      personas: ['s1', 's2'],
      model: 'haiku',
      resumeSessionId: 'rs1',
      contextMeta: 'ctx',
      userPrompt: 'user says hi',
      ghIssueNumber: 99,
      ghIssueRepo: 'o/r',
      ghIssueTitle: 'Some issue',
    });

    const fd = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(fd.get('personas')).toBe(JSON.stringify(['s1', 's2']));
    expect(fd.get('model')).toBe('haiku');
    expect(fd.get('resumeSessionId')).toBe('rs1');
    expect(fd.get('contextMeta')).toBe('ctx');
    expect(fd.get('userPrompt')).toBe('user says hi');
    expect(fd.get('ghIssueNumber')).toBe('99');
    expect(fd.get('ghIssueRepo')).toBe('o/r');
    expect(fd.get('ghIssueTitle')).toBe('Some issue');
  });

  it('posts to correct URL with the project name', async () => {
    const fetchSpy = stubFetch(true, { status: 'ok', job_id: 'f6', pid: 2 });
    const runProject = await importRunProject();

    await runProject('special-project', 'prompt', { persona: 'cto' });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('/by-project/special-project/run');
  });

  it('throws with detail from error response in FormData path', async () => {
    stubFetch(false, { detail: 'upload error' }, 422);
    const runProject = await importRunProject();

    const file = new File(['x'], 'x.txt');
    await expect(runProject('proj', 'prompt', { files: [file] })).rejects.toThrow('upload error');
  });
});
