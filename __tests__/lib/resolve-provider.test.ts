import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

describe('resolveProviderForRun', () => {
  let getJobMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let getQuotaSnapshotsMock: ReturnType<typeof vi.fn>;
  let jobsPausedResultMock: ReturnType<typeof vi.fn>;
  let pauseJobsForQuotaExhaustionMock: ReturnType<typeof vi.fn>;

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
    pauseJobsForQuotaExhaustionMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/jobs/storage', () => ({ getJob: getJobMock, listJobs: vi.fn(), updateJob: vi.fn() }));
    vi.doMock('@/lib/shared/config', () => ({ getSettings: getSettingsMock }));
    vi.doMock('@/lib/shared/job-control', () => ({
      jobsPausedResult: jobsPausedResultMock,
      pauseJobsForQuotaExhaustion: pauseJobsForQuotaExhaustionMock,
    }));
    vi.doMock('@/lib/usage/quota', () => ({ getQuotaSnapshots: getQuotaSnapshotsMock }));
  });

  afterEach(() => vi.resetModules());

  it('inherits the parent job\'s provider when it is still runnable', async () => {
    getJobMock.mockReturnValue({ id: 'parent-1', provider: 'codex' } as JobData);
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ parentJobId: 'parent-1' });
    expect(result.provider).toBe('codex');
    expect(getQuotaSnapshotsMock).toHaveBeenCalledWith(['claude', 'codex']);
  });

  it('repicks when the inherited parent provider is hard-limited and another provider is healthy', async () => {
    getJobMock.mockReturnValue({ id: 'parent-1', provider: 'claude' } as JobData);
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 100 }, sevenDay: { utilization: 71, msUntilReset: 16 * 60 * 60 * 1000 } }],
      ['codex', { fiveHour: { utilization: 3 }, sevenDay: { utilization: 18, msUntilReset: 74 * 60 * 60 * 1000 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ parentJobId: 'parent-1' });
    expect(result.provider).toBe('codex');
  });

  it('does not repick a blocked parent provider when parent inheritance is strict', async () => {
    getJobMock.mockReturnValue({ id: 'parent-1', provider: 'claude' } as JobData);
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 100 } }],
      ['codex', { fiveHour: { utilization: 3 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({
      parentJobId: 'parent-1',
      strictParentProvider: true,
    });
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('parent_provider_blocked');
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
      budget_block_runs_enabled: false,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
      ['codex', { fiveHour: { utilization: 10 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ preferred: 'claude' });
    expect(result.provider).toBe('codex');
  });

  it('picks a healthy alternate provider when the default is weekly-limited and no preference is pinned', async () => {
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 0 }, sevenDay: { utilization: 99 }, sevenDaySonnet: { utilization: 100 } }],
      ['codex', { fiveHour: { utilization: 0 }, sevenDay: { utilization: 25 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun();
    expect(result.provider).toBe('codex');
  });

  it('picks a known healthy provider when another quota-aware provider has no snapshot', async () => {
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', null],
      ['codex', { fiveHour: { utilization: 0 }, sevenDay: { utilization: 25 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun();
    expect(result.provider).toBe('codex');
  });

  it('does not route to a missing quota-aware snapshot when a sibling is known over budget', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
      ['codex', null],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun();
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('all_blocked');
  });

  it('blocks provider resolution when every quota-backed provider is exhausted even if the budget gate is disabled', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
      ['codex', { fiveHour: { utilization: 98 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun();
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('all_blocked');
  });

  it('fails open to provider order when all quota-aware providers are unknown', async () => {
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', null],
      ['codex', null],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun();
    expect(result.provider).toBe('claude');
  });

  it('uses only the requested Claude tier when consulting model-specific weekly windows', async () => {
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 24 }, sevenDay: { utilization: 20 }, sevenDaySonnet: { utilization: 100 } }],
      ['codex', { fiveHour: { utilization: 30 }, sevenDay: { utilization: 50 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({ requestedModel: 'fast' });
    expect(result.provider).toBe('claude');
  });

  it('ignores model-specific Claude weekly windows when the caller does not know the tier yet', async () => {
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 24 }, sevenDay: { utilization: 20 }, sevenDaySonnet: { utilization: 100 } }],
      ['codex', { fiveHour: { utilization: 30 }, sevenDay: { utilization: 50 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun();
    expect(result.provider).toBe('claude');
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

  it('blocks a single quota-backed CLI over threshold even if budget blocking is disabled', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['codex'],
      claude_provider: 'codex',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['codex', { fiveHour: { utilization: 99 } }],
    ]));
    const { resolveProviderForRun } = await import('@/lib/usage/resolve-provider');
    const result = await resolveProviderForRun({});
    expect(result.provider).toBeNull();
    expect(result.reason).toBe('all_blocked');
  });

  it('keeps a preferred provider when only its 7d burn is over threshold', async () => {
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 24 }, sevenDay: { utilization: 99, msUntilReset: threeDaysMs } }],
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

  it('blocks the start gate without mutating the manual jobs pause when all providers are over threshold even if budget blocking is disabled', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
      ['codex', { fiveHour: { utilization: 98 } }],
    ]));
    const { checkCliStartGate, ALL_PROVIDERS_BLOCKED_DETAIL } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a release');
    expect(result).toEqual({ ok: false, status: 429, detail: ALL_PROVIDERS_BLOCKED_DETAIL });
    expect(jobsPausedResultMock).toHaveBeenCalledTimes(1);
  });

  it('blocks a strict preferred provider when it is disabled', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['codex'],
      claude_provider: 'codex',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: false,
    });
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start an agent run', {
      preferred: 'claude',
      strictPreferred: true,
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      detail: "Selected provider 'claude' is not enabled. Pick another provider or enable it in Settings → CLI.",
    });
  });

  it('blocks a strict preferred provider when it is over budget', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', { fiveHour: { utilization: 99 } }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start an agent run', {
      preferred: 'claude',
      strictPreferred: true,
    });
    expect(result).toEqual({
      ok: false,
      status: 429,
      detail: "Selected provider 'claude' is over budget right now. Wait for its quota window to reset before trying to start with this provider.",
    });
  });

  it('blocks strict parent inheritance instead of repicking across a provider-scoped session', async () => {
    getJobMock.mockReturnValue({ id: 'parent-1', provider: 'claude' } as JobData);
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
    const result = await checkCliStartGate('start a fix job', {
      parentJobId: 'parent-1',
      strictParentProvider: true,
    });
    expect(result).toEqual({
      ok: false,
      status: 429,
      detail: "Inherited provider 'claude' is over budget right now. Wait for its quota window to reset before trying to continue this provider-scoped session.",
    });
    expect(getQuotaSnapshotsMock).toHaveBeenCalledWith(['claude']);
  });

  it('keeps strict-provider quota blocks transient so later healthy starts can recover', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock
      .mockResolvedValueOnce(new Map([
        ['claude', { fiveHour: { utilization: 99 } }],
      ]))
      .mockResolvedValueOnce(new Map([
        ['claude', { fiveHour: { utilization: 99 } }],
        ['codex', { fiveHour: { utilization: 10 } }],
      ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const blocked = await checkCliStartGate('continue a job', {
      preferred: 'claude',
      strictPreferred: true,
    });
    expect(blocked).toEqual({
      ok: false,
      status: 429,
      detail: "Selected provider 'claude' is over budget right now. Wait for its quota window to reset before trying to start with this provider.",
    });

    const recovered = await checkCliStartGate('start a release');
    expect(recovered).toEqual({ ok: true, provider: 'codex' });
    expect(jobsPausedResultMock).toHaveBeenCalledTimes(2);
  });

  it('does not block a generic start gate on projected weekly pace alone', async () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      budget_block_on_weekly_pace_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', {
        fiveHour: { utilization: 11 },
        sevenDay: { utilization: 40, msUntilReset: weekMs - 50 * 60 * 60 * 1000 },
      }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a release');
    expect(result).toEqual({ ok: true, provider: 'claude' });
  });

  it('does not block a strict preferred provider on projected weekly pace alone', async () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      budget_block_on_weekly_pace_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', {
        fiveHour: { utilization: 11 },
        sevenDay: { utilization: 40, msUntilReset: weekMs - 50 * 60 * 60 * 1000 },
      }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start an agent run', {
      preferred: 'claude',
      strictPreferred: true,
    });
    expect(result).toEqual({ ok: true, provider: 'claude' });
  });

  it('blocks a scheduled strict preferred provider on projected weekly pace', async () => {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      budget_block_on_weekly_pace_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', {
        fiveHour: { utilization: 11 },
        sevenDay: { utilization: 40, msUntilReset: weekMs - 50 * 60 * 60 * 1000 },
      }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start an agent run', {
      preferred: 'claude',
      strictPreferred: true,
      isScheduled: true,
    });
    expect(result).toEqual({
      ok: false,
      status: 429,
      detail: "Selected provider 'claude' is over budget right now. Wait for its quota window to reset before trying to start with this provider.",
    });
  });

  it('blocks a strict preferred provider on current weekly utilization when the weekly hard gate is enabled', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
      budget_block_on_weekly_pace_enabled: true,
    });
    getQuotaSnapshotsMock.mockResolvedValue(new Map([
      ['claude', {
        fiveHour: { utilization: 11 },
        sevenDay: { utilization: 99, msUntilReset: 4 * 24 * 60 * 60 * 1000 },
      }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start an agent run', {
      preferred: 'claude',
      strictPreferred: true,
    });
    expect(result).toEqual({
      ok: false,
      status: 429,
      detail: "Selected provider 'claude' is over budget right now. Wait for its quota window to reset before trying to start with this provider.",
    });
  });

  it('blocks the start gate and globally pauses when all enabled providers are unavailable', async () => {
    getSettingsMock.mockReturnValue({
      cli_enabled_providers: ['claude', 'codex'],
      claude_provider: 'claude',
      budget_block_at_pct: 95,
      budget_block_runs_enabled: true,
    });
    getQuotaSnapshotsMock
      .mockResolvedValueOnce(new Map([
        ['claude', { fiveHour: { utilization: 99 } }],
        ['codex', null],
      ]))
      .mockResolvedValueOnce(new Map([
        ['claude', { fiveHour: { utilization: 40 } }],
        ['codex', { fiveHour: { utilization: 10 } }],
      ]));
    const { checkCliStartGate, ALL_PROVIDERS_BLOCKED_DETAIL } = await import('@/lib/usage/resolve-provider');
    const blocked = await checkCliStartGate('start a release');
    expect(blocked).toEqual({ ok: false, status: 429, detail: ALL_PROVIDERS_BLOCKED_DETAIL });
    expect(pauseJobsForQuotaExhaustionMock).toHaveBeenCalledWith(ALL_PROVIDERS_BLOCKED_DETAIL);
    expect(jobsPausedResultMock).toHaveBeenCalledTimes(1);

    const recovered = await checkCliStartGate('start a release');
    expect(recovered).toEqual({ ok: true, provider: 'codex' });
    expect(pauseJobsForQuotaExhaustionMock).toHaveBeenCalledTimes(1);
    expect(jobsPausedResultMock).toHaveBeenCalledTimes(2);
  });

  it('enforces the global pause by default', async () => {
    jobsPausedResultMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start a release.',
    });
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a release');
    expect(result).toEqual({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start a release.',
    });
  });

  it('allows an explicit manual bypass when the caller opts out of jobs_paused', async () => {
    jobsPausedResultMock.mockReturnValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start a terminal run.',
    });
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a terminal run', { respectJobsPaused: false });
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
      ['claude', { fiveHour: { utilization: 24 }, sevenDay: { utilization: 99, msUntilReset: threeDaysMs } }],
    ]));
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const result = await checkCliStartGate('start a release');
    expect(result).toEqual({ ok: true, provider: 'claude' });
  });
});
