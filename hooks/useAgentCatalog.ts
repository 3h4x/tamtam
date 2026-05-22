'use client'

import { useEffect, useState } from 'react'

export interface AgentCatalogClientEntry {
  name: string
  aliases: string[]
  description: string
  dispatch: 'cli' | 'internal'
  defaultSchedule: string
  defaultModel: string
  prompt: string
  skillIds: string[]
  autoSeed: boolean
  tier: 'essential' | 'featured' | 'recommended' | null
  fallbackEnabled: boolean
}

// The catalog is static (lives in `lib/agents/catalog.ts`), so one fetch
// per session is enough. No polling, no revalidation — when the user
// adds entries via a code change, the page reloads anyway.
let cachedEntries: AgentCatalogClientEntry[] | null = null

export function useAgentCatalog(): { entries: AgentCatalogClientEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<AgentCatalogClientEntry[]>(cachedEntries ?? [])
  const [loading, setLoading] = useState(cachedEntries === null)

  useEffect(() => {
    if (cachedEntries) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/agent-catalog')
        if (!res.ok) {
          if (!cancelled) setLoading(false)
          return
        }
        const data = (await res.json()) as { entries: AgentCatalogClientEntry[] }
        cachedEntries = data.entries
        if (!cancelled) {
          setEntries(data.entries)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  return { entries, loading }
}
