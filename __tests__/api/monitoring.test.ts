import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

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

function makeRequest(url = 'http://localhost/api/monitoring') {
  return new Request(url);
}

async function applyDdl(handle: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries, so issue each DDL separately.
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS notification_throttle (
      key text PRIMARY KEY,
      last_sent_at bigint NOT NULL,
      suppressed_count integer NOT NULL DEFAULT 0
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_status (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
}

describe('GET /api/monitoring', () => {
  let sharedHandle: TestDbHandle;
  let GET: any;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    // The route SWR-caches its snapshot on globalThis (survives resetModules), so
    // reset it between cases — each test asserts a fresh compute against its own
    // fetch-mock sequence and must start from a cold cache.
    (globalThis as Record<string, unknown>).__tamtamMonitoringCache = undefined;
    (globalThis as Record<string, unknown>).__tamtamMonitoringInflight = undefined;
    await sharedHandle.db.execute(sql.raw('TRUNCATE notification_throttle, maintenance_status'));
    vi.doMock('@/lib/db', () => ({
      db: sharedHandle.db,
      schema,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        notification_throttle_window_seconds: 900,
        notification_throttle_overrides: { release_fail: 0, release_aborted: 0 },
        log_retention_count: 200,
        log_retention_days: 30,
        job_row_retention_days: 180,
      }),
    }));
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

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prometheus.status).toBe('unavailable');
    expect(data.loki.status).toBe('unavailable');
    expect(data.hasIssues).toBe(false);
    expect(typeof data.fetchedAt).toBe('number');
    expect(data.notificationThrottle).toEqual({
      windowSeconds: 900,
      overrides: { release_fail: 0, release_aborted: 0 },
      suppressedTotal: 0,
      entries: [],
    });
    expect(data.retention).toEqual({
      policy: {
        logRetentionCount: 200,
        logRetentionDays: 30,
        jobRowRetentionDays: 180,
      },
      lastProjectLogCleanup: null,
      lastNightlyCleanup: null,
    });
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

    const res = await GET(makeRequest());
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

    const res = await GET(makeRequest());
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

    const res = await GET(makeRequest());
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

    const res = await GET(makeRequest());
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

    const res = await GET(makeRequest());
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

    const res = await GET(makeRequest());
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

    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.loki.errors.length).toBeLessThanOrEqual(30);
    expect(data.loki.warnings.length).toBeLessThanOrEqual(20);
  });

  // --- window query parameter ---

  it('defaults to 15m window when no ?window param', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    const res = await GET(makeRequest('http://localhost/api/monitoring'));
    const data = await res.json();
    expect(data.windowMs).toBe(15 * 60 * 1000);
  });

  it('uses 5m window when ?window=5m', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    const res = await GET(makeRequest('http://localhost/api/monitoring?window=5m'));
    const data = await res.json();
    expect(data.windowMs).toBe(5 * 60 * 1000);
  });

  it('uses 1h window when ?window=1h', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    const res = await GET(makeRequest('http://localhost/api/monitoring?window=1h'));
    const data = await res.json();
    expect(data.windowMs).toBe(60 * 60 * 1000);
  });

  it('falls back to 15m window for unknown ?window values', async () => {
    fetchSpy.mockRejectedValue(new Error('connection refused'));
    const res = await GET(makeRequest('http://localhost/api/monitoring?window=99d'));
    const data = await res.json();
    expect(data.windowMs).toBe(15 * 60 * 1000);
  });

  it('includes windowMs in response alongside fetchedAt', async () => {
    fetchSpy
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(prometheusQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]))
      .mockReturnValueOnce(lokiQueryResponse([]));

    const res = await GET(makeRequest('http://localhost/api/monitoring?window=1h'));
    const data = await res.json();
    expect(data.windowMs).toBe(60 * 60 * 1000);
    expect(typeof data.fetchedAt).toBe('number');
  });

  it('includes notification throttle rows ordered by suppressed count', async () => {
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO notification_throttle (key, last_sent_at, suppressed_count) VALUES ('agent_run_fail:p:qa', 1000, 2)`,
    ));
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO notification_throttle (key, last_sent_at, suppressed_count) VALUES ('review_do_not_ship:p:review', 2000, 5)`,
    ));
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO notification_throttle (key, last_sent_at, suppressed_count) VALUES ('release_success:p:release', 3000, 0)`,
    ));
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.notificationThrottle.suppressedTotal).toBe(7);
    expect(data.notificationThrottle.entries.map((entry: { key: string }) => entry.key)).toEqual([
      'review_do_not_ship:p:review',
      'agent_run_fail:p:qa',
    ]);
  });

  it('reports suppressedTotal across all rows while limiting entries to the top 20', async () => {
    for (let i = 1; i <= 25; i += 1) {
      await sharedHandle.db.execute(sql.raw(
        `INSERT INTO notification_throttle (key, last_sent_at, suppressed_count) VALUES ('agent_run_fail:p:agent-${i}', ${i * 1000}, ${i})`,
      ));
    }
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.notificationThrottle.suppressedTotal).toBe(325);
    expect(data.notificationThrottle.entries).toHaveLength(20);
    expect(data.notificationThrottle.entries[0].key).toBe('agent_run_fail:p:agent-25');
    expect(data.notificationThrottle.entries[19].key).toBe('agent_run_fail:p:agent-6');
  });

  it('breaks notification throttle ties by newest lastSentAt first', async () => {
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO notification_throttle (key, last_sent_at, suppressed_count) VALUES ('agent_run_fail:p:older', 1000, 4)`,
    ));
    await sharedHandle.db.execute(sql.raw(
      `INSERT INTO notification_throttle (key, last_sent_at, suppressed_count) VALUES ('agent_run_fail:p:newer', 2000, 4)`,
    ));
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.notificationThrottle.entries.map((entry: { key: string }) => entry.key)).toEqual([
      'agent_run_fail:p:newer',
      'agent_run_fail:p:older',
    ]);
  });

  it('includes separate persisted nightly and project log retention summaries', async () => {
    const nightlySummary = {
      type: 'nightly',
      status: 'completed',
      startedAt: 1700000000,
      finishedAt: 1700000010,
      rowsScanned: 4,
      rowsDeleted: 3,
      skippedRunningRows: 1,
      errorCount: 0,
      lastError: null,
    };
    const projectLogSummary = {
      type: 'project_logs',
      project: 'proj',
      status: 'completed',
      startedAt: 1700000020,
      finishedAt: 1700000030,
      rowsScanned: 4,
      rowsEligible: 2,
      rowsUpdated: 2,
      logFilesDeleted: 2,
      bytesReclaimed: 4096,
      skippedRunningRows: 0,
      errorCount: 0,
      lastError: null,
    };
    await sharedHandle.db.execute(sql`
      INSERT INTO maintenance_status (key, value, updated_at)
      VALUES ('retention:nightly:last', ${JSON.stringify(nightlySummary)}, 1700000010)
    `);
    await sharedHandle.db.execute(sql`
      INSERT INTO maintenance_status (key, value, updated_at)
      VALUES ('retention:project-logs:last', ${JSON.stringify(projectLogSummary)}, 1700000030)
    `);
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.retention.policy).toEqual({
      logRetentionCount: 200,
      logRetentionDays: 30,
      jobRowRetentionDays: 180,
    });
    expect(data.retention.lastNightlyCleanup).toEqual(nightlySummary);
    expect(data.retention.lastProjectLogCleanup).toEqual(projectLogSummary);
    expect(data.hasIssues).toBe(false);
  });

  it('sets hasIssues true when nightly retention cleanup failed', async () => {
    const failedNightly = {
      type: 'nightly',
      status: 'failed',
      startedAt: 1700000000,
      finishedAt: 1700000010,
      rowsScanned: 2,
      rowsDeleted: 0,
      skippedRunningRows: 0,
      errorCount: 1,
      lastError: 'disk full',
    };
    await sharedHandle.db.execute(sql`
      INSERT INTO maintenance_status (key, value, updated_at)
      VALUES ('retention:nightly:last', ${JSON.stringify(failedNightly)}, 1700000010)
    `);
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.retention.lastNightlyCleanup.status).toBe('failed');
    expect(data.hasIssues).toBe(true);
  });

  it('sets hasIssues true when project log retention cleanup failed', async () => {
    const failedProjectLog = {
      type: 'project_logs',
      project: 'proj',
      status: 'failed',
      startedAt: 1700000020,
      finishedAt: 1700000030,
      rowsScanned: 3,
      rowsEligible: 2,
      rowsUpdated: 1,
      logFilesDeleted: 0,
      bytesReclaimed: 0,
      skippedRunningRows: 0,
      errorCount: 1,
      lastError: 'EPERM unlink denied',
    };
    await sharedHandle.db.execute(sql`
      INSERT INTO maintenance_status (key, value, updated_at)
      VALUES ('retention:project-logs:last', ${JSON.stringify(failedProjectLog)}, 1700000030)
    `);
    fetchSpy.mockRejectedValue(new Error('connection refused'));

    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.retention.lastProjectLogCleanup.status).toBe('failed');
    expect(data.hasIssues).toBe(true);
  });

  it('loki queries exclude info/debug/trace log levels', async () => {
    fetchSpy.mockResolvedValue(lokiQueryResponse([]));

    await GET(makeRequest());

    // Collect all URLs fetched (Prometheus + Loki calls).
    const allUrls: string[] = fetchSpy.mock.calls.map((args: any[]) => decodeURIComponent(args[0] as string));
    const lokiUrls = allUrls.filter(u => u.includes('/loki/'));

    expect(lokiUrls.length).toBeGreaterThanOrEqual(2);
    for (const url of lokiUrls) {
      // Both error and warning queries must carry the level exclusion filter.
      expect(url).toContain('level=');
      expect(url).toContain('info');
      expect(url).toContain('debug');
      expect(url).toContain('trace');
    }
  });

  it('loki error query does not return info-level log lines even when they match "error" in text', async () => {
    // An info-level log line that happens to contain the word "error" should be
    // suppressed by the EXCLUDE_LOW_LEVELS filter — verified by checking the
    // query string sent to Loki includes the level exclusion pipe stage.
    fetchSpy.mockResolvedValue(lokiQueryResponse([]));

    await GET(makeRequest());

    const lokiErrorUrl = decodeURIComponent(
      fetchSpy.mock.calls.map((args: any[]) => args[0] as string).find((u: string) => u.includes('/loki/') && u.includes('err')) ?? ''
    );
    expect(lokiErrorUrl).toContain('level=');
    expect(lokiErrorUrl).toContain('!~');
  });
});
