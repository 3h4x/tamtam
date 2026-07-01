import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listInboxSignals: vi.fn(),
}));

vi.mock('@/lib/workflows/inbox', () => ({
  listInboxSignals: (...args: unknown[]) => mocks.listInboxSignals(...args),
}));

describe('GET /api/inbox', () => {
  let GET: typeof import('@/app/api/inbox/route').GET;

  beforeEach(async () => {
    mocks.listInboxSignals.mockReset();
    ({ GET } = await import('@/app/api/inbox/route'));
  });

  it('returns the aggregated signals and counts', async () => {
    const payload = {
      signals: [
        {
          id: 'ci_red:alpha',
          type: 'ci_red',
          severity: 'red',
          project: 'alpha',
          title: 'CI failing on default branch',
          detail: null,
          href: '/project/alpha',
          externalUrl: 'https://ci/1',
          ageSeconds: null,
          action: { kind: 'fix-ci', label: 'Start fix-ci' },
        },
      ],
      counts: { red: 1, yellow: 0, green: 0, total: 1 },
    };
    mocks.listInboxSignals.mockResolvedValue(payload);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(payload);
  });

  it('returns 500 when aggregation throws', async () => {
    mocks.listInboxSignals.mockRejectedValue(new Error('boom'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe('Failed to build inbox feed');
  });
});
