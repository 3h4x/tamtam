'use client'

import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react'
import { fetchProjects, setPriority, pauseProject, resumeProject } from '@/lib/client-api'
import type { Task, ProjectsResponse } from '@/lib/shared/types'
import { computeFleetHealth, type FleetHealth } from '@/hooks/useProjectHealth'
import { subscribeToSettingsChanged } from '@/lib/shared/settings-events'

interface ProjectsContextType {
  tasks: Task[]
  priorities: string[]
  loading: boolean
  refreshing: boolean
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
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now())
  const fastPollUntil = useRef<number>(0)
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSeqRef = useRef(0)
  const latestAuthoritativeSeqRef = useRef(0)
  const authoritativeInFlightRef = useRef(0)

  const loadProjects = useCallback(async (mode: 'initial' | 'refresh' | 'poll' = 'refresh') => {
    const isAuthoritative = mode !== 'poll'
    const requestSeq = ++requestSeqRef.current
    if (isAuthoritative) {
      latestAuthoritativeSeqRef.current = requestSeq
      authoritativeInFlightRef.current += 1
    }
    const setPending = mode === 'initial' ? setLoading : setRefreshing
    try {
      setError(null)
      setPending(true)
      // Authoritative loads (initial mount + explicit refresh, incl. the refetch
      // right after a pause/resume/priority mutation) force past the client memo
      // so a just-changed project state is never read back stale. Background
      // polls use the memo, which collapses the mount-time duplicate with each
      // page's own fetchProjects() call.
      const data = await fetchProjects({ force: mode !== 'poll' })
      if (mode === 'poll') {
        const startedBeforeLatestAuthoritative = requestSeq < latestAuthoritativeSeqRef.current
        if (startedBeforeLatestAuthoritative || authoritativeInFlightRef.current > 0) {
          setLastRefresh(Date.now())
          return
        }
      } else if (requestSeq !== latestAuthoritativeSeqRef.current) {
        return
      }
      // Poll-tick blip protection: if a periodic refresh comes back empty
      // (transient cache miss, server warming, etc.) keep the prior list so
      // open project pages don't flash "not found".
      if (mode === 'poll' && data.tasks.length === 0) {
        setLastRefresh(Date.now())
        return
      }
      setTasks(data.tasks)
      setPriorities(data.priorities)
      setIssueCounts(data.issueCounts ?? {})
      setLastRefresh(Date.now())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load projects'
      setError(message)
    } finally {
      if (isAuthoritative) {
        authoritativeInFlightRef.current = Math.max(0, authoritativeInFlightRef.current - 1)
      }
      setPending(false)
    }
  }, [])

  const startFastPolling = useCallback(() => {
    fastPollUntil.current = Date.now() + 120_000
  }, [])

  useEffect(() => {
    loadProjects('initial')
    const tick = () => {
      const isFast = Date.now() < fastPollUntil.current
      const delay = isFast ? 10_000 : 30_000
      intervalRef.current = setTimeout(() => {
        loadProjects('poll').then(tick)
      }, delay)
    }
    tick()
    return () => {
      if (intervalRef.current) clearTimeout(intervalRef.current)
    }
  }, [loadProjects])

  useEffect(() => {
    return subscribeToSettingsChanged(() => {
      void loadProjects('refresh')
    })
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

  // Memoize the fleet-health compute. It walks every task, builds per-project
  // aggregates, and runs status reduction — re-running on every render (e.g.
  // a child component triggers a re-render but `tasks` is unchanged) was
  // wasted CPU. With many projects this can produce visible jank as the
  // provider sits high in the tree.
  const fleet = useMemo(() => computeFleetHealth(tasks), [tasks])

  return (
    <ProjectsContext.Provider
      value={{
        tasks, priorities, loading, refreshing, error, lastRefresh, fleet, issueCounts,
        setError,
        loadProjects,
        handlePriorityChange,
        handlePause,
        handleResume,
        startFastPolling,
      }}
    >
      {children}
    </ProjectsContext.Provider>
  )
}
