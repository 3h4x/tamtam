export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface Task {
  id: string
  project: string
  job: string | null
  priority: 'critical' | 'high' | 'medium' | 'low' | null
  launchctl: 'running' | 'loaded' | 'installed' | 'paused' | 'missing'
  path: string
  fires_at: string
  sync: boolean | null
  changes: number
  unpushed: number
  reviewed: boolean | null
  last_run: string | null
  last_run_ago: string | null
  last_run_duration_s: number | null
  last_run_exit: number | null
  release_tag: string | null
  ci: 'success' | 'failure' | 'in_progress' | null
  ci_failed_url: string | null
  github: string | null
}

export interface ProjectsResponse {
  tasks: Task[]
  priorities: string[]
}
