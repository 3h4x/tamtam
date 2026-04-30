'use client'

import { fetchJobs } from '@/lib/client-api'
import { useRouter } from 'next/navigation'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes' | 'issues' | 'docs'

export interface TabNavProps {
  projectName: string
  activeTab: Tab
  totalChanges: number
  issueCount: { prs: number; issues: number } | null
  onSetTab: (tab: Tab) => void
}

export function TabNav({ projectName, activeTab, totalChanges, issueCount, onSetTab }: TabNavProps) {
  const router = useRouter()

  const tabClass = (tab: Tab) =>
    `px-3 py-1.5 text-sm cursor-pointer ${activeTab === tab ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`

  const handleTerminalClick = async () => {
    try {
      const data = await fetchJobs(projectName)
      const lastSession = data.jobs
        .filter(j => j.kind === 'run' && j.session_id)
        .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0]
      if (lastSession?.session_id) {
        router.push(`/project/${projectName}/terminal/${lastSession.session_id}`)
        return
      }
    } catch { /* ignore */ }
    onSetTab('terminal')
  }

  return (
    <nav className="flex gap-1 border-b border-border mb-4">
      <button className={tabClass('overview')} onClick={() => onSetTab('overview')}>
        Overview
      </button>
      <button className={tabClass('terminal')} onClick={handleTerminalClick}>
        Terminal
      </button>
      <button className={tabClass('changes')} onClick={() => onSetTab('changes')}>
        Changes
        {totalChanges > 0 && (
          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium">
            {totalChanges}
          </span>
        )}
      </button>
      <button className={tabClass('history')} onClick={() => onSetTab('history')}>
        History
      </button>
      <button className={tabClass('issues')} onClick={() => onSetTab('issues')}>
        Issues / PRs
        {issueCount && (issueCount.prs + issueCount.issues) > 0 && (
          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium">
            {issueCount.prs + issueCount.issues}
          </span>
        )}
      </button>
      <button className={tabClass('docs')} onClick={() => onSetTab('docs')}>
        Docs
      </button>
      <button className={tabClass('config')} onClick={() => onSetTab('config')}>
        Config
      </button>
    </nav>
  )
}
