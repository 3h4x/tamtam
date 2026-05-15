import { afterEach, describe, expect, it } from 'vitest';

const originalMaxStepIterations = process.env.TAMTAM_MAX_STEP_ITERATIONS;
const originalLegacyMaxFixIterations = process.env.TAMTAM_MAX_FIX_ITERATIONS;
const originalStepWindowSeconds = process.env.TAMTAM_STEP_WINDOW_SECONDS;
const originalLegacyFixWindowSeconds = process.env.TAMTAM_FIX_WINDOW_SECONDS;

function restoreRecoveryBudgetEnv() {
  if (originalMaxStepIterations === undefined) delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
  else process.env.TAMTAM_MAX_STEP_ITERATIONS = originalMaxStepIterations;
  if (originalLegacyMaxFixIterations === undefined) delete process.env.TAMTAM_MAX_FIX_ITERATIONS;
  else process.env.TAMTAM_MAX_FIX_ITERATIONS = originalLegacyMaxFixIterations;
  if (originalStepWindowSeconds === undefined) delete process.env.TAMTAM_STEP_WINDOW_SECONDS;
  else process.env.TAMTAM_STEP_WINDOW_SECONDS = originalStepWindowSeconds;
  if (originalLegacyFixWindowSeconds === undefined) delete process.env.TAMTAM_FIX_WINDOW_SECONDS;
  else process.env.TAMTAM_FIX_WINDOW_SECONDS = originalLegacyFixWindowSeconds;
}

describe('recovery-budget helpers', () => {
  afterEach(() => {
    restoreRecoveryBudgetEnv();
  });

  it('prefers TAMTAM_MAX_STEP_ITERATIONS over the legacy fix-iteration env', async () => {
    process.env.TAMTAM_MAX_STEP_ITERATIONS = '5';
    process.env.TAMTAM_MAX_FIX_ITERATIONS = '3';

    const { getMaxStepIterations } = await import('@/lib/pipeline/recovery-budget');
    expect(getMaxStepIterations()).toBe(5);
  });

  it('falls back to the legacy fix-iteration env when the new alias is unset', async () => {
    delete process.env.TAMTAM_MAX_STEP_ITERATIONS;
    process.env.TAMTAM_MAX_FIX_ITERATIONS = '4';

    const { getMaxStepIterations } = await import('@/lib/pipeline/recovery-budget');
    expect(getMaxStepIterations()).toBe(4);
  });

  it('shares the release fallback window with stats and lifecycle', async () => {
    process.env.TAMTAM_STEP_WINDOW_SECONDS = '2700';

    const { getStepWindowSeconds, getPushFixAttemptCap } = await import('@/lib/pipeline/recovery-budget');
    expect(getStepWindowSeconds()).toBe(2700);
    expect(getPushFixAttemptCap()).toBe(2);
  });

  it('falls back to the legacy TAMTAM_FIX_WINDOW_SECONDS when the new alias is unset', async () => {
    delete process.env.TAMTAM_STEP_WINDOW_SECONDS;
    process.env.TAMTAM_FIX_WINDOW_SECONDS = '900';

    const { getStepWindowSeconds } = await import('@/lib/pipeline/recovery-budget');
    expect(getStepWindowSeconds()).toBe(900);
  });
});
