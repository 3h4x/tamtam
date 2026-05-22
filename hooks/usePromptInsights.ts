'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export interface PromptInsights {
  windowDays: number
  agentJobCount: number
  promptBytes: { avg: number; p50: number; p95: number; max: number } | null
  retrieval: {
    sampled: number
    queried: number
    attached: number
    queriedRate: number
    attachRate: number
    avgTopScore: number | null
    avgAcceptedChunks: number | null
    reasons: Record<string, number>
  }
  memory: {
    sampled: number
    truncatedCount: number
    truncationRate: number
    avgRawChars: number | null
    maxRawChars: number
  }
  prereq: { withPrereq: number; withoutPrereq: number }
}

export function usePromptInsights(
  projectName: string,
  days = 7,
  intervalMs = 60_000,
): { data: PromptInsights | null; loading: boolean; refresh: () => Promise<void> } {
  const [data, setData] = useState<PromptInsights | null>(null)
  const [loading, setLoading] = useState(true)
  const requestTokenRef = useRef(0)

  const fetchOnce = useCallback(async () => {
    const token = ++requestTokenRef.current
    try {
      const url = `/api/projects/by-project/${encodeURIComponent(projectName)}/prompt-insights?days=${days}`
      const res = await fetch(url)
      if (!res.ok) {
        if (token === requestTokenRef.current) setLoading(false)
        return
      }
      const json = (await res.json()) as PromptInsights
      if (token === requestTokenRef.current) {
        setData(json)
        setLoading(false)
      }
    } catch {
      if (token === requestTokenRef.current) setLoading(false)
    }
  }, [projectName, days])

  useEffect(() => {
    void fetchOnce()
    const id = setInterval(() => { void fetchOnce() }, intervalMs)
    return () => clearInterval(id)
  }, [fetchOnce, intervalMs])

  return { data, loading, refresh: fetchOnce }
}
