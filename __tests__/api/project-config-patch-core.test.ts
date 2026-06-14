import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mocks, resetMocks, routeModulePromise } from './project-config-fixtures';

describe('PATCH /api/projects/by-project/{projectName}/config', () => {
  let PATCH: typeof import('@/app/api/projects/by-project/[projectName]/config/route').PATCH;

  beforeAll(async () => {
    ({ PATCH } = await routeModulePromise);
  });

  beforeEach(() => {
    resetMocks();
    mocks.resolveProjectPath.mockReturnValue('/path/to/proj');
    mocks.writeProjectFieldYaml.mockReturnValue(true);
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: null });
    mocks.getProjectPushResult.mockReturnValue(null);
    mocks.getProjectPipelinePrompts.mockReturnValue({
      reviewPromptAddendum: null,
      reviewPrerequisiteCommand: null,
      fixPromptAddendum: null,
    });
    mocks.loadFileConfig.mockReturnValue(null);
    mocks.getBranchContext.mockReturnValue({ currentBranch: 'main', defaultBranch: 'main', isDefaultBranch: true });
  });

  it('returns 404 when project not found', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'npm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('unknown');
  });

  it('updates test_command and returns ok', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pnpm test' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_command', 'pnpm test');
  });

  it('clears test_command when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_command', null);
  });

  it('rejects non-string test_command payloads instead of clearing the stored value', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('test_command must be a string');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.writeFileConfig).not.toHaveBeenCalled();
  });

  it('persists commit_style to the project file config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: '  Use cyberpunk vocabulary.  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/path/to/proj', {
      commit_style: 'Use cyberpunk vocabulary.',
    });
  });

  it('clears commit_style from the project file config when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: '   \n  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/path/to/proj', {
      commit_style: null,
    });
  });

  it('rejects non-string commit_style payloads instead of clearing the file config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: { tone: 'cyberpunk' } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('commit_style must be a string');
    expect(mocks.writeFileConfig).not.toHaveBeenCalled();
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('returns 500 when writing file-backed config fails', async () => {
    mocks.writeFileConfig.mockImplementation(() => {
      throw new Error('disk full');
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ commit_style: 'cyberpunk only' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('.tamtam/config.yml');
    expect(mocks.reloadConfig).not.toHaveBeenCalled();
    expect(mocks.clearProjectDataCache).not.toHaveBeenCalled();
  });

  it('does not apply DB test_command when a mixed file-backed config write fails', async () => {
    mocks.writeFileConfig.mockImplementation(() => {
      throw new Error('disk full');
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        test_command: 'pnpm test',
        commit_style: 'cyberpunk only',
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    expect(mocks.writeFileConfig).toHaveBeenCalledWith('/path/to/proj', {
      test_command: 'pnpm test',
      commit_style: 'cyberpunk only',
    });
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.reloadConfig).not.toHaveBeenCalled();
    expect(mocks.clearProjectDataCache).not.toHaveBeenCalled();
  });

  it('does not apply DB workflow flags when a mixed file-backed config write fails', async () => {
    mocks.writeFileConfig.mockImplementation(() => {
      throw new Error('disk full');
    });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        commit_style: 'cyberpunk only',
        auto_push_enabled: true,
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
    expect(mocks.reloadConfig).not.toHaveBeenCalled();
    expect(mocks.clearProjectDataCache).not.toHaveBeenCalled();
  });

  it('calls reloadConfig and clearProjectDataCache after update', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_command: 'pytest' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.reloadConfig).toHaveBeenCalledOnce();
    expect(mocks.clearProjectDataCache).toHaveBeenCalledOnce();
  });

  it('persists a trimmed website URL to the DB-only project config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: '  https://example.com/app  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'website', 'https://example.com/app');
  });

  it('clears website when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: '   ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'website', null);
  });

  it('persists trimmed dev server lifecycle fields to DB-only project config', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        dev_server_start_command: '  pnpm dev  ',
        dev_server_stop_command: '  pnpm dev:stop  ',
        dev_server_ready_url: '  http://localhost:3000/ready  ',
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_start_command', 'pnpm dev');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_stop_command', 'pnpm dev:stop');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_ready_url', 'http://localhost:3000/ready');
  });

  it('clears dev server lifecycle fields when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({
        dev_server_start_command: '   ',
        dev_server_stop_command: '   ',
        dev_server_ready_url: '   ',
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_start_command', null);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_stop_command', null);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'dev_server_ready_url', null);
  });

  it('rejects invalid website URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: 'not a url' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('valid URL');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects non-http website URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: 'ftp://example.com/app' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('http(s)');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects invalid dev server ready URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ dev_server_ready_url: 'not a url' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('valid URL');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'dev_server_ready_url', expect.anything());
  });

  it('rejects non-http dev server ready URLs', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ dev_server_ready_url: 'ftp://localhost/ready' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('http(s)');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'dev_server_ready_url', expect.anything());
  });

  it('rejects boolean website payloads instead of clearing the stored value', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('string URL');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('rejects object website payloads instead of clearing the stored value', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ website: { href: 'https://example.com/app' } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('string URL');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalledWith('proj1', 'website', expect.anything());
  });

  it('returns ok without writing when body has no test_command', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ other_field: 'value' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });
});
