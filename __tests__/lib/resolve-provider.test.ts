import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

describe('resolveProviderForRun', () => {
  let getJobMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let getQuotaSnapshotsMock: ReturnType<typeof vi.fn>;
  let jobsPausedResultMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    getJobMock = vi.fn();
    getSettingsMock = vi.fn(() => ({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    }));
    getQuotaSnapshotsMock = vi.fn().mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 50 } }],
      ['codex', { fiveHour: { utilization: 10 } }],
    ]));
    jobsPausedResultMock = vi.fn().mockReturnValue(null);

    vi.doMock('@/lib/jobs/storage', () => ({ getJob: getJobMock, listJobs: vi.fn(), updateJob: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: getSettingsMock }));
    vi.doMock('@/lib/shared/job-control', () => ({ jobsPausedResult: jobsPausedResultMock }));
    vi.doMock('@/lib/usage/quota', () => ({ getQuotaSnapshots: getQuotaSnapshotsMock }));
  });

  afterEach(() => vi.resetModules());

  it('inherits the parent job\'s provider when set', async () => {
    getJobMock.mockReturnValue({ id: 'parent-1', provider: 'codex' } as JobData);
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ parentJobId: 'parent-1' });
    expect(result.provider).toBe('codex');
    // Parent inheritance should not even consult the picker.
    expect(getQuotaSnapshotsMock).not.toHaveBeenCalled();
  });

  it('falls through to the picker when the parent has no provider', async () => {
    getJobMock.mockReturnValue({ id: 'parent-2', provider: null } as JobData);
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ parentJobId: 'parent-2' });
    // codex has lower utilization → most-remaining-quota wins.
    expect(result.provider).toBe('codex');
  });

  it('honours an explicit `preferred` when it is in the enabled set', async () => {
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ preferred: 'claude' });
    expect(result.provider).toBe('claude');
  });

  it('falls back from a blocked preferred provider to a healthy enabled alternative', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
      ['codex', { fiveHour: { utilization: 10 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ preferred: 'claude' });
    expect(result.provider).toBe('codex');
  });

  it('skips an explicit `preferred` that is not enabled and falls back to the picker', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['codex'],
      claude_provider: 'codex',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    });
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ preferred: 'gemini' });
    expect(result.provider).toBe('codex');
  });

  it('takes the fast path for a single enabled CLI without fetching quotas', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['lmstudio'],
      claude_provider: 'lmstudio',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    });
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({});
    expect(result.provider).toBe('lmstudio');
    expect(getQuotaSnapshotsMock).not.toHaveBeenCalled();
  });

  it('still enforces the budget gate for a single enabled CLI', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({});
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('all_blocked');
  });

  it('keeps a preferred provider when only its 7d burn is hot but 5h is healthy', async () => {
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      // claude: 5h low but weekly burn is hot. Manual/root gating should
      // still accept it because weekly burn is scheduled-only.
      ['claude', { fiveHour: { utilization: 24 }, sevenDay: { utilization: 71, msUntilReset: threeDaysMs } }],
      ['codex', { fiveHour: { utilization: 35 }, sevenDay: { utilization: 34, msUntilReset: fourDaysMs } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ preferred: 'claude' });
    expect(result.provider).toBe('claude');
  });

  it('uses the same chooser for the start gate, allowing a healthy alternate provider', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
      ['codex', { fiveHour: { utilization: 10 } }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a release');
    expect(result).toEqual({ ok: true, provider: 'codex' });
  });

  it('does not block a root start gate on weekly burn alone', async () => {
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 24 }, sevenDay: { utilization: 71, msUntilReset: threeDaysMs } }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a release');
    expect(result).toEqual({ ok: true, provider: 'claude' });
  });
});
