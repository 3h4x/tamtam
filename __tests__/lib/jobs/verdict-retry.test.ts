import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Expose the private `classify` function for unit testing by importing the
// module after mocking its dependencies so the spawn path is never exercised.
vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn(),
}));
vi.mock('@/lib/jobs/verdict', () => ({
  readParsedLog: vi.fn(),
}));
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { getSettings } from '@/lib/shared/config';
import { readParsedLog } from '@/lib/jobs/verdict';
import { spawn } from 'child_process';
import { retryVerdictWithClaude } from '@/lib/jobs/verdict-retry';
import type { JobData } from '@/lib/jobs/types';
import { EventEmitter } from 'events';

const mockGetSettings = vi.mocked(getSettings);
const mockReadParsedLog = vi.mocked(readParsedLog);
const mockSpawn = vi.mocked(spawn);

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    project: 'proj1',
    kind: 'review',
    prompt: null,
    pid: 1234,
    logPath: '/tmp/job-1.log',
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

function makeSettings(overrides = {}) {
  return {
    review_retry_on_parse_failure: true,
    claude_bin: '/usr/local/bin/claude',
    ...overrides,
  };
}

// Build a minimal mock child process that emits stdout data then closes.
function makeMockChild(stdoutData: string) {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new EventEmitter();
  const stdin = { write: vi.fn(), end: vi.fn() };
  (child as unknown as Record<string, unknown>).stdout = stdout;
  (child as unknown as Record<string, unknown>).stdin = stdin;
  (child as unknown as Record<string, unknown>).kill = vi.fn();
  setTimeout(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', 0);
  }, 0);
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retryVerdictWithClaude — gating', () => {
  it('returns null when review_retry_on_parse_failure is false', async () => {
    mockGetSettings.mockReturnValue(makeSettings({ review_retry_on_parse_failure: false }) as ReturnType<typeof getSettings>);
    mockReadParsedLog.mockReturnValue('some review text');
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns null when log is empty', async () => {
    mockGetSettings.mockReturnValue(makeSettings() as ReturnType<typeof getSettings>);
    mockReadParsedLog.mockReturnValue('   ');
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('retryVerdictWithClaude — classify via spawn output', () => {
  beforeEach(() => {
    mockGetSettings.mockReturnValue(makeSettings() as ReturnType<typeof getSettings>);
    mockReadParsedLog.mockReturnValue('This looks fine to me overall');
  });

  it('returns LGTM when Claude outputs "LGTM"', async () => {
    mockSpawn.mockReturnValue(makeMockChild('LGTM') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBe('LGTM');
  });

  it('returns NEEDS ATTENTION when Claude outputs "NEEDS ATTENTION"', async () => {
    mockSpawn.mockReturnValue(makeMockChild('NEEDS ATTENTION') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBe('NEEDS ATTENTION');
  });

  it('returns DO NOT SHIP when Claude outputs "DO NOT SHIP"', async () => {
    mockSpawn.mockReturnValue(makeMockChild('DO NOT SHIP') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBe('DO NOT SHIP');
  });

  it('returns LGTM from sentence containing "LGTM"', async () => {
    mockSpawn.mockReturnValue(makeMockChild('The verdict is LGTM.') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBe('LGTM');
  });

  it('returns NEEDS ATTENTION from sentence containing token', async () => {
    mockSpawn.mockReturnValue(makeMockChild('I think this NEEDS ATTENTION.') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBe('NEEDS ATTENTION');
  });

  it('returns DO NOT SHIP from sentence containing token', async () => {
    mockSpawn.mockReturnValue(makeMockChild('This should DO NOT SHIP.') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBe('DO NOT SHIP');
  });

  it('returns null for unrecognised output', async () => {
    mockSpawn.mockReturnValue(makeMockChild('I cannot determine the verdict') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBeNull();
  });

  it('returns null for empty spawn output', async () => {
    mockSpawn.mockReturnValue(makeMockChild('') as ReturnType<typeof spawn>);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBeNull();
  });
});

describe('retryVerdictWithClaude — spawn error handling', () => {
  beforeEach(() => {
    mockGetSettings.mockReturnValue(makeSettings() as ReturnType<typeof getSettings>);
    mockReadParsedLog.mockReturnValue('review text here');
  });

  it('returns null when spawn throws', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBeNull();
  });

  it('returns null on child error event', async () => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    (child as unknown as Record<string, unknown>).stdout = new EventEmitter();
    (child as unknown as Record<string, unknown>).stdin = { write: vi.fn(), end: vi.fn() };
    (child as unknown as Record<string, unknown>).kill = vi.fn();
    setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0);
    mockSpawn.mockReturnValue(child);
    const result = await retryVerdictWithClaude(makeJob());
    expect(result).toBeNull();
  });
});
