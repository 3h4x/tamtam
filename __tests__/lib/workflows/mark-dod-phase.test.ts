import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const startMarkDodMock = vi.fn();

vi.mock('@/lib/pipeline/start-mark-dod', () => ({
  startMarkDod: (...args: unknown[]) => startMarkDodMock(...args),
}));

import { releaseMarkDodPhaseWorkflow } from '@/lib/workflows/phases/mark-dod-phase';

describe('releaseMarkDodPhaseWorkflow', () => {
  beforeEach(() => {
    startMarkDodMock.mockReset();
  });

  it('returns ok with verified counts on a successful run', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true,
      jobId: 'dod-job-1',
      issueNumber: 42,
      verified: 3,
      total: 4,
      changed: true,
    });
    const r = await releaseMarkDodPhaseWorkflow('test-tt');
    expect(startMarkDodMock).toHaveBeenCalledWith('test-tt', undefined);
    expect(r).toEqual({
      ok: true,
      jobId: 'dod-job-1',
      issueNumber: 42,
      verified: 3,
      total: 4,
      changed: true,
    });
  });

  it('forwards override (issueNumber/prNumber/repo) to startMarkDod', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true,
      jobId: 'dod-job-1',
      issueNumber: 99,
      verified: 1,
      total: 1,
      changed: false,
    });
    const override = { issueNumber: 99, repo: '3h4x/test-tt' };
    await releaseMarkDodPhaseWorkflow('test-tt', override);
    expect(startMarkDodMock).toHaveBeenCalledWith('test-tt', override);
  });

  it('forwards prNumber override for PR-backed releases', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true,
      jobId: 'dod-job-2',
      issueNumber: 0,
      verified: 2,
      total: 2,
      changed: true,
    });
    await releaseMarkDodPhaseWorkflow('test-tt', { prNumber: 7 });
    expect(startMarkDodMock).toHaveBeenCalledWith('test-tt', { prNumber: 7 });
  });

  it('surfaces changed=false when no checkbox edits were made', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: true,
      jobId: 'dod-job-3',
      issueNumber: 10,
      verified: 0,
      total: 3,
      changed: false,
    });
    const r = await releaseMarkDodPhaseWorkflow('test-tt');
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.verified).toBe(0);
      expect(r.total).toBe(3);
    }
  });

  it('returns ok:false with mark_dod_failed when startMarkDod errors', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: false,
      status: 404,
      detail: 'project not found',
    });
    const r = await releaseMarkDodPhaseWorkflow('missing');
    expect(r).toEqual({
      ok: false,
      reason: 'mark_dod_failed',
      status: 404,
      detail: 'project not found',
    });
  });

  it('preserves non-trivial detail through mark_dod_failed branch', async () => {
    startMarkDodMock.mockResolvedValue({
      ok: false,
      status: 500,
      detail: 'gh issue edit failed: 401 unauthorized',
    });
    const r = await releaseMarkDodPhaseWorkflow('test-tt');
    if (!r.ok) {
      expect(r.detail).toMatch(/gh issue edit failed/);
      expect(r.status).toBe(500);
    }
  });
});

describe('mark-dod-phase source guards', () => {
  const SRC = readFileSync(resolve(__dirname, '../../../lib/workflows/phases/mark-dod-phase.ts'), 'utf-8');
  it.each([
    'export async function releaseMarkDodPhaseWorkflow',
    'async function markDodStep',
  ])("'%s' body has the right directive", (sig) => {
    const fnIndex = SRC.indexOf(sig);
    expect(fnIndex).toBeGreaterThan(-1);
    const bodyStart = SRC.indexOf('{', fnIndex);
    const after = SRC.slice(bodyStart, bodyStart + 200);
    const expected = sig.includes('Workflow') ? /['"]use workflow['"]/ : /['"]use step['"]/;
    expect(after).toMatch(expected);
  });
});
