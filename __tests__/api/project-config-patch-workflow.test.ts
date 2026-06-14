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

  it('persists issue_auto_branch=false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ issue_auto_branch: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'issue_auto_branch', '0');
  });

  it('persists issue_auto_branch=true (re-enabling Work-on branch provision)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ issue_auto_branch: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'issue_auto_branch', '1');
  });

  it('persists tests_disabled=true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'tests_disabled', '1');
  });

  it('persists tests_disabled=false (re-enabling tests)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'tests_disabled', '0');
  });

  it('returns 404 when tests_disabled is set but project not found', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ tests_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('persists review_disabled=true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_disabled', '1');
  });

  it('persists review_disabled=false (re-enabling review)', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_disabled', '0');
  });

  it('returns 404 when project not found while writing review_disabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_disabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('persists test_cron_schedule and test_cron_enabled', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: true, testCronSchedule: '1h' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: true, test_cron_schedule: '1h' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_cron_schedule', '1h');
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_cron_enabled', '1');
  });

  it('installs PM2 schedule when cron is enabled with schedule', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: true, testCronSchedule: '30m' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: true, test_cron_schedule: '30m' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.installTestSchedule).toHaveBeenCalledWith('proj1', '30m');
    expect(mocks.uninstallTestSchedule).not.toHaveBeenCalled();
  });

  it('uninstalls PM2 schedule when cron is disabled', async () => {
    mocks.getProjectTestConfig.mockReturnValue({ testCommand: null, testCronEnabled: false, testCronSchedule: '1h' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_enabled: false }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.uninstallTestSchedule).toHaveBeenCalledWith('proj1');
    expect(mocks.installTestSchedule).not.toHaveBeenCalled();
  });

  it('rejects invalid cron schedule with 400', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: 'bogus' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('Invalid schedule');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('clears test_cron_schedule when empty string provided', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: '  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'test_cron_schedule', null);
  });

  it('rejects non-string test_cron_schedule payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ test_cron_schedule: 30 }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('test_cron_schedule must be a string');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('writes auto_commit_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_commit_enabled', '1');
  });

  it('writes auto_commit_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_commit_enabled', '0');
  });

  it('rejects non-boolean workflow flag payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: 'false' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('auto_commit_enabled must be a boolean');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('returns 404 when project not found while writing auto_commit_enabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_commit_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('writes release_after_run=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'release_after_run', '1');
  });

  it('writes release_after_run=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'release_after_run', '0');
  });

  it('returns 404 when project not found while writing release_after_run', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ release_after_run: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('writes auto_pr_merge_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_pr_merge_enabled', '1');
  });

  it('writes auto_pr_merge_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_pr_merge_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_pr_merge_enabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_pr_merge_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('writes auto_push_enabled=1 when set to true', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_push_enabled', '1');
  });

  it('writes auto_push_enabled=0 when set to false', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: false }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'auto_push_enabled', '0');
  });

  it('returns 404 when project not found while writing auto_push_enabled', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ auto_push_enabled: true }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });

  it('persists review_prompt_addendum text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: 'Treat console.log as non-blocker.' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', 'Treat console.log as non-blocker.');
  });

  it('persists review_prerequisite_command text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: 'pnpm db:types' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prerequisite_command', 'pnpm db:types');
  });

  it('trims review_prerequisite_command before persisting', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: '  pnpm db:types  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prerequisite_command', 'pnpm db:types');
  });

  it('clears review_prerequisite_command when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: '   \n  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prerequisite_command', null);
  });

  it('rejects non-string review_prerequisite_command payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prerequisite_command: ['bad'] }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('review_prerequisite_command must be a string');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('trims review_prompt_addendum before persisting', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: '  Treat console.log as non-blocker.  ' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', 'Treat console.log as non-blocker.');
  });

  it('clears review_prompt_addendum when whitespace-only', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: '   \n  ' }),
    });
    await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'review_prompt_addendum', null);
  });

  it('rejects non-string review_prompt_addendum payloads', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: ['bad'] }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('review_prompt_addendum must be a string');
    expect(mocks.writeProjectFieldYaml).not.toHaveBeenCalled();
  });

  it('persists fix_prompt_addendum text', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/config', {
      method: 'PATCH',
      body: JSON.stringify({ fix_prompt_addendum: 'Prefer minimal diffs.' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(mocks.writeProjectFieldYaml).toHaveBeenCalledWith('proj1', 'fix_prompt_addendum', 'Prefer minimal diffs.');
  });

  it('returns 404 when project not found while writing review_prompt_addendum', async () => {
    mocks.writeProjectFieldYaml.mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/projects/by-project/missing/config', {
      method: 'PATCH',
      body: JSON.stringify({ review_prompt_addendum: 'foo' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ projectName: 'missing' }) });
    expect(res.status).toBe(404);
  });
});
