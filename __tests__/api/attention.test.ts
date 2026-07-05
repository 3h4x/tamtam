import { describe, it, expect, beforeEach, vi } from 'vitest';

// The route wires two data sources into the pure merge (which has its own unit
// tests in __tests__/lib/attention.test.ts). Mock the two source functions —
// not the DB — to exercise the route's fetch + per-project filter + merge, the
// same pattern the sibling /api/inbox route test uses.
const mocks = vi.hoisted(() => ({
  listInboxSignals: vi.fn(),
  listAllOpenRecommendations: vi.fn(),
}));

vi.mock('@/lib/workflows/inbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workflows/inbox')>();
  return { ...actual, listInboxSignals: (...a: unknown[]) => mocks.listInboxSignals(...a) };
});
vi.mock('@/lib/recommendations/recommendations', () => ({
  listAllOpenRecommendations: (...a: unknown[]) => mocks.listAllOpenRecommendations(...a),
}));

function req(url = 'http://test/api/attention'): Request {
  return new Request(url);
}

const redSignal = {
  id: 'ci_red:alpha', type: 'ci_red', severity: 'red', project: 'alpha',
  title: 'CI failing', detail: null, href: '/project/alpha', externalUrl: null,
  ageSeconds: null, action: { kind: 'fix-ci', label: 'Start fix-ci' },
};

const openRec = {
  id: 'rec1', project: 'beta', source_kind: 'run', source_id: 'j1', agent_id: 'a1', agent_name: 'a',
  type: 'agent_unfruitful', title: 'agent unfruitful', detail: 'no diffs', status: 'open',
  payload: { enabled: true }, created_at: 0, updated_at: 0,
};

describe('GET /api/attention', () => {
  let GET: typeof import('@/app/api/attention/route').GET;

  beforeEach(async () => {
    mocks.listInboxSignals.mockReset();
    mocks.listAllOpenRecommendations.mockReset();
    ({ GET } = await import('@/app/api/attention/route'));
  });

  it('merges signals + recommendations into AttentionItems, red signal above yellow rec', async () => {
    mocks.listInboxSignals.mockResolvedValue({ signals: [redSignal], counts: { red: 1, yellow: 0, green: 0, total: 1 } });
    mocks.listAllOpenRecommendations.mockResolvedValue([openRec]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['signal:ci_red:alpha', 'rec:rec1']);
    expect(body.items[0]).toMatchObject({ source: 'signal', severity: 'red', dismissible: false });
    expect(body.items[1]).toMatchObject({ source: 'recommendation', severity: 'yellow', dismissible: true, agent: { id: 'a1', name: 'a' } });
    expect(body.counts).toEqual({ red: 1, yellow: 1, green: 0, total: 2 });
  });

  it('narrows both sources when ?project= is set', async () => {
    mocks.listInboxSignals.mockResolvedValue({ signals: [redSignal], counts: { red: 1, yellow: 0, green: 0, total: 1 } });
    mocks.listAllOpenRecommendations.mockResolvedValue([openRec]);

    const res = await GET(req('http://test/api/attention?project=beta'));
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['rec:rec1']);
    expect(body.counts).toEqual({ red: 0, yellow: 1, green: 0, total: 1 });
  });

  it('returns 500 when a source throws', async () => {
    mocks.listInboxSignals.mockRejectedValue(new Error('boom'));
    mocks.listAllOpenRecommendations.mockResolvedValue([]);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toBe('Failed to build attention feed');
  });
});
