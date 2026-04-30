'use client'

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { fetchProjects, setPriority, pauseProject, resumeProject } from '@/lib/client-api'
import type { Task, ProjectsResponse } from '@/lib/shared/types'
import { computeFleetHealth, type FleetHealth } from '@/hooks/useProjectHealth'

interface ProjectsContextType {
  tasks: Task[]
  priorities: string[]
  loading: boolean
  error: string | null
  lastRefresh: number
  fleet: FleetHealth
  issueCounts: Record<string, { prs: number; issues: number }>
  setError: (e: string | null) => void
  loadProjects: () => Promise<void>
  handlePriorityChange: (taskId: string, priority: string) => Promise<void>
  handlePause: (taskId: string) => Promise<void>
  handleResume: (taskId: string) => Promise<void>
  startFastPolling: () => void
}

const ProjectsContext = createContext<ProjectsContextType | null>(null)

export function useProjects() {
  const ctx = useContext(ProjectsContext)
  if (!ctx) throw new Error('useProjects must be used within ProjectsProvider')
  return ctx
}

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ProjectsResponse['tasks']>([])
  const [priorities, setPriorities] = useState<string[]>([])
  const [issueCounts, setIssueCounts] = useState<Record<string, { prs: number; issues: number }>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now())
  const fastPollUntil = useRef<number>(0)
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadProjects = useCallback(async () => {
    try {
      setError(null)
      setLoading(true)
      const data = await fetchProjects()
      setTasks(data.tasks)
      setPriorities(data.priorities)
      setIssueCounts(data.issueCounts ?? {})
      setLastRefresh(Date.now())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load projects'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  const startFastPolling = useCallback(() => {
    fastPollUntil.current = Date.now() + 120_000
  }, [])

  useEffect(() => {
    loadProjects()
    const tick = () => {
      const isFast = Date.now() < fastPollUntil.current
      const delay = isFast ? 10_000 : 30_000
      intervalRef.current = setTimeout(() => {
        loadProjects().then(tick)
      }, delay)
    }
    tick()
    return () => {
      if (intervalRef.current) clearTimeout(intervalRef.current)
    }
  }, [loadProjects])

  const handlePriorityChange = async (taskId: string, priority: string) => {
    try {
      await setPriority(taskId, priority)
      await loadProjects()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update priority')
    }
  }

  const handlePause = async (taskId: string) => {
    try {
      await pauseProject(taskId)
      await loadProjects()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pause')
    }
  }

  const handleResume = async (taskId: string) => {
    try {
      await resumeProject(taskId)
      await loadProjects()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume')
    }
  }

  const fleet = computeFleetHealth(tasks)

  return (
    <ProjectsContext.Provider
      value={{
        tasks, priorities, loading, error, lastRefresh, fleet, issueCounts,
        setError, loadProjects, handlePriorityChange, handlePause, handleResume, startFastPolling,
      }}
    >
      {children}
    </ProjectsContext.Provider>
  )
}
