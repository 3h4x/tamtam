import { describe, it, expect, vi } from 'vitest';
import {
  findSessionIdInLog,
  hasFinalResult,
  isAutoResumeEligible,
  MAX_AUTO_RESUME_ATTEMPTS,
} from '@/lib/jobs/auto-resume';
import type { JobData } from '@/lib/jobs/job-storage';

const NOW = 2_000_000_000_000;

function jobOf(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'agent-1',
    project: 'p',
    kind: 'agent:frontend',
    prompt: null,
    pid: 123,
    logPath: '/tmp/x.log',
    startedAt: (NOW - 5 * 60_000) / 1000,
    finishedAt: (NOW - 60_000) / 1000,
    exitCode: -1,
    seen: false,
    sessionId: 'sess-1',
    ...overrides,
  } as JobData;
}

describe('findSessionIdInLog', () => {
  it('finds the last session_id in a stream-json tail', () => {
    const buf = `{"session_id":"7abc3cf1-3748-46c3-b4df-cd934795a75f"}\n{"session_id":"7abc3cf1-3748-46c3-b4df-cd934795a75f"}`;
    expect(findSessionIdInLog(buf)).toBe('7abc3cf1-3748-46c3-b4df-cd934795a75f');
  });
  it('returns null when no session_id in tail', () => {
    expect(findSessionIdInLog('just plain text')).toBeNull();
  });
});

describe('hasFinalResult', () => {
  it('detects a result event', () => {
    expect(hasFinalResult('{"type":"result","duration_ms":100}')).toBe(true);
  });
  it('is false for partial stream events', () => {
    expect(hasFinalResult('{"type":"stream_event","event":{...}}')).toBe(false);
  });
});

describe('isAutoResumeEligible', () => {
  beforeAll();
  function beforeAll() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  const partialTail = `{"type":"stream_event","event":{"type":"content_block_delta"}}`;
  const completeTail = `{"type":"result","duration_ms":100,"is_error":false}`;

  it('accepts agent/run job that exited non-zero with no final result', () => {
    expect(isAutoResumeEligible(jobOf(), partialTail)).toBe(true);
  });
  it('accepts non-zero exit even when log has a final result event (ERROR/is_error case)', () => {
    expect(isAutoResumeEligible(jobOf(), completeTail)).toBe(true);
  });
  it('rejects clean (exit 0) jobs', () => {
    expect(isAutoResumeEligible(jobOf({ exitCode: 0 }), partialTail)).toBe(false);
  });
  it('rejects running jobs', () => {
    expect(isAutoResumeEligible(jobOf({ finishedAt: null }), partialTail)).toBe(false);
  });
  it('rejects pipeline-step kinds', () => {
    expect(isAutoResumeEligible(jobOf({ kind: 'review' }), partialTail)).toBe(false);
    expect(isAutoResumeEligible(jobOf({ kind: 'test' }), partialTail)).toBe(false);
  });
  it('rejects jobs finished more than 30 min ago', () => {
    expect(isAutoResumeEligible(jobOf({ finishedAt: (NOW - 31 * 60_000) / 1000 }), partialTail)).toBe(false);
  });
  it('rejects when the chain cap is reached', () => {
    const job = jobOf({
      contextMeta: JSON.stringify({ autoResumeChain: { count: MAX_AUTO_RESUME_ATTEMPTS } }),
    });
    expect(isAutoResumeEligible(job, partialTail)).toBe(false);
  });
  it('accepts run kind', () => {
    expect(isAutoResumeEligible(jobOf({ kind: 'run' }), partialTail)).toBe(true);
  });
});
