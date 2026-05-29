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
    // Default: empty success. Tests that need specific stdout use
    // `.mockResolvedValueOnce(...)`; subsequent calls (numstat) fall back
    // to this empty result so the worktree-delta path doesn't crash on
    // undefined when a test only stubs the first two execs.
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
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
        // Two consumers: retrieval (`select().from().where().limit()`) and
        // fruitfulness (`select(cols).from().where().orderBy().limit()`).
        // The `where` builder also has to expose `orderBy` for the second.
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockReturnValue({ execute: insertExecuteMock }),
          }),
        }),
      },
      schema: {
        retrievalRecords: { id: 'id' },
        jobs: {
          id: 'id',
          kind: 'kind',
          project: 'project',
          startedAt: 'started_at',
          exitCode: 'exit_code',
          finishedAt: 'finished_at',
          modifiedFiles: 'modified_files',
          linesAdded: 'lines_added',
          linesRemoved: 'lines_removed',
          contextMeta: 'context_meta',
        },
      },
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

  it('captures LOC delta from git diff --numstat for both committed and uncommitted change', async () => {
    // Call order (worktreeDelta fires all four in one Promise.all):
    //   1. git diff --name-status BASE..HEAD
    //   2. git diff --numstat     BASE..HEAD
    //   3. git status --porcelain
    //   4. git diff --numstat     HEAD       (uncommitted)
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '10\t3\tsrc/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/bar.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '2\t1\tsrc/bar.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Edited two files.\nFiles changed: src/foo.ts, src/bar.ts\nActionable work: yes\n'));

    // Both committed (10/3) and uncommitted (2/1) deltas sum together.
    expect(job.linesAdded).toBe(12);
    expect(job.linesRemoved).toBe(4);
  });

  it('treats binary file deltas (`-` in numstat) as zero LOC', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/img.png\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '-\t-\tsrc/img.png\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob();

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Updated an asset.\nFiles changed: src/img.png\nActionable work: yes\n'));

    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
    // Still recorded the file change — fruitfulness considers either signal.
    expect(JSON.parse(job.modifiedFiles ?? '[]')).toHaveLength(1);
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

  it('attributes a baseline-dirty path as low confidence when the agent did not touch it', async () => {
    // Baseline: src/lib/foo.ts already dirty (someone left it uncommitted).
    // Agent's run: no committed delta, status still shows the same file.
    // Expectation: file persists as low confidence; LOC is 0; gate would skip.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '99\t12\tsrc/lib/foo.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: ' M src/lib/foo.ts\n', dirty: true },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Re-audited; no edits required.\nFiles changed: none\nActionable work: no\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/foo.ts', status: 'M', confidence: 'low' },
    ]);
    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
  });

  it('attributes high confidence on a NEW path even when the baseline was dirty', async () => {
    // Baseline has src/lib/pre-existing.ts dirty (poisoning the prior model).
    // Agent then creates src/lib/new.ts. Under the old "global confidence"
    // model the new file would be marked low and the gate would skip — that
    // was the bug that made bonker stop releasing. Per-file attribution
    // correctly marks the pre-existing path low and the new path high, so
    // the gate accepts and the release fires.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: ' M src/lib/pre-existing.ts\n?? src/lib/new.ts\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '99\t12\tsrc/lib/pre-existing.ts\n42\t0\tsrc/lib/new.ts\n',
        stderr: '',
      });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: ' M src/lib/pre-existing.ts\n', dirty: true },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Added a new doc.\nFiles changed: src/lib/new.ts\nActionable work: yes\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/new.ts', status: '??', confidence: 'high' },
      { path: 'src/lib/pre-existing.ts', status: 'M', confidence: 'low' },
    ]);
    // Only the agent's own file contributes LOC; pre-existing 99/12 is filtered.
    expect(job.linesAdded).toBe(42);
    expect(job.linesRemoved).toBe(0);
  });

  it('attributes high confidence to committed delta even on a dirty baseline', async () => {
    // The agent committed src/lib/foo.ts during its run (BASE..HEAD shows
    // the commit). Even if pre-existing.ts is also dirty, the committed
    // delta is unambiguously the agent's work.
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '5\t3\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/lib/pre-existing.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '99\t12\tsrc/lib/pre-existing.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: ' M src/lib/pre-existing.ts\n', dirty: true },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Refactored foo.\nFiles changed: src/lib/foo.ts\nActionable work: yes\n'));

    const files = JSON.parse(job.modifiedFiles ?? '[]') as Array<Record<string, unknown>>;
    expect(files).toContainEqual({ path: 'src/lib/foo.ts', status: 'M', confidence: 'high' });
    expect(files).toContainEqual({ path: 'src/lib/pre-existing.ts', status: 'M', confidence: 'low' });
    // Committed 5/3 counts; pre-existing 99/12 filtered.
    expect(job.linesAdded).toBe(5);
    expect(job.linesRemoved).toBe(3);
  });

  it('keeps a baseline-dirty path high confidence when the agent committed that same path', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '5\t3\tsrc/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/lib/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '99\t12\tsrc/lib/foo.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: ' M src/lib/foo.ts\n', dirty: true },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Committed foo.\nFiles changed: src/lib/foo.ts\nActionable work: yes\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/foo.ts', status: 'M', confidence: 'high' },
    ]);
    // Count the committed delta, not the pre-existing dirty worktree residue.
    expect(job.linesAdded).toBe(5);
    expect(job.linesRemoved).toBe(3);
  });

  it('does not attribute unrelated committed delta on a dirty-baseline no-op report', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tsrc/lib/unrelated.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '13\t4\tsrc/lib/unrelated.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: ' M src/lib/pre-existing.ts\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '99\t12\tsrc/lib/pre-existing.ts\n', stderr: '' });
    const { finalizeAgentRunReport } = await import('@/lib/agents/agent-run-report');
    const job = makeJob({
      contextMeta: JSON.stringify({
        agent: { id: 'agent-1', name: 'tests', schedule: '2h', triggeredBy: 'schedule' },
        baseline: { head: 'abc123', status: ' M src/lib/pre-existing.ts\n', dirty: true },
      }),
    });

    await finalizeAgentRunReport(job, log('TamTam Run Report\nSummary: Re-audited; no edits required.\nFiles changed: none\nActionable work: no\n'));

    expect(JSON.parse(job.modifiedFiles ?? '[]')).toEqual([
      { path: 'src/lib/pre-existing.ts', status: 'M', confidence: 'low' },
      { path: 'src/lib/unrelated.ts', status: 'M', confidence: 'low' },
    ]);
    expect(job.linesAdded).toBe(0);
    expect(job.linesRemoved).toBe(0);
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
