'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface SchedulerEntry {
  agentId: string
  project: string
  name: string
  schedule: string
  enabled: boolean
  nextFireMs: number
  lastFireMs: number | null
  fireCount: number
  errorCount: number
  lastError: string | null
  skippedCount: number
  lastSkippedReason: string | null
  lastJobMs: number | null
}

interface SchedulerHealthResponse {
  internal?: {
    entries?: SchedulerEntry[]
  }
}

export function useSchedulerHealth(projectName: string, intervalMs = 30_000): {
  entries: SchedulerEntry[]
  loading: boolean
  refresh: () => Promise<void>
} {
  const [entries, setEntries] = useState<SchedulerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const requestTokenRef = useRef(0)

  const fetchOnce = useCallback(async () => {
    const token = ++requestTokenRef.current
    try {
      const res = await fetch('/api/agents/scheduler-health')
      if (!res.ok) return
      const data: SchedulerHealthResponse = await res.json()
      const all = data.internal?.entries ?? []
      if (requestTokenRef.current !== token) return
      setEntries(all.filter(e => e.project === projectName))
    } catch {
      /* keep previous state on network errors */
    } finally {
      if (requestTokenRef.current === token) setLoading(false)
    }
  }, [projectName])

  useEffect(() => {
    setLoading(true)
    setEntries([])
    void fetchOnce()
    const id = setInterval(() => { void fetchOnce() }, intervalMs)
    return () => {
      requestTokenRef.current += 1
      clearInterval(id)
    }
  }, [fetchOnce, intervalMs])

  return { entries, loading, refresh: fetchOnce }
}
