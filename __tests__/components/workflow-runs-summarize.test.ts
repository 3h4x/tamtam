import { describe, expect, it } from 'vitest';
import {
  summarizeOutcome,
  summarizeOutcomeDetail,
} from '@/components/workflow-runs/summarize';

describe('workflow run summaries', () => {
  it('normalizes cancelled waited-job exits in both outcome and detail', () => {
    const run = {
      status: 'completed',
      error: null,
      output: { waited: { job: { exitCode: -3 } } },
    };

    expect(summarizeOutcome(run)).toEqual({ label: 'cancelled', tone: 'err' });
    expect(summarizeOutcomeDetail(run)).toBe('cancelled');
  });

  it('keeps non-cancelled waited-job exits as raw exit details', () => {
    const run = {
      status: 'completed',
      error: null,
      output: { waited: { job: { exitCode: 2 } } },
    };

    expect(summarizeOutcome(run)).toEqual({ label: 'exit 2', tone: 'err' });
    expect(summarizeOutcomeDetail(run)).toBe('exit 2');
  });
});
