'use client'

import { useEffect, useState } from 'react'

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

  const fetchOnce = async () => {
    try {
      const res = await fetch(`/api/agents/stats?project=${encodeURIComponent(projectName)}`)
      if (!res.ok) return
      const data = await res.json()
      const map = new Map<string, AgentStat>()
      for (const s of (data.agents ?? []) as AgentStat[]) map.set(s.name, s)
      setByName(map)
    } catch {
      /* ignore — keep prior snapshot */
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchOnce()
    const id = setInterval(() => { if (!cancelled) void fetchOnce() }, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, intervalMs])

  return { byName, loading, refresh: fetchOnce }
}
