'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { StandardTabs } from '@/components/ui/StandardTabs'
import { AttentionFeed } from '@/components/attention/AttentionFeed'
import { InitiativesPage } from '@/components/InitiativesPage'
import { RecommendationHistoryList } from '@/components/recommendations/RecommendationHistoryList'

type InboxTab = 'inbox' | 'initiatives' | 'history'

const EMPTY_SEARCH_PARAMS = new URLSearchParams()

/**
 * The unified Inbox surface. Primary tab is the merged feed (inbox signals +
 * open recommendations, `AttentionFeed`); the mined-backlog and resolved-archive
 * views stay as secondary tabs. `?tab=initiatives` / `?tab=history` deep-link
 * (preserving the links `/recommendations?tab=…` used to serve, now redirected).
 */
export function AttentionTabs() {
  const search = useSearchParams() ?? EMPTY_SEARCH_PARAMS
  const initialTab: InboxTab =
    search.get('tab') === 'initiatives' ? 'initiatives'
    : search.get('tab') === 'history' ? 'history'
    : 'inbox'
  const [tab, setTab] = useState<InboxTab>(initialTab)

  const tabs = [
    { id: 'inbox' as const, label: 'Inbox' },
    { id: 'initiatives' as const, label: 'Initiatives' },
    { id: 'history' as const, label: 'History' },
  ]

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Inbox</h1>
        <p className="text-xs text-text-tertiary mt-1">
          Pending decisions and agent recommendations across every project.
        </p>
      </div>

      <StandardTabs items={tabs} activeTab={tab} ariaLabel="Inbox" variant="tabs" onChange={setTab} />

      {tab === 'inbox' && <AttentionFeed />}
      {tab === 'initiatives' && <InitiativesPage embedded />}
      {tab === 'history' && <RecommendationHistoryList />}
    </div>
  )
}
