import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const prepareMarkDodMock = vi.fn();
const fetchAndExtractMarkDodCriteriaMock = vi.fn();
const switchBranchForMarkDodVerificationMock = vi.fn();
const startMarkDodVerificationMock = vi.fn();
const readMarkDodVerificationResultMock = vi.fn();
const applyAndFinalizeMarkDodMock = vi.fn();
const getJobMock = vi.fn();
const waitForJobCompletionMock = vi.fn();

vi.mock('@/lib/workflows/phases/mark-dod-impl', () => ({
  prepareMarkDod: (...a: unknown[]) => prepareMarkDodMock(...a),
  fetchAndExtractMarkDodCriteria: (...a: unknown[]) => fetchAndExtractMarkDodCriteriaMock(...a),
  switchBranchForMarkDodVerification: (...a: unknown[]) => switchBranchForMarkDodVerificationMock(...a),
  startMarkDodVerification: (...a: unknown[]) => startMarkDodVerificationMock(...a),
  readMarkDodVerificationResult: (...a: unknown[]) => readMarkDodVerificationResultMock(...a),
  applyAndFinalizeMarkDod: (...a: unknown[]) => applyAndFinalizeMarkDodMock(...a),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: (...a: unknown[]) => getJobMock(...a),
}));

vi.mock('@/lib/workflows/wait-for-job', () => ({
  waitForJobCompletion: (...a: unknown[]) => waitForJobCompletionMock(...a),
}));

import { releaseMarkDodPhaseWorkflow } from '@/lib/workflows/phases/mark-dod-phase';

const BUNDLE = {
  jobId: 'dod-job-1',
  projPath: '/tmp/proj',
  ctx: { number: 42, repo: '3h4x/test-tt' },
  isPr: false,
};

const JOB = { id: 'dod-job-1', kind: 'mark-dod' as const };

