'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface AgentStat {
  name: string
  runs: number
  finishedRuns: number
  successfulRuns: number
  avgDurationMs: number | null
  totalDurationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  costUsd: number
  modifiedFilesCount: number
  reviewFixesTriggered: number
}

export function useAgentStats(projectName: string, intervalMs = 60_000): {
  byName: Map<string, AgentStat>
  loading: boolean
  refresh: () => Promise<void>
} {
  const [byName, setByName] = useState<Map<string, AgentStat>>(new Map())
  const [loading, setLoading] = useState(true)
  const requestTokenRef = useRef(0)

  const fetchOnce = useCallback(async () => {
    const token = ++requestTokenRef.current
    try {
      const res = await fetch(`/api/agents/stats?project=${encodeURIComponent(projectName)}`)
      if (!res.ok) return
      const data = await res.json()
      if (requestTokenRef.current !== token) return
      const map = new Map<string, AgentStat>()
      for (const s of (data.agents ?? []) as AgentStat[]) map.set(s.name, s)
      setByName(map)
    } catch {
      /* ignore — keep prior snapshot */
    } finally {
      if (requestTokenRef.current === token) setLoading(false)
    }
  }, [projectName])

  useEffect(() => {
    setByName(new Map())
    setLoading(true)
    void fetchOnce()
    const id = setInterval(() => { void fetchOnce() }, intervalMs)
    return () => {
      requestTokenRef.current += 1
      clearInterval(id)
    }
  }, [fetchOnce, intervalMs])

  return { byName, loading, refresh: fetchOnce }
}
