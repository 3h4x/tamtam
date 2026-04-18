import { NextResponse } from 'next/server'

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://localhost:9090'
const LOKI_URL = process.env.LOKI_URL ?? 'http://localhost:3100'

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
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    clearTimeout(id)
    return res
  } catch (e) {
    clearTimeout(id)
    throw e
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

export async function GET() {
  const now = Date.now()
  const start15mNs = String((now - 15 * 60 * 1000) * 1_000_000)

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

  await Promise.allSettled([
    (async () => {
      const [alerts, services] = await Promise.all([
        queryPrometheus('ALERTS{alertstate="firing"}'),
        queryPrometheus('up'),
      ])
      prometheus = { status: 'ok', alerts, services }
    })(),
    (async () => {
      const [errors, warnings] = await Promise.all([
        queryLoki('{job!=""} |~ "(?i)\\\\b(err|error|fatal|panic)\\\\b" !~ "(?i)\\\\b(no|zero)\\\\s+(err|error|errors|fatal|panic)\\\\b"', start15mNs, 30),
        queryLoki('{job!=""} |~ "(?i)\\\\b(warn|warning)\\\\b" !~ "(?i)\\\\b(no|zero)\\\\s+(warn|warning|warnings)\\\\b"', start15mNs, 20),
      ])
      loki = { status: 'ok', errors: errors.slice(0, 30), warnings: warnings.slice(0, 20) }
    })(),
  ])

  const downServices = prometheus.services.filter(s => s.value?.[1] === '0')
  const hasIssues =
    (prometheus.status === 'ok' && (prometheus.alerts.length > 0 || downServices.length > 0)) ||
    (loki.status === 'ok' && loki.errors.length > 0)

  return NextResponse.json({ prometheus, loki, hasIssues, fetchedAt: now, config: { prometheusUrl: PROMETHEUS_URL, lokiUrl: LOKI_URL } })
}
