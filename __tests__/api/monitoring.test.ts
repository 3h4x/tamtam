import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeJsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

function prometheusQueryResponse(results: unknown[]) {
  return makeJsonResponse({ data: { result: results } });
}

function lokiQueryResponse(streams: Array<{ stream: Record<string, string>; values: [string, string][] }>) {
  return makeJsonResponse({ data: { result: streams } });
}

describe('GET /api/monitoring', () => {
  let GET: any;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const mod = await import('@/app/api/monitoring/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns unavailable for both when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prometheus.status).toBe('unavailable');
    expect(data.loki.status).toBe('unavailable');
    expect(data.hasIssues).toBe(false);
    expect(typeof data.fetchedAt).toBe('number');
  });

  it('returns ok with no issues when all services up and no alerts', async () => {
    const upService = { metric: { job: 'api', instance: 'localhost:8080' }, value: [1700000000, '1'] };
    fetchSpy
      // Prometheus alerts query
      .mockReturnValueOnce(prometheusQueryResponse([]))
      // Prometheus services query
      .mockReturnValueOnce(prometheusQueryResponse([upService]))
      // Loki errors query
      .mockReturnValueOnce(lokiQueryResponse([]))
      // Loki warnings query
      .mockReturnValueOnce(lokiQueryResponse([]));

    const res = await GET();
    const data = await res.json();
    expect(data.prometheus.status).toBe('ok');
    expect(data.loki.status).toBe('ok');
    expect(data.prometheus.alerts).toHaveLength(0);
    expect(data.prometheus.services).toHaveLength(1);
    expect(data.hasIssues).toBe(false);
  });

  it('sets hasIssues true when there are firing alerts', async () => {
    const alert = { metric: { alertname: 'HighMemory', severity: 'warning', alertstate: 'firing' }, value: [1700000000, '1'] };
    fetchSpy
      .mockReturnValueOnce(prometheusQueryResponse([alert]))
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]));

    const res = await GET();
    const data = await res.json();
    expect(data.prometheus.alerts).toHaveLength(1);
    expect(data.prometheus.alerts[0].metric.alertname).toBe('HighMemory');
    expect(data.hasIssues).toBe(true);
  });

  it('sets hasIssues true when a service is down', async () => {
    const downService = { metric: { job: 'db', instance: 'localhost:5432' }, value: [1700000000, '0'] };
    fetchSpy
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(prometheusQueryResponse([downService]))
      .mockReturnValueOnce(lokiQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]));

    const res = await GET();
    const data = await res.json();
    expect(data.hasIssues).toBe(true);
  });

  it('sets hasIssues true when loki returns errors', async () => {
    const nowNs = String(Date.now() * 1_000_000);
    const stream: { stream: Record<string, string>; values: [string, string][] } = { stream: { job: 'api' }, values: [[nowNs, 'FATAL error occurred']] };
    fetchSpy
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([stream]))
      .mockReturnValueOnce(lokiQueryResponse([]));

    const res = await GET();
    const data = await res.json();
    expect(data.loki.errors).toHaveLength(1);
    expect(data.loki.errors[0].line).toBe('FATAL error occurred');
    expect(data.hasIssues).toBe(true);
  });

  it('loki warnings do not trigger hasIssues', async () => {
    const nowNs = String(Date.now() * 1_000_000);
    const warnStream: { stream: Record<string, string>; values: [string, string][] } = { stream: { job: 'worker' }, values: [[nowNs, 'warn: slow query']] };
    fetchSpy
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([warnStream]));

    const res = await GET();
    const data = await res.json();
    expect(data.loki.warnings).toHaveLength(1);
    expect(data.hasIssues).toBe(false);
  });

  it('prometheus unavailable but loki ok — hasIssues false when no errors', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('prom down'))
      .mockRejectedValueOnce(new Error('prom down'))
      .mockReturnValueOnce(lokiQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]));

    const res = await GET();
    const data = await res.json();
    expect(data.prometheus.status).toBe('unavailable');
    expect(data.loki.status).toBe('ok');
    expect(data.hasIssues).toBe(false);
  });

  it('caps loki errors at 30 and warnings at 20', async () => {
    const nowNs = String(Date.now() * 1_000_000);
    const manyErrors: [string, string][] = Array.from({ length: 50 }, (_, i) => [nowNs, `error ${i}`]);
    const manyWarns: [string, string][] = Array.from({ length: 40 }, (_, i) => [nowNs, `warn ${i}`]);
    fetchSpy
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([{ stream: { job: 'svc' }, values: manyErrors }]))
      .mockReturnValueOnce(lokiQueryResponse([{ stream: { job: 'svc' }, values: manyWarns }]));

    const res = await GET();
    const data = await res.json();
    expect(data.loki.errors.length).toBeLessThanOrEqual(30);
    expect(data.loki.warnings.length).toBeLessThanOrEqual(20);
  });
});
