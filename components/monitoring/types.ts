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

export interface SqliteMaintenanceSummary {
  status: 'completed' | 'skipped' | 'failed'
  startedAt: number
  finishedAt: number
  activeJobs: number
  reason?: string
  checkpointRan: boolean
  vacuumRan: boolean
  error?: string
}

export type RetentionSummary = {
  type: 'project_logs'
  project: string
  status: 'completed' | 'disabled' | 'failed'
  startedAt: number
  finishedAt: number
  rowsScanned: number
  rowsEligible: number
  rowsUpdated: number
  logFilesDeleted: number
  bytesReclaimed: number
  skippedRunningRows: number
  errorCount: number
  lastError: string | null
} | {
  type: 'nightly'
  status: 'completed' | 'disabled' | 'failed'
  startedAt: number
  finishedAt: number
  rowsScanned: number
  rowsDeleted: number
  skippedRunningRows: number
  errorCount: number
  lastError: string | null
  sqliteMaintenance: SqliteMaintenanceSummary
}

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
    lastProjectLogCleanup: Extract<RetentionSummary, { type: 'project_logs' }> | null
    lastNightlyCleanup: Extract<RetentionSummary, { type: 'nightly' }> | null
  }
  hasIssues: boolean
  fetchedAt: number
  windowMs: number
  config: { prometheusUrl: string; lokiUrl: string }
}

export const WINDOW_LABELS: Record<TimeWindow, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hour' }
