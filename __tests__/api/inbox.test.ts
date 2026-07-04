import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listInboxSignals: vi.fn(),
}));

interface Sig { severity: 'red' | 'yellow' | 'green' }
vi.mock('@/lib/workflows/inbox', () => ({
  // Faithful re-impl of the real countInboxSignals so the route's per-project
  // recount is exercised without importing the db-backed inbox module.
  countInboxSignals: (signals: Sig[]) => {
    const counts = { red: 0, yellow: 0, green: 0, total: signals.length };
    for (const s of signals) counts[s.severity] += 1;
    return counts;
  },
  listInboxSignals: (...args: unknown[]) => mocks.listInboxSignals(...args),
}));

function req(url = 'http://test/api/inbox'): Request {
  return new Request(url);
}

const alphaSignal = {
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
};

const betaSignal = {
  id: 'pr_needs_manual_merge:beta:7',
  type: 'pr_needs_manual_merge',
  severity: 'yellow',
  project: 'beta',
  title: 'PR #7 needs manual merge',
  detail: 'Auto-merge deferred — PR diff touches high-risk execution files. High-risk files: src/x.ts.',
  href: '/project/beta/issues',
  externalUrl: 'https://github.com/o/beta/pull/7',
  ageSeconds: null,
  action: { kind: 'merge', label: 'Merge', prNumber: 7 },
};

describe('GET /api/inbox', () => {
  let GET: typeof import('@/app/api/inbox/route').GET;

  beforeEach(async () => {
    mocks.listInboxSignals.mockReset();
    ({ GET } = await import('@/app/api/inbox/route'));
  });

  it('returns the aggregated signals and counts', async () => {
    const payload = {
      signals: [alphaSignal],
      counts: { red: 1, yellow: 0, green: 0, total: 1 },
    };
    mocks.listInboxSignals.mockResolvedValue(payload);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(payload);
  });

  it('narrows to one project and recomputes counts when ?project= is set', async () => {
    mocks.listInboxSignals.mockResolvedValue({
      signals: [alphaSignal, betaSignal],
      counts: { red: 1, yellow: 1, green: 0, total: 2 },
    });

    const res = await GET(req('http://test/api/inbox?project=beta'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals).toEqual([betaSignal]);
    expect(body.counts).toEqual({ red: 0, yellow: 1, green: 0, total: 1 });
  });

  it('returns an empty feed for a project with no signals', async () => {
    mocks.listInboxSignals.mockResolvedValue({
      signals: [alphaSignal],
      counts: { red: 1, yellow: 0, green: 0, total: 1 },
    });

    const res = await GET(req('http://test/api/inbox?project=nonesuch'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals).toEqual([]);
    expect(body.counts).toEqual({ red: 0, yellow: 0, green: 0, total: 0 });
  });

  it('returns 500 when aggregation throws', async () => {
    mocks.listInboxSignals.mockRejectedValue(new Error('boom'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe('Failed to build inbox feed');
  });
});
