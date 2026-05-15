import { describe, it, expect, vi, beforeEach } from 'vitest';

const { quickAddJobMock } = vi.hoisted(() => ({ quickAddJobMock: vi.fn() }));
vi.mock('graphile-worker', () => ({
  quickAddJob: quickAddJobMock,
}));

import { seedSystemCron } from '@/lib/workflows/cron/seed-system-cron';

describe('seedSystemCron', () => {
  beforeEach(() => {
    quickAddJobMock.mockClear().mockResolvedValue(undefined);
  });

  it('enqueues system-cron with preserve_run_at and 1h initial delay', async () => {
    const NOW = 1_700_000_000_000;
    const r = await seedSystemCron({
      connectionString: 'postgres://stub',
      now: () => NOW,
    });
    expect(r.enqueued).toBe(true);
    expect(r.runAt?.getTime()).toBe(NOW + 60 * 60 * 1000);
    expect(quickAddJobMock).toHaveBeenCalledTimes(1);
    const args = quickAddJobMock.mock.calls[0] as unknown as [
      unknown, string, object, { jobKey: string; jobKeyMode: string; runAt: Date }
    ];
    expect(args[1]).toBe('system-cron');
    expect(args[3]).toMatchObject({
      jobKey: 'system-cron',
      jobKeyMode: 'preserve_run_at',
    });
  });

  it('respects initialDelayMs override', async () => {
    const NOW = 1_700_000_000_000;
    const r = await seedSystemCron({
      connectionString: 'postgres://stub',
      now: () => NOW,
      initialDelayMs: 5_000,
    });
    expect(r.runAt?.getTime()).toBe(NOW + 5_000);
  });

  it('returns no-op when no postgres URL is available', async () => {
    const prevDb = process.env.DATABASE_URL;
    const prevWf = process.env.WORKFLOW_POSTGRES_URL;
    delete process.env.DATABASE_URL;
    delete process.env.WORKFLOW_POSTGRES_URL;
    try {
      const r = await seedSystemCron({});
      expect(r.enqueued).toBe(false);
      expect(r.reason).toBe('no postgres URL');
    } finally {
      if (prevDb) process.env.DATABASE_URL = prevDb;
      if (prevWf) process.env.WORKFLOW_POSTGRES_URL = prevWf;
    }
  });

  it('records enqueue failures instead of throwing', async () => {
    quickAddJobMock.mockRejectedValueOnce(new Error('pg down'));
    const r = await seedSystemCron({ connectionString: 'postgres://stub' });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toMatch(/pg down/);
  });
});
