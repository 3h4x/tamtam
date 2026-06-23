import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Mock `sleep` so workflow-native polls don't actually delay test runs.
vi.mock('workflow', () => ({
  sleep: vi.fn(async () => undefined),
}));

const resolveProjectPathMock = vi.fn();
const getImproveConfigMock = vi.fn();
const createJobMock = vi.fn();
const updateJobMock = vi.fn();
const getJobMock = vi.fn();
const markDoneMock = vi.fn();
const appendRedactedFileSyncMock = vi.fn();
const getPrStatusMock = vi.fn();
const checksConclusionMock = vi.fn();
const doMergeMock = vi.fn();
const switchToDefaultMock = vi.fn();
const startMarkDodMock = vi.fn();
const riskyPrDiffFilesMock = vi.fn();
const mkdirSyncMock = vi.fn();
const execMock = vi.fn();
const dbInsertMock = vi.fn();
const dbValuesMock = vi.fn();
const dbOnConflictDoUpdateMock = vi.fn();
const dbExecuteMock = vi.fn();

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: (...args: unknown[]) => resolveProjectPathMock(...args),
}));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: (...args: unknown[]) => getImproveConfigMock(...args),
}));
vi.mock('@/lib/jobs/job-storage', () => ({
  createJob: (...args: unknown[]) => createJobMock(...args),
  updateJob: (...args: unknown[]) => updateJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...args),
  markDone: (...args: unknown[]) => markDoneMock(...args),
}));
vi.mock('@/lib/jobs/redacted-log-writer', () => ({
  appendRedactedFileSync: (...args: unknown[]) => appendRedactedFileSyncMock(...args),
}));
vi.mock('@/lib/pipeline/start-pr-wait', () => ({
  getPrStatus: (...args: unknown[]) => getPrStatusMock(...args),
  checksConclusion: (...args: unknown[]) => checksConclusionMock(...args),
  doMerge: (...args: unknown[]) => doMergeMock(...args),
  switchToDefault: (...args: unknown[]) => switchToDefaultMock(...args),
}));
vi.mock('@/lib/pipeline/start-mark-dod', () => ({
  startMarkDod: (...args: unknown[]) => startMarkDodMock(...args),
}));
vi.mock('@/lib/security/pr-branch-execution', () => ({
  riskyPrDiffFiles: (...args: unknown[]) => riskyPrDiffFilesMock(...args),
}));
vi.mock('@/lib/shared/shell', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));
vi.mock('@/lib/db', () => ({
  db: {
    insert: (...args: unknown[]) => dbInsertMock(...args),
  },
  schema: {
    ghStatus: {
      project: 'project',
    },
  },
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args) };
});

import { releasePrWaitPhaseWorkflow } from '@/lib/workflows/phases/pr-wait-phase';

const PR = { number: 42, repo: '3h4x/test-tt', url: 'https://example.com/pr/42' };

function setupJob(jobId = 'prw-1') {
  const job = { id: jobId, project: 'proj', kind: 'pr-wait', logPath: `/tmp/${jobId}.log`, finishedAt: null, parentJobId: null };
  createJobMock.mockReturnValue(job);
  getJobMock.mockImplementation((id: string) => (id === jobId ? job : null));
  return job;
}

