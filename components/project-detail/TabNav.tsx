'use client'

import { fetchJobs } from '@/lib/client-api'
import { useRouter } from 'next/navigation'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes' | 'issues' | 'docs' | 'agents' | 'recommendations'

export interface TabNavProps {
  projectName: string
  activeTab: Tab
  totalChanges: number
  issueCount: { prs: number; issues: number } | null
  runningCount?: number
  onSetTab: (tab: Tab) => void
}

export function TabNav({ projectName, activeTab, totalChanges, issueCount, runningCount = 0, onSetTab }: TabNavProps) {
  const router = useRouter()

  const tabClass = (tab: Tab) =>
    `relative shrink-0 px-3 py-1.5 text-sm cursor-pointer transition-colors focus:outline-none focus-visible:text-text-primary ${
      activeTab === tab
        ? 'border-b-2 border-accent text-accent font-medium -mb-px'
        : 'border-b-2 border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/40 -mb-px'
    }`

  const handleTerminalClick = async () => {
    try {
      const data = await fetchJobs(projectName)
      const lastSession = data.jobs
        .filter(j => j.kind === 'run' && j.session_id)
        .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0]
      if (lastSession?.session_id) {
        router.push(buildProjectTerminalPath(projectName, { sessionId: lastSession.session_id }))
        return
      }
    } catch { /* ignore */ }
    onSetTab('terminal')
  }

  return (
    <nav
      className="flex min-w-0 gap-1 overflow-x-auto scrollbar-none border-b border-border mb-3"
      aria-label="Project sections"
    >
      <button className={tabClass('overview')} onClick={() => onSetTab('overview')}>
        Overview
      </button>
      <button className={tabClass('terminal')} onClick={handleTerminalClick}>
        Terminal
      </button>
      <button className={tabClass('changes')} onClick={() => onSetTab('changes')}>
        Changes
        {totalChanges > 0 && (
          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium tabular-nums">
            {totalChanges}
          </span>
        )}
      </button>
      <button className={tabClass('history')} onClick={() => onSetTab('history')}>
        History
        {runningCount > 0 && (
          <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse align-middle" title={`${runningCount} running`} />
        )}
      </button>
      <button className={tabClass('agents')} onClick={() => onSetTab('agents')}>
        Agents
      </button>
      <button className={tabClass('recommendations')} onClick={() => onSetTab('recommendations')}>
        Recommendations
      </button>
      <button className={tabClass('issues')} onClick={() => onSetTab('issues')}>
        <span className="sm:hidden">Issues</span>
        <span className="hidden sm:inline">Issues / PRs</span>
        {issueCount && (issueCount.prs + issueCount.issues) > 0 && (
          <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium tabular-nums">
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
