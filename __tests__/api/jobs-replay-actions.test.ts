// Tests for POST /api/jobs/[jobId]/replay-actions
//
// Recovery surface for completed agent jobs whose actions were dropped by the
// completion hook (the historical "parser given the path instead of contents"
// bug, plus any future disruption between emit and dispatch). Confirms:
//   - Missing job → 404
//   - Running job → 409
//   - Job with no log → 400
//   - Eligibility failures bubble up unchanged (so the UI can show the reason)
//   - Happy path runs the orchestrator and records counts on contextMeta

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JobData } from '@/lib/jobs/job-storage';

const mocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  updateJob: vi.fn(),
  resolveProjectPath: vi.fn(),
  runAgentActions: vi.fn(),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: mocks.getJob,
  updateJob: mocks.updateJob,
}));
vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
}));
vi.mock('@/lib/agents/action-orchestrator', () => ({
  runAgentActions: mocks.runAgentActions,
}));

function makeJob(over: Partial<JobData> = {}): JobData {
  return {
    id: 'j1',
    project: 'borged',
    kind: 'agent:issue-cruncher',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 100,
    finishedAt: 200,
    exitCode: 0,
    seen: true,
    durationMs: 100,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    userPrompt: null,
    contextMeta: '{}',
    parentJobId: null,
    ghIssueNumber: 321,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    verdict: null,
    costUsd: null,
    model: null,
    releaseId: null,
    abortedAt: null,
    releaseDeadlineAt: null,
    promptBytes: null,
    workSummary: null,
    modifiedFiles: '[]',
    provider: 'claude',
    ...over,
  } as JobData;
}

function streamJsonLog(text: string): string {
  return [
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } }),
  ].join('\n');
}

describe('POST /api/jobs/[jobId]/replay-actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runAgentActions.mockResolvedValue({ executed: 2, errors: [] });
    mocks.resolveProjectPath.mockReturnValue('/tmp/borged');
  });

  async function call(jobId: string) {
    const mod = await import('@/app/api/jobs/[jobId]/replay-actions/route');
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/replay-actions`, { method: 'POST' });
    return mod.POST(req, { params: Promise.resolve({ jobId }) });
  }

  it('returns 404 when the job does not exist', async () => {
    mocks.getJob.mockReturnValue(null);
    const res = await call('missing');
    expect(res.status).toBe(404);
  });

  it('returns 409 while the job is still running', async () => {
    mocks.getJob.mockReturnValue(makeJob({ finishedAt: null, logPath: '/tmp/x.log' }));
    const res = await call('j1');
    expect(res.status).toBe(409);
  });

  it('returns 400 when the job has no log path', async () => {
    mocks.getJob.mockReturnValue(makeJob({ logPath: null }));
    const res = await call('j1');
    expect(res.status).toBe(400);
  });

  it('runs the orchestrator on the happy path and stamps contextMeta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    try {
      const logPath = join(dir, 'job.log');
      const text = '```tamtam-actions\n' + JSON.stringify({
        actions: [
          { type: 'issue-close', number: 321, reason: 'not planned' },
          { type: 'checkout-default' },
        ],
      }) + '\n```';
      writeFileSync(logPath, streamJsonLog(text));
      const job = makeJob({ logPath });
      mocks.getJob.mockReturnValue(job);

      const res = await call('j1');
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ replayed: true, executed: 2, errors: [] });
      expect(mocks.runAgentActions).toHaveBeenCalledOnce();
      expect(mocks.updateJob).toHaveBeenCalled();
      const stored = JSON.parse((mocks.updateJob.mock.calls[0][0] as JobData).contextMeta!);
      expect(stored.agentActions).toMatchObject({ executed: 2 });
      expect(stored.agentActions.replayedAt).toEqual(expect.any(Number));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 200 with reason when the log has no actions block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    try {
      const logPath = join(dir, 'job.log');
      writeFileSync(logPath, streamJsonLog('agent output without any tamtam-actions fence'));
      mocks.getJob.mockReturnValue(makeJob({ logPath }));

      const res = await call('j1');
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.replayed).toBe(false);
      expect(body.reason).toBe('missing');
      expect(mocks.runAgentActions).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces eligibility failures (e.g. action issue # mismatch with job)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    try {
      const logPath = join(dir, 'job.log');
      const text = '```tamtam-actions\n' + JSON.stringify({
        actions: [{ type: 'issue-close', number: 999, reason: 'not planned' }],
      }) + '\n```';
      writeFileSync(logPath, streamJsonLog(text));
      // Job is scoped to issue 321, but the parsed action targets 999.
      mocks.getJob.mockReturnValue(makeJob({ logPath, ghIssueNumber: 321 }));

      const res = await call('j1');
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.replayed).toBe(false);
      expect(body.reason).toBe('issue-mismatch');
      expect(mocks.runAgentActions).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
