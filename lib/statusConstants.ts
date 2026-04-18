import { HealthStatus, ProjectHealth } from '@/hooks/useProjectHealth'

export const statusDot: Record<HealthStatus, { color: string; label: string }> = {
  healthy: { color: 'var(--color-status-success)', label: 'healthy' },
  warning: { color: 'var(--color-status-warning)', label: 'warning' },
  error: { color: 'var(--color-status-error)', label: 'error' },
  unknown: { color: 'var(--color-text-tertiary)', label: 'unknown' },
}

export const priorityColor: Record<string, string> = {
  critical: 'var(--color-status-error)',
  high: 'var(--color-status-warning)',
  medium: 'var(--color-accent)',
  low: 'var(--color-text-tertiary)',
}

export function getHighestPriority(project: ProjectHealth): string | null {
  const order = ['critical', 'high', 'medium', 'low']
  for (const level of order) {
    if (project.tasks.some(t => t.task.priority === level)) return level
  }
  return null
}

export function getAggregateCi(project: ProjectHealth): 'success' | 'failure' | 'in_progress' | null {
  const cis = project.tasks.map(t => t.task.ci).filter(Boolean)
  if (cis.length === 0) return null
  if (cis.includes('failure')) return 'failure'
  if (cis.includes('in_progress')) return 'in_progress'
  return 'success'
}

export function getCiFailedUrl(project: ProjectHealth): string | null {
  for (const t of project.tasks) {
    if (t.task.ci_failed_url) return t.task.ci_failed_url
  }
  return null
}

export function getReleaseTag(project: ProjectHealth): string | null {
  for (const t of project.tasks) {
    if (t.task.release_tag) return t.task.release_tag
  }
  return null
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}
