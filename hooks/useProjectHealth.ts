import { Task } from '@/lib/types'

export type HealthStatus = 'error' | 'warning' | 'healthy' | 'unknown'

export interface TaskHealth {
  task: Task
  status: HealthStatus
  summary: string
}

export interface ProjectHealth {
  project: string
  status: HealthStatus
  tasks: TaskHealth[]
  totalChanges: number
  unpushed: number
  unreviewedCount: number
  lastRunAgo: string | null
}

export interface FleetHealth {
  projects: ProjectHealth[]
  errorCount: number
  warningCount: number
  healthyCount: number
  unknownCount: number
  totalTasks: number
  totalChanges: number
  totalUnreviewed: number
}

function parseAgoToHours(ago: string | null): number | null {
  if (!ago) return null
  const match = ago.match(/^(\d+)([mhd])$/)
  if (!match) {
    if (ago === '<1m') return 0
    return null
  }
  const value = parseInt(match[1], 10)
  const unit = match[2]
  if (unit === 'm') return value / 60
  if (unit === 'h') return value
  if (unit === 'd') return value * 24
  return null
}

function getTaskHealth(task: Task): TaskHealth {
  let status: HealthStatus = 'healthy'
  const parts: string[] = []

  // Error conditions
  if (task.last_run_exit !== null && task.last_run_exit > 0) {
    status = 'error'
    parts.push(`exit ${task.last_run_exit}`)
  }
  if (task.ci === 'failure') {
    status = 'error'
    parts.push('CI failed')
  }
  if (task.launchctl === 'missing') {
    status = 'error'
    parts.push('missing')
  }

  // Warning conditions (only if not already error)
  if (status !== 'error') {
    if (task.launchctl === 'paused') {
      status = 'warning'
      parts.push('paused')
    }
    if (task.sync === false) {
      status = 'warning'
      parts.push('out of sync')
    }
    if (task.changes > 0 && !task.reviewed) {
      status = 'warning'
      parts.push(`${task.changes} unreviewed`)
    }
    const hours = parseAgoToHours(task.last_run_ago)
    if (hours !== null && hours > 24 && (task.priority === 'critical' || task.priority === 'high')) {
      status = 'warning'
      parts.push('stale')
    }
  }

  // Unknown if no run data at all
  if (status === 'healthy' && task.last_run === null && task.ci === null) {
    status = 'unknown'
    parts.push('no data')
  }

  // Build summary
  if (parts.length === 0) {
    if (task.last_run_ago) {
      parts.push(`${task.last_run_ago} ago`)
    }
    if (task.launchctl) {
      parts.push(task.launchctl)
    }
  }

  return {
    task,
    status,
    summary: `${task.job || task.project}: ${parts.join(', ')}`,
  }
}

const healthOrder: Record<HealthStatus, number> = {
  error: 0,
  warning: 1,
  unknown: 2,
  healthy: 3,
}

export function computeFleetHealth(tasks: Task[]): FleetHealth {
  // Group by project
  const groups: Record<string, Task[]> = {}
  for (const task of tasks) {
    if (!groups[task.project]) groups[task.project] = []
    groups[task.project].push(task)
  }

  const projects: ProjectHealth[] = Object.entries(groups).map(([project, projectTasks]) => {
    const taskHealths = projectTasks.map(getTaskHealth)
    const worstStatus = taskHealths.reduce<HealthStatus>(
      (worst, th) => (healthOrder[th.status] < healthOrder[worst] ? th.status : worst),
      'healthy'
    )

    const totalChanges = projectTasks.length > 0 ? projectTasks[0].changes : 0
    const unpushed = projectTasks.length > 0 ? (projectTasks[0].unpushed || 0) : 0
    const unreviewedCount = projectTasks.some(t => t.changes > 0 && !t.reviewed) ? 1 : 0

    // Most recent last_run_ago
    let lastRunAgo: string | null = null
    let minHours = Infinity
    for (const t of projectTasks) {
      const h = parseAgoToHours(t.last_run_ago)
      if (h !== null && h < minHours) {
        minHours = h
        lastRunAgo = t.last_run_ago
      }
    }

    return {
      project,
      status: worstStatus,
      tasks: taskHealths,
      totalChanges,
      unpushed,
      unreviewedCount,
      lastRunAgo,
    }
  })

  // Sort: errors first, then warnings, then healthy, then alphabetical
  projects.sort((a, b) => {
    const diff = healthOrder[a.status] - healthOrder[b.status]
    if (diff !== 0) return diff
    return a.project.localeCompare(b.project)
  })

  return {
    projects,
    errorCount: projects.filter(p => p.status === 'error').length,
    warningCount: projects.filter(p => p.status === 'warning').length,
    healthyCount: projects.filter(p => p.status === 'healthy').length,
    unknownCount: projects.filter(p => p.status === 'unknown').length,
    totalTasks: tasks.length,
    totalChanges: projects.reduce((sum, p) => sum + p.totalChanges, 0),
    totalUnreviewed: projects.reduce((sum, p) => sum + p.unreviewedCount, 0),
  }
}
