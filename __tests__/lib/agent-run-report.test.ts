import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'portal-agent:tests-1',
    project: 'portal',
    kind: 'agent:tests',
    prompt: null,
    pid: 1,
    logPath: null,
    startedAt: 100,
    finishedAt: null,
    exitCode: 0,
    seen: false,
    contextMeta: JSON.stringify({
      agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
      baseline: { head: 'abc123', status: '', dirty: false },
    }),
    ...overrides,
  };
}

const log = (text: string) => [
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, session_id: 's1', result: '' }),
].join('\n');

describe('finalizeAgentRunReport', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let upsertRecommendationMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    upsertRecommendationMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/repo');
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/recommendations/recommendations', () => ({ upsertRecommendation: upsertRecommendationMock }));
  });

  it('stores a compact summary and changed repo files', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Added focused coverage.\nFiles changed: src/lib/foo.ts\nActionable work: yes\n'));

    expect(job.workSummary).toBe('Added focused coverage.');
    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/foo.ts', status: 'M', confidence: 'high' },
    ]);
    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('creates a schedule recommendation for successful no-op runs', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: No coverage gaps found.\nFiles changed: none\nActionable work: no\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([]);
    expect(upsertRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({
      project: 'portal',
      type: 'agent_schedule_backoff',
      agentName: 'tests',
      payload: expect.objectContaining({ currentSchedule: '2h', recommendedSchedule: '8h' }),
    }));
  });

  it('does not recommend schedule changes for manual runs', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'manual' },
        baseline: { head: 'abc123', status: '', dirty: false },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: No coverage gaps found.\nFiles changed: none\nActionable work: no\n'));

    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('does not recommend schedule changes when the report is ambiguous', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: No coverage gaps found.\nFiles changed: none\n'));

    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('keeps dirty-baseline file summaries non-empty but still skips schedule backoff', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M  src/lib/foo.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: 'M\tsrc/lib/foo.ts\n', dirty: true },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Added focused coverage.\nFiles changed: src/lib/foo.ts\nActionable work: no\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/foo.ts', status: 'M', confidence: 'low' },
    ]);
    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('does not recommend schedule changes for failed runs', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({ exitCode: 1 });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Failed.\nFiles changed: none\nActionable work: no\n'));

    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('falls back to the last paragraph when the report block is missing', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(
      job,
      log('Investigated recent changes.\n\nNo actionable coverage gaps remain after the latest checks.'),
    );

    expect(job.workSummary).toBe('No actionable coverage gaps remain after the latest checks.');
    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('deduplicates files found in both git diff and git status', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M  src/lib/foo.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Updated tests.\nFiles changed: src/lib/foo.ts\nActionable work: yes\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/foo.ts', status: 'M', confidence: 'high' },
    ]);
  });

  it('skips git inspection when the project path cannot be resolved', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: No repo path.\nFiles changed: none\nActionable work: yes\n'));

    expect(job.modifiedFiles).toBe('[]');
    expect(execMock).not.toHaveBeenCalled();
  });
});