describe('releasePrWaitPhaseWorkflow', () => {
  beforeEach(() => {
    resolveProjectPathMock.mockReset().mockReturnValue('/tmp/proj');
    getImproveConfigMock.mockReset().mockReturnValue({ logDir: '/tmp/logs' });
    createJobMock.mockReset();
    updateJobMock.mockReset();
    getJobMock.mockReset();
    markDoneMock.mockReset().mockResolvedValue(undefined);
    appendRedactedFileSyncMock.mockReset();
    getPrStatusMock.mockReset();
    checksConclusionMock.mockReset();
    doMergeMock.mockReset();
    switchToDefaultMock.mockReset();
    startMarkDodMock.mockReset();
    riskyPrDiffFilesMock.mockReset().mockReturnValue([]);
    mkdirSyncMock.mockReset();
    execMock.mockReset();
    dbInsertMock.mockReset().mockReturnValue({ values: dbValuesMock });
    dbValuesMock.mockReset().mockReturnValue({ onConflictDoUpdate: dbOnConflictDoUpdateMock });
    dbOnConflictDoUpdateMock.mockReset().mockReturnValue({ execute: dbExecuteMock });
    dbExecuteMock.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 202, text: async () => 'queued' })));
  });

  it('returns launch_failed when project does not resolve', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const r = await releasePrWaitPhaseWorkflow('missing', PR.number, PR.repo, PR.url);
    expect(r).toEqual({ ok: false, reason: 'launch_failed', error: 'project not found' });
  });

  it('merges and runs mark-dod on the happy path', async () => {
    setupJob('prw-happy');
    getPrStatusMock.mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    checksConclusionMock.mockReturnValue('pass');
    doMergeMock.mockResolvedValueOnce({ ok: true });
    switchToDefaultMock.mockResolvedValueOnce({ ok: true, branch: 'master' });
    startMarkDodMock.mockResolvedValueOnce({ ok: true, jobId: 'md-1', issueNumber: 0, verified: 2, total: 2, changed: true });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: true, reason: 'merged', exitCode: 0 });
    expect(doMergeMock).toHaveBeenCalledOnce();
    expect(switchToDefaultMock).toHaveBeenCalledOnce();
    expect(startMarkDodMock).toHaveBeenCalledOnce();
    expect(markDoneMock).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'prw-happy' }), 0);
  });

  it('aborts when the PR is already MERGED on the first poll', async () => {
    setupJob('prw-already');
    getPrStatusMock.mockResolvedValueOnce({ state: 'MERGED', mergeable: 'UNKNOWN', checks: [] });
    checksConclusionMock.mockReturnValue('none');
    switchToDefaultMock.mockResolvedValueOnce({ ok: true, branch: 'master' });
    startMarkDodMock.mockResolvedValueOnce({ ok: true, jobId: 'md-2', issueNumber: 0, verified: 0, total: 0, changed: false });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: true, reason: 'merged' });
    expect(doMergeMock).not.toHaveBeenCalled();
  });

  it('reports pr_closed when the PR is CLOSED unmerged', async () => {
    setupJob('prw-closed');
    getPrStatusMock.mockResolvedValueOnce({ state: 'CLOSED', mergeable: 'UNKNOWN', checks: [] });
    checksConclusionMock.mockReturnValue('none');

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: false, reason: 'pr_closed', exitCode: 1 });
    expect(doMergeMock).not.toHaveBeenCalled();
    expect(switchToDefaultMock).not.toHaveBeenCalled();
  });

  it('reports checks_failed when CI is failing', async () => {
    setupJob('prw-failed');
    getPrStatusMock.mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] });
    checksConclusionMock.mockReturnValue('fail');
    execMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        statusCheckRollup: [
          { status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/3h4x/test-tt/actions/runs/123' },
        ],
      }),
      stderr: '',
    });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: false, reason: 'checks_failed' });
    expect(execMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', String(PR.number), '--repo', PR.repo, '--json', 'statusCheckRollup'],
      { cwd: '/tmp/proj', timeout: 15000 },
    );
    expect(dbValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      project: 'proj',
      ciFailedUrl: 'https://github.com/3h4x/test-tt/actions/runs/123',
    }));
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:1337/api/projects/by-project/proj/fix-ci',
      { method: 'POST' },
    );
  });

  it('seeds failed StatusContext URLs before dispatching fix-ci', async () => {
    setupJob('prw-status-context-failed');
    getPrStatusMock.mockResolvedValueOnce({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      checks: [{ __typename: 'StatusContext', state: 'ERROR', targetUrl: 'https://github.com/3h4x/test-tt/actions/runs/456' }],
    });
    checksConclusionMock.mockReturnValue('fail');
    execMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        statusCheckRollup: [
          { __typename: 'StatusContext', state: 'ERROR', targetUrl: 'https://github.com/3h4x/test-tt/actions/runs/456' },
        ],
      }),
      stderr: '',
    });
    dbExecuteMock.mockImplementationOnce(async () => {
      expect(fetch).not.toHaveBeenCalled();
    });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: false, reason: 'checks_failed' });
    expect(dbValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      project: 'proj',
      ciFailedUrl: 'https://github.com/3h4x/test-tt/actions/runs/456',
    }));
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:1337/api/projects/by-project/proj/fix-ci',
      { method: 'POST' },
    );
  });

  it('reports conflict when mergeable=CONFLICTING', async () => {
    setupJob('prw-conflict');
    getPrStatusMock.mockResolvedValueOnce({ state: 'OPEN', mergeable: 'CONFLICTING', checks: [] });
    checksConclusionMock.mockReturnValue('pass');

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: false, reason: 'conflict' });
  });

  it('retries on transient merge failure and succeeds on the second attempt', async () => {
    setupJob('prw-retry');
    getPrStatusMock
      .mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })
      .mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    checksConclusionMock.mockReturnValue('pass');
    doMergeMock
      .mockResolvedValueOnce({ ok: false, permanent: false })
      .mockResolvedValueOnce({ ok: true });
    switchToDefaultMock.mockResolvedValueOnce({ ok: true, branch: 'master' });
    startMarkDodMock.mockResolvedValueOnce({ ok: true, jobId: 'md-3', issueNumber: 0, verified: 0, total: 0, changed: false });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: true });
    expect(doMergeMock).toHaveBeenCalledTimes(2);
  });

  it('reports merge_permanent when merge returns a permanent failure', async () => {
    setupJob('prw-permamerge');
    getPrStatusMock.mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    checksConclusionMock.mockReturnValue('pass');
    doMergeMock.mockResolvedValueOnce({ ok: false, permanent: true });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: false, reason: 'merge_permanent' });
  });

  it('reports risky_diff before merge when the actual PR diff touches high-risk files', async () => {
    setupJob('prw-risky');
    getPrStatusMock.mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    checksConclusionMock.mockReturnValue('pass');
    riskyPrDiffFilesMock.mockReturnValueOnce(['package.json']);

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: false, reason: 'risky_diff', exitCode: 1 });
    expect(riskyPrDiffFilesMock).toHaveBeenCalledWith('/tmp/proj', PR.number, PR.repo);
    expect(doMergeMock).not.toHaveBeenCalled();
  });

  it('reports switch_failed when post-merge branch switch fails', async () => {
    setupJob('prw-switchfail');
    getPrStatusMock.mockResolvedValueOnce({ state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    checksConclusionMock.mockReturnValue('pass');
    doMergeMock.mockResolvedValueOnce({ ok: true });
    switchToDefaultMock.mockResolvedValueOnce({ ok: false, branch: 'master' });

    const r = await releasePrWaitPhaseWorkflow('proj', PR.number, PR.repo, PR.url);

    expect(r).toMatchObject({ ok: true, merged: true, reason: 'switch_failed', exitCode: 1 });
    expect(startMarkDodMock).not.toHaveBeenCalled();
  });
});

describe('pr-wait-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/pr-wait-phase.ts'), 'utf-8');
  it.each([
    'export async function releasePrWaitPhaseWorkflow',
    'async function preparePrWaitStep',
    'async function pollPrStatusStep',
    'async function attemptMergeStep',
    'async function switchToDefaultStep',
    'async function runPostMergeMarkDodStep',
    'async function finalizePrWaitStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