describe('releaseMarkDodPhaseWorkflow', () => {
  beforeEach(() => {
    prepareMarkDodMock.mockReset();
    fetchAndExtractMarkDodCriteriaMock.mockReset();
    switchBranchForMarkDodVerificationMock.mockReset();
    startMarkDodVerificationMock.mockReset();
    readMarkDodVerificationResultMock.mockReset();
    applyAndFinalizeMarkDodMock.mockReset();
    waitForJobCompletionMock.mockReset().mockResolvedValue({ finished: true, reason: 'finished' });
    getJobMock.mockReset().mockReturnValue(JOB);
  });

  it('returns mark_dod_failed when prepare returns an error', async () => {
    prepareMarkDodMock.mockResolvedValue({ ok: false, status: 404, detail: 'project not found' });
    const r = await releaseMarkDodPhaseWorkflow('missing');
    expect(r).toEqual({ ok: false, reason: 'mark_dod_failed', status: 404, detail: 'project not found' });
    expect(fetchAndExtractMarkDodCriteriaMock).not.toHaveBeenCalled();
  });

  it('returns the terminal result when fetched.terminal is set (no criteria)', async () => {
    prepareMarkDodMock.mockResolvedValue({ bundle: BUNDLE, job: JOB });
    fetchAndExtractMarkDodCriteriaMock.mockResolvedValue({
      body: '',
      title: 'Issue title',
      authorLogin: undefined,
      criteria: [],
      terminal: { ok: true, jobId: 'dod-job-1', issueNumber: 42, verified: 0, total: 0, changed: false },
    });
    const r = await releaseMarkDodPhaseWorkflow('test-tt');
    expect(r).toEqual({ ok: true, jobId: 'dod-job-1', issueNumber: 42, verified: 0, total: 0, changed: false });
    expect(startMarkDodVerificationMock).not.toHaveBeenCalled();
  });

  it('runs the full chain (prep → fetch → switch → dispatch → wait → read → apply) on the happy path', async () => {
    prepareMarkDodMock.mockResolvedValue({ bundle: BUNDLE, job: JOB });
    const fetched = {
      body: '- [ ] First',
      title: 'Issue',
      authorLogin: 'user',
      criteria: [{ text: 'First', raw: '- [ ] First' }],
    };
    fetchAndExtractMarkDodCriteriaMock.mockResolvedValue(fetched);
    const branchSwitch = { switched: true, targetBranch: 'feat', originalBranch: 'master' };
    switchBranchForMarkDodVerificationMock.mockResolvedValue(branchSwitch);
    startMarkDodVerificationMock.mockResolvedValue({ verifyJobId: 'dod-job-1-verify' });
    const verify = { verifiedTexts: ['First'], rawOutput: '{}', exitCode: 0, timedOut: false };
    readMarkDodVerificationResultMock.mockResolvedValue(verify);
    applyAndFinalizeMarkDodMock.mockResolvedValue({
      ok: true,
      jobId: 'dod-job-1',
      issueNumber: 42,
      verified: 1,
      total: 1,
      changed: true,
    });

    const r = await releaseMarkDodPhaseWorkflow('test-tt');

    expect(prepareMarkDodMock).toHaveBeenCalledWith('test-tt', undefined);
    expect(fetchAndExtractMarkDodCriteriaMock).toHaveBeenCalledWith(BUNDLE, JOB);
    expect(switchBranchForMarkDodVerificationMock).toHaveBeenCalledWith(BUNDLE, JOB);
    expect(startMarkDodVerificationMock).toHaveBeenCalledWith(BUNDLE, JOB, 'test-tt', fetched);
    expect(waitForJobCompletionMock).toHaveBeenCalledWith('dod-job-1-verify');
    expect(readMarkDodVerificationResultMock).toHaveBeenCalledWith('dod-job-1-verify', BUNDLE, JOB, fetched);
    expect(applyAndFinalizeMarkDodMock).toHaveBeenCalledWith(BUNDLE, JOB, fetched, verify, branchSwitch);
    expect(r).toEqual({ ok: true, jobId: 'dod-job-1', issueNumber: 42, verified: 1, total: 1, changed: true });
  });

  it('short-circuits on a dispatch terminal (prompt-cost blocked) without waiting/reading', async () => {
    prepareMarkDodMock.mockResolvedValue({ bundle: BUNDLE, job: JOB });
    fetchAndExtractMarkDodCriteriaMock.mockResolvedValue({
      body: '- [ ] First',
      title: 'Issue',
      authorLogin: undefined,
      criteria: [{ text: 'First', raw: '- [ ] First' }],
    });
    switchBranchForMarkDodVerificationMock.mockResolvedValue({ switched: false, skipped: 'detached' });
    startMarkDodVerificationMock.mockResolvedValue({
      terminal: { ok: false, status: 413, detail: 'prompt too large' },
    });

    const r = await releaseMarkDodPhaseWorkflow('test-tt');

    expect(waitForJobCompletionMock).not.toHaveBeenCalled();
    expect(readMarkDodVerificationResultMock).not.toHaveBeenCalled();
    expect(applyAndFinalizeMarkDodMock).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, reason: 'mark_dod_failed', status: 413, detail: 'prompt too large' });
  });

  it('returns verify.terminal when the read step reports verification failure', async () => {
    prepareMarkDodMock.mockResolvedValue({ bundle: BUNDLE, job: JOB });
    fetchAndExtractMarkDodCriteriaMock.mockResolvedValue({
      body: '- [ ] First',
      title: 'Issue',
      authorLogin: undefined,
      criteria: [{ text: 'First', raw: '- [ ] First' }],
    });
    switchBranchForMarkDodVerificationMock.mockResolvedValue({ switched: false, skipped: 'detached' });
    startMarkDodVerificationMock.mockResolvedValue({ verifyJobId: 'dod-job-1-verify' });
    readMarkDodVerificationResultMock.mockResolvedValue({
      verifiedTexts: [],
      rawOutput: '',
      exitCode: 1,
      timedOut: false,
      terminal: { ok: true, jobId: 'dod-job-1', issueNumber: 42, verified: 0, total: 1, changed: false },
    });

    const r = await releaseMarkDodPhaseWorkflow('test-tt');

    expect(r).toEqual({ ok: true, jobId: 'dod-job-1', issueNumber: 42, verified: 0, total: 1, changed: false });
    expect(applyAndFinalizeMarkDodMock).not.toHaveBeenCalled();
  });

  it('surfaces a 500 status from applyAndFinalize as mark_dod_failed', async () => {
    prepareMarkDodMock.mockResolvedValue({ bundle: BUNDLE, job: JOB });
    fetchAndExtractMarkDodCriteriaMock.mockResolvedValue({
      body: '- [ ] First',
      title: 'Issue',
      authorLogin: undefined,
      criteria: [{ text: 'First', raw: '- [ ] First' }],
    });
    switchBranchForMarkDodVerificationMock.mockResolvedValue({ switched: false, skipped: 'detached' });
    startMarkDodVerificationMock.mockResolvedValue({ verifyJobId: 'dod-job-1-verify' });
    readMarkDodVerificationResultMock.mockResolvedValue({
      verifiedTexts: ['First'],
      rawOutput: '{}',
      exitCode: 0,
      timedOut: false,
    });
    applyAndFinalizeMarkDodMock.mockResolvedValue({ ok: false, status: 500, detail: 'gh issue edit failed: 401 unauthorized' });

    const r = await releaseMarkDodPhaseWorkflow('test-tt');

    expect(r).toEqual({
      ok: false,
      reason: 'mark_dod_failed',
      status: 500,
      detail: 'gh issue edit failed: 401 unauthorized',
    });
  });

  it('forwards override (issueNumber + repo) to prepareMarkDod', async () => {
    prepareMarkDodMock.mockResolvedValue({ ok: false, status: 400, detail: 'no context' });
    await releaseMarkDodPhaseWorkflow('test-tt', { issueNumber: 99, repo: 'acme/proj' });
    expect(prepareMarkDodMock).toHaveBeenCalledWith('test-tt', { issueNumber: 99, repo: 'acme/proj' });
  });
});

describe('mark-dod-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/mark-dod-phase.ts'), 'utf-8');
  it.each([
    'export async function releaseMarkDodPhaseWorkflow',
    'async function prepareAndFetchStep',
    'async function dispatchVerifyStep',
    'async function awaitVerifyStep',
    'async function readVerifyResultStep',
    'async function applyAndFinalizeStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
