import { afterEach, describe, expect, it, vi } from 'vitest';

const originalStepWindowSeconds = process.env.TAMTAM_STEP_WINDOW_SECONDS;
const originalLegacyFixWindowSeconds = process.env.TAMTAM_FIX_WINDOW_SECONDS;

function restoreEnv() {
  if (originalStepWindowSeconds === undefined) delete process.env.TAMTAM_STEP_WINDOW_SECONDS;
  else process.env.TAMTAM_STEP_WINDOW_SECONDS = originalStepWindowSeconds;
  if (originalLegacyFixWindowSeconds === undefined) delete process.env.TAMTAM_FIX_WINDOW_SECONDS;
  else process.env.TAMTAM_FIX_WINDOW_SECONDS = originalLegacyFixWindowSeconds;
}

function mockSettings(value: number | null | undefined): void {
  vi.resetModules();
  vi.doMock('@/lib/shared/config', () => ({
    getSettings: () => ({ fix_max_iterations: value }),
  }));
}

function mockSettingsThrow(): void {
  vi.resetModules();
  vi.doMock('@/lib/shared/config', () => ({
    getSettings: () => { throw new Error('settings not initialized'); },
  }));
}

describe('recovery-budget — unified fix-iteration cap', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/shared/config');
    vi.resetModules();
    restoreEnv();
  });

  it('treats setting=0 as unlimited for both step and review caps', async () => {
    mockSettings(0);
    const { getMaxStepIterations, getReviewFixMaxIterations } = await import('@/lib/pipeline/recovery-budget');
    expect(getMaxStepIterations()).toBe(Number.POSITIVE_INFINITY);
    expect(getReviewFixMaxIterations()).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns the configured setting for both caps when > 0', async () => {
    mockSettings(5);
    const { getMaxStepIterations, getReviewFixMaxIterations } = await import('@/lib/pipeline/recovery-budget');
    expect(getMaxStepIterations()).toBe(5);
    expect(getReviewFixMaxIterations()).toBe(5);
  });

  it('falls back to the default of 3 when settings are unavailable', async () => {
    mockSettingsThrow();
    const { getMaxStepIterations, getReviewFixMaxIterations } = await import('@/lib/pipeline/recovery-budget');
    expect(getMaxStepIterations()).toBe(3);
    expect(getReviewFixMaxIterations()).toBe(3);
  });

  it('falls back to the default of 3 when the setting is null or negative', async () => {
    mockSettings(null);
    let recovery = await import('@/lib/pipeline/recovery-budget');
    expect(recovery.getMaxStepIterations()).toBe(3);
    expect(recovery.getReviewFixMaxIterations()).toBe(3);

    mockSettings(-1);
    recovery = await import('@/lib/pipeline/recovery-budget');
    expect(recovery.getMaxStepIterations()).toBe(3);
    expect(recovery.getReviewFixMaxIterations()).toBe(3);
  });

  it('keeps push-fix rejection retries finite even when the setting is 0', async () => {
    mockSettings(0);
    const { getPushFixAttemptCap } = await import('@/lib/pipeline/recovery-budget');
    expect(getPushFixAttemptCap()).toBe(2);
  });
});

describe('recovery-budget — step time window', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('reads TAMTAM_STEP_WINDOW_SECONDS as the rolling-window fallback', async () => {
    process.env.TAMTAM_STEP_WINDOW_SECONDS = '2700';
    const { getStepWindowSeconds } = await import('@/lib/pipeline/recovery-budget');
    expect(getStepWindowSeconds()).toBe(2700);
  });

  it('falls back to the legacy TAMTAM_FIX_WINDOW_SECONDS when the new alias is unset', async () => {
    delete process.env.TAMTAM_STEP_WINDOW_SECONDS;
    process.env.TAMTAM_FIX_WINDOW_SECONDS = '900';
    const { getStepWindowSeconds } = await import('@/lib/pipeline/recovery-budget');
    expect(getStepWindowSeconds()).toBe(900);
  });

  it('defaults to 30 minutes when neither env var is set', async () => {
    delete process.env.TAMTAM_STEP_WINDOW_SECONDS;
    delete process.env.TAMTAM_FIX_WINDOW_SECONDS;
    const { getStepWindowSeconds } = await import('@/lib/pipeline/recovery-budget');
    expect(getStepWindowSeconds()).toBe(30 * 60);
  });
});
