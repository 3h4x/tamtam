import { NextResponse } from 'next/server'
import { db, schema } from '@/lib/db'
import { getSettings } from '@/lib/shared/config'
import { swrGet, type SwrStore } from '@/lib/shared/swr-cache'
import {
  getLatestNightlyRetentionSummary,
  getLatestProjectLogRetentionSummary,
} from '@/lib/jobs/retention'

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://localhost:9090'
const LOKI_URL = process.env.LOKI_URL ?? 'http://localhost:3100'
const EXCLUDE_LOW_LEVELS = '!~ "(?i)(\\\\blevel=(info|debug|trace)\\\\b|\\"level\\"\\\\s*:\\\\s*\\"(info|debug|trace)\\"|(^|\\\\s)\\\\[(info|debug|trace)\\\\])"'

interface LogLine {
  ts: string
  stream: Record<string, string>
  line: string
}

interface PrometheusResult {
  metric: Record<string, string>
  value: [number, string]
}

async function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  id.unref?.()
  try {
    return await fetch(url, { signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(id)
  }
}

async function queryPrometheus(expr: string): Promise<PrometheusResult[]> {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`
  const res = await fetchWithTimeout(url)
  const data = await res.json()
  return data?.data?.result ?? []
}

async function queryLoki(query: string, startNs: string, limit = 30): Promise<LogLine[]> {
  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startNs}&limit=${limit}&direction=backward`
  const res = await fetchWithTimeout(url)
  const data = await res.json()
  const results: Array<{ stream: Record<string, string>; values: [string, string][] }> = data?.data?.result ?? []
  const lines: LogLine[] = []
  for (const stream of results) {
    for (const [ts, line] of (stream.values ?? [])) {
      lines.push({ ts, stream: stream.stream ?? {}, line })
    }
  }
  return lines.sort((a, b) => b.ts.localeCompare(a.ts))
}

async function computeMonitoringSnapshot(windowMs: number) {
  const now = Date.now()
  const start15mNs = String((now - windowMs) * 1_000_000)

  let prometheus: {
    status: 'ok' | 'unavailable'
    alerts: PrometheusResult[]
    services: PrometheusResult[]
  } = { status: 'unavailable', alerts: [], services: [] }

  let loki: {
    status: 'ok' | 'unavailable'
    errors: LogLine[]
    warnings: LogLine[]
  } = { status: 'unavailable', errors: [], warnings: [] }

  type ThrottleRow = typeof schema.notificationThrottle.$inferSelect;
  type ProjLogSummary = Awaited<ReturnType<typeof getLatestProjectLogRetentionSummary>>;
  type NightlySummary = Awaited<ReturnType<typeof getLatestNightlyRetentionSummary>>;
  let throttledNotifications: ThrottleRow[] = [];
  // Explicit null-cast on init so TS's flow analysis doesn't narrow these
  // to the `null` literal type — the closure assignments below happen
  // outside the synchronous scope TS tracks, so without the cast the
  // post-await reads on `?.status` would error with "Property does not
  // exist on type 'never'".
  let lastProjectLogCleanup: ProjLogSummary = null as ProjLogSummary;
  let lastNightlyCleanup: NightlySummary = null as NightlySummary;

  // Run all four independent fan-outs (prometheus, loki, throttled-notifications
  // DB query, retention summaries) in a single Promise.allSettled. Keeping
  // them in the same fan-out keeps the route's wall time to the slowest
  // dependency instead of adding independent dependency latencies together
  // (`max(...all four...)`). Closure-captured state matches the existing pattern.
  await Promise.allSettled([
    (async () => {
      const [alerts, services] = await Promise.all([
        queryPrometheus('ALERTS{alertstate="firing"}'),
        queryPrometheus('up'),
      ])
      prometheus = { status: 'ok', alerts, services }
    })(),
    (async () => {
      // Exclude info/debug/trace across the three common log formats:
      //   logfmt:  level=info
      //   JSON:    "level":"info" or "level": "info"
      //   bracket: [INFO] [DEBUG]
      const [errors, warnings] = await Promise.all([
        queryLoki(`{job!=""} |~ "(?i)\\\\b(err|error|fatal|panic)\\\\b" !~ "(?i)\\\\b(no|zero)\\\\s+(err|error|errors|fatal|panic)\\\\b" ${EXCLUDE_LOW_LEVELS}`, start15mNs, 30),
        queryLoki(`{job!=""} |~ "(?i)\\\\b(warn|warning)\\\\b" !~ "(?i)\\\\b(no|zero)\\\\s+(warn|warning|warnings)\\\\b" ${EXCLUDE_LOW_LEVELS}`, start15mNs, 20),
      ])
      loki = { status: 'ok', errors: errors.slice(0, 30), warnings: warnings.slice(0, 20) }
    })(),
    (async () => {
      throttledNotifications = await db.select().from(schema.notificationThrottle);
    })(),
    (async () => {
      [lastProjectLogCleanup, lastNightlyCleanup] = await Promise.all([
        getLatestProjectLogRetentionSummary(),
        getLatestNightlyRetentionSummary(),
      ]);
    })(),
  ])

  const downServices = prometheus.services.filter(s => s.value?.[1] === '0')
  const settings = getSettings()
  const suppressedTotal = throttledNotifications.reduce((sum, row) => sum + row.suppressedCount, 0)
  const topThrottledNotifications = throttledNotifications
    .filter((row) => row.suppressedCount > 0)
    .sort((a, b) => b.suppressedCount - a.suppressedCount || b.lastSentAt - a.lastSentAt)
    .slice(0, 20)
  const notificationThrottle = {
    windowSeconds: settings.notification_throttle_window_seconds,
    overrides: settings.notification_throttle_overrides,
    suppressedTotal,
    entries: topThrottledNotifications,
  }
  const retention = {
    policy: {
      logRetentionCount: settings.log_retention_count,
      logRetentionDays: settings.log_retention_days,
      jobRowRetentionDays: settings.job_row_retention_days,
    },
    lastProjectLogCleanup,
    lastNightlyCleanup,
  }
  const retentionHasIssues =
    lastNightlyCleanup?.status === 'failed' ||
    lastProjectLogCleanup?.status === 'failed'
  const hasIssues =
    (prometheus.status === 'ok' && (prometheus.alerts.length > 0 || downServices.length > 0)) ||
    (loki.status === 'ok' && loki.errors.length > 0) ||
    !!retentionHasIssues

  return { prometheus, loki, notificationThrottle, retention, hasIssues, fetchedAt: now, windowMs, config: { prometheusUrl: PROMETHEUS_URL, lokiUrl: LOKI_URL } }
}

// SWR cache for the monitoring snapshot. Every /api/monitoring call fans out 2
// Prometheus + 2 Loki queries over the goro autossh tunnel — ~300 ms of network
// round-trips on EVERY call regardless of host load (the route is already fully
// parallel, so caching is the only remaining lever). The /monitoring page polls
// this every 30 s and is labelled "auto-refresh 30 s", so a few seconds of extra
// staleness is invisible there, and real alerting is push-based (outbound
// webhooks) not this dashboard — serving the snapshot stale-while-revalidate is
// safe and collapses repeated polls / multiple tabs to one background refresh.
// Keyed by window so 5m/15m/1h don't clobber each other. Pinned to globalThis
// because Next.js duplicates route modules across bundle realms.
type MonitoringSnapshot = Awaited<ReturnType<typeof computeMonitoringSnapshot>>
declare global {
  var __tamtamMonitoringCache: Map<string, { value: MonitoringSnapshot; time: number }> | undefined
  var __tamtamMonitoringInflight: Map<string, Promise<MonitoringSnapshot>> | undefined
}
const MONITORING_TTL_MS = 15_000

export async function GET(request: Request) {
  const windowMs = (() => {
    switch (new URL(request.url).searchParams.get('window')) {
      case '5m': return 5 * 60 * 1000
      case '1h': return 60 * 60 * 1000
      default: return 15 * 60 * 1000
    }
  })()
  const store: SwrStore<MonitoringSnapshot> = {
    cache: (globalThis.__tamtamMonitoringCache ??= new Map()),
    inflight: (globalThis.__tamtamMonitoringInflight ??= new Map()),
  }
  const snapshot = await swrGet(store, String(windowMs), MONITORING_TTL_MS, () => computeMonitoringSnapshot(windowMs))
  return NextResponse.json(snapshot)
}
