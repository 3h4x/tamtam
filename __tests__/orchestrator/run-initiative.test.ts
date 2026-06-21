import { describe, it, expect, vi } from 'vitest';
import { startInitiativeRun, extractJobId, extractRunStartResult } from '@/lib/orchestrator/run-initiative';
import type { InitiativeRow } from '@/lib/orchestrator/initiatives-store';

const row: InitiativeRow = {
  id: 1, project: 'proj', source: 'mining', kind: 'lint', title: 't', rationale: 'r',
  prompt: 'Fix all lint errors.', score: 100, status: 'running', dedupKey: 'd',
  releaseId: null, attempts: 1, cooldownUntil: null, pinnedAt: null, createdAt: 0, updatedAt: 0,
};

describe('extractJobId', () => {
  it('returns job_id from snake_case response', () => {
    expect(extractJobId({ job_id: 'j1' })).toBe('j1');
  });

  it('returns jobId from camelCase response', () => {
    expect(extractJobId({ jobId: 'j2' })).toBe('j2');
  });

  it('returns null when neither key is present', () => {
    expect(extractJobId({})).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractJobId(null)).toBeNull();
  });
});

describe('extractRunStartResult', () => {
  it('returns started when the response has a job id', () => {
    expect(extractRunStartResult({ job_id: 'j1' })).toEqual({ status: 'started', jobId: 'j1' });
  });

  it('returns queued for a route-level queued response without job_id', () => {
    expect(extractRunStartResult({ status: 'queued', detail: 'pipeline lock' })).toEqual({
      status: 'queued',
      detail: 'pipeline lock',
    });
  });

  it('returns queued for a scheduled skip response without job_id', () => {
    expect(extractRunStartResult({ status: 'skipped', detail: 'awaiting pr merge' })).toEqual({
      status: 'queued',
      detail: 'awaiting pr merge',
    });
  });
});

describe('startInitiativeRun', () => {
  it('starts an agent run carrying the initiative prompt', async () => {
    const startRun = vi.fn(async () => ({ status: 'started' as const, jobId: 'job-1' }));
    const result = await startInitiativeRun('proj', row, { startRun });
    expect(startRun).toHaveBeenCalledWith({ project: 'proj', prompt: 'Fix all lint errors.' });
    expect(result).toEqual({ status: 'started', jobId: 'job-1' });
  });

  it('returns a queued handoff without throwing', async () => {
    const startRun = vi.fn(async () => ({ status: 'queued' as const, detail: 'pipeline lock' }));
    await expect(startInitiativeRun('proj', row, { startRun })).resolves.toEqual({
      status: 'queued',
      detail: 'pipeline lock',
    });
  });

  it('propagates a start failure', async () => {
    const startRun = vi.fn(async () => { throw new Error('cannot start'); });
    await expect(startInitiativeRun('proj', row, { startRun })).rejects.toThrow('cannot start');
  });
});
