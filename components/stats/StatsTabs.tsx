'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { StandardTabs } from '@/components/ui/StandardTabs'
import { StatsPage } from '@/components/StatsPage'
import { PipelinePage } from '@/components/PipelinePage'

type StatsTab = 'usage' | 'pipeline'

const EMPTY_SEARCH_PARAMS = new URLSearchParams()

// Unified analytics hub: token/cost usage and release-pipeline health live under
// one nav entry as two tabs (the standalone /pipeline page now redirects here).
export function StatsTabs() {
  const search = useSearchParams() ?? EMPTY_SEARCH_PARAMS
  const [tab, setTab] = useState<StatsTab>(search.get('tab') === 'pipeline' ? 'pipeline' : 'usage')

  const tabs = [
    { id: 'usage' as const, label: 'Usage' },
    { id: 'pipeline' as const, label: 'Pipeline' },
  ]

  return (
    <div className="space-y-5">
      <StandardTabs
        items={tabs}
        activeTab={tab}
        ariaLabel="Statistics sections"
        variant="tabs"
        onChange={setTab}
      />
      {tab === 'usage' && <StatsPage />}
      {tab === 'pipeline' && <PipelinePage />}
    </div>
  )
}
