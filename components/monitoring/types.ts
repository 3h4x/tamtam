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

export type { SqliteMaintenanceSummary, ProjectLogRetentionSummary, NightlyRetentionSummary, RetentionSummary } from '@/lib/jobs/retention'
import type { ProjectLogRetentionSummary, NightlyRetentionSummary } from '@/lib/jobs/retention'

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
  notificationThrottle: {
    windowSeconds: number
    overrides: Record<string, number>
    suppressedTotal: number
    entries: Array<{ key: string; lastSentAt: number; suppressedCount: number }>
  }
  retention: {
    policy: {
      logRetentionCount: number
      logRetentionDays: number
      jobRowRetentionDays: number
    }
    lastProjectLogCleanup: ProjectLogRetentionSummary | null
    lastNightlyCleanup: NightlyRetentionSummary | null
  }
  hasIssues: boolean
  fetchedAt: number
  windowMs: number
  config: { prometheusUrl: string; lokiUrl: string }
}

export const WINDOW_LABELS: Record<TimeWindow, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hour' }
