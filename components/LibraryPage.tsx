'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { SkillsPage } from '@/components/SkillsPage'
import { AgentCatalogList } from '@/components/library/AgentCatalogList'
import { StandardTabs } from '@/components/ui/StandardTabs'

type Tab = 'agents' | 'skills'

const TABS: { id: Tab; label: string; description: string }[] = [
  {
    id: 'agents',
    label: 'Agents',
    description: 'Built-in agent templates. Internal agents auto-seed per project; CLI agents materialize when installed.',
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Reusable prompt blocks composed into agents. DB-backed custom skills + file-based personas.',
  },
]

export function LibraryPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  // Honor `?tab=skills` (from the legacy `/skills` redirect and from
  // direct deep links). Default to the agents tab — the catalog is the
  // headline content of the Library page.
  const initial: Tab = searchParams?.get('tab') === 'skills' ? 'skills' : 'agents'
  const [tab, setTab] = useState<Tab>(initial)

  // Keep the URL in sync without pushing history entries so the back
  // button still jumps out of /library rather than cycling through tabs.
  useEffect(() => {
    const current = searchParams?.get('tab')
    const desired = tab === 'skills' ? 'skills' : null
    if ((desired ?? '') === (current ?? '')) return
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    if (desired === null) params.delete('tab')
    else params.set('tab', desired)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [tab, pathname, router, searchParams])

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  return (
    <div className="flex flex-col gap-4 pb-24">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-primary">Library</h1>
        <p className="text-sm text-text-tertiary">{active.description}</p>
      </header>

      <StandardTabs
        items={TABS}
        activeTab={tab}
        ariaLabel="Library section"
        onChange={setTab}
      />

      <div>
        {tab === 'agents' ? <AgentCatalogList /> : <SkillsPage />}
      </div>
    </div>
  )
}
