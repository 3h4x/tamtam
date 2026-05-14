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
  let ingestAgentRunMock: ReturnType<typeof vi.fn>;
  let insertExecuteMock: ReturnType<typeof vi.fn>;
  let pgvectorBackendCtorMock: (...args: unknown[]) => void;
  let settingsMock: {
    retrieval_enabled: boolean;
    retrieval_ollama_url: string;
    retrieval_embedding_model: string;
  };

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    upsertRecommendationMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/repo');
    ingestAgentRunMock = vi.fn().mockResolvedValue({ contentHash: 'hash-1', skipped: false, stored: true });
    insertExecuteMock = vi.fn().mockResolvedValue(undefined);
    pgvectorBackendCtorMock = vi.fn();
    settingsMock = {
      retrieval_enabled: false,
      retrieval_ollama_url: 'http://localhost:11434',
      retrieval_embedding_model: 'nomic-embed-text',
    };
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/recommendations/recommendations', () => ({ upsertRecommendation: upsertRecommendationMock }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: () => settingsMock }));
    vi.doMock('@/lib/agents/retrieval/pgvector-backend', () => ({
      PgvectorBackend: class {
        constructor(...args: unknown[]) {
          pgvectorBackendCtorMock(...args);
        }
      },
    }));
    vi.doMock('@/lib/agents/retrieval/ingestion', () => ({ ingestAgentRun: ingestAgentRunMock }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockReturnValue({ execute: insertExecuteMock }),
          }),
        }),
      },
      schema: { retrievalRecords: { id: 'id' } },
    }));
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
      sourceId: 'portal-agent:tests-1',
      detail: 'Recent run reported no actionable work and changed 0 files. Current schedule is 2h; consider 8h.',
      payload: expect.objectContaining({
        currentSchedule: '2h',
        recommendedSchedule: '8h',
        confidence: 'high',
        reasoning: {
          summary: 'No coverage gaps found.',
          actionableWork: false,
          filesChangedCount: 0,
          currentSchedule: '2h',
          recommendedSchedule: '8h',
          confidence: 'high',
          sourceJobId: 'portal-agent:tests-1',
        },
      }),
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

  it('falls back to the trailing summary block when the report block is missing', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(
      job,
      log('Investigated recent changes.\n\nNo actionable coverage gaps remain after the latest checks.'),
    );

    expect(job.workSummary).toBe(
      'Investigated recent changes.\n\nNo actionable coverage gaps remain after the latest checks.'
    );
    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('stops at narration markers when walking back through paragraphs', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(
      job,
      log("Let me read the file first.\n\nNow I'll fix the bug.\n\nFixed the off-by-one in foo.ts and added a regression test."),
    );

    expect(job.workSummary).toBe('Fixed the off-by-one in foo.ts and added a regression test.');
  });

  it('stops at bare gerund narration markers when walking back through paragraphs', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(
      job,
      log('Reviewing the failing specs first.\n\nChecking the fixture setup now.\n\nFixed the off-by-one in foo.ts and added a regression test.'),
    );

    expect(job.workSummary).toBe('Fixed the off-by-one in foo.ts and added a regression test.');
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

  it('stamps ghIssueNumber from summary when the issue-cruncher agent has no prior issue reference', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({ kind: 'agent:issue-cruncher', ghIssueNumber: null });

    await finalizeAgentRunReport(
      job,
      log('TamTam Run Report\nSummary: Worked issue `#70`, fixed the root cause.\nActionable work: yes\n'),
    );

    expect(job.ghIssueNumber).toBe(70);
  });

  it('does not overwrite an existing ghIssueNumber on an issue-cruncher run', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({ kind: 'agent:issue-cruncher', ghIssueNumber: 5 });

    await finalizeAgentRunReport(
      job,
      log('TamTam Run Report\nSummary: Worked issue `#70`, fixed the root cause.\nActionable work: yes\n'),
    );

    expect(job.ghIssueNumber).toBe(5);
  });

  it('records work summary for issue-triggered plain runs without schedule backoff', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/issues/fix.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      kind: 'run',
      ghIssueNumber: 42,
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: '', dirty: false },
      }),
    });

    await finalizeAgentRunReport(
      job,
      log('TamTam Run Report\nSummary: Fixed the issue path and added coverage.\nFiles changed: src/issues/fix.ts\nActionable work: no\n'),
    );

    expect(job.workSummary).toBe('Fixed the issue path and added coverage.');
    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/issues/fix.ts', status: 'M', confidence: 'high' },
    ]);
    expect(upsertRecommendationMock).not.toHaveBeenCalled();
  });

  it('does not write retrieval records when vector storage fails', async () => {
    settingsMock.retrieval_enabled = true;
    ingestAgentRunMock.mockResolvedValueOnce({ contentHash: 'hash-2', skipped: false, stored: false });
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: No coverage gaps found.\nFiles changed: none\nActionable work: no\n'));

    await Promise.resolve();
    await Promise.resolve();
    expect(ingestAgentRunMock).toHaveBeenCalledOnce();
    expect(insertExecuteMock).not.toHaveBeenCalled();
  });
});
