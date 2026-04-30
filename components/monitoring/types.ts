export interface PrometheusResult {
  metric: Record<string, string>
  value: [number, string]
}

export interface LogLine {
  ts: string
  stream: Record<string, string>
  line: string
}

export type TimeWindow = '5m' | '15m' | '1h'
export type MonitoringTab = 'overview' | 'agents' | 'logs' | 'infra'

export interface MonitoringData {
  prometheus: {
    status: 'ok' | 'unavailable'
    alerts: PrometheusResult[]
    services: PrometheusResult[]
  }
  loki: {
    status: 'ok' | 'unavailable'
    errors: LogLine[]
    warnings: LogLine[]
  }
  hasIssues: boolean
  fetchedAt: number
  windowMs: number
  config: { prometheusUrl: string; lokiUrl: string }
}

export const WINDOW_LABELS: Record<TimeWindow, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hour' }
