'use client'

import { fetchJobs } from '@/lib/client-api'
import { useRouter } from 'next/navigation'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes' | 'issues' | 'docs' | 'agents'

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
  const issueBadgeCount = issueCount ? issueCount.prs + issueCount.issues : 0

  const tabClass = (tab: Tab) =>
    `relative shrink-0 px-3 py-1.5 text-sm cursor-pointer transition-colors focus:outline-none focus-visible:text-text-primary ${
      activeTab === tab
        ? 'border-b-2 border-accent text-accent font-medium -mb-px'
        : 'border-b-2 border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/40 -mb-px'
    }`

  const handleTerminalClick = async () => {
    try {
      // Filter at the API level: we want the single most recent `run`-kind
      // job that has a session_id. Previously this pulled the whole project
      // jobs list and filtered client-side — costly on large histories.
      const data = await fetchJobs(projectName, { kind: 'run', limit: 5 })
      const lastSession = data.jobs.find(j => j.session_id)
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
      <button
        className={tabClass('changes')}
        onClick={() => onSetTab('changes')}
        aria-label={totalChanges > 0 ? `Changes, ${totalChanges} pending` : 'Changes'}
      >
        Changes
        {totalChanges > 0 && (
          <span
            className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium tabular-nums"
            aria-hidden="true"
          >
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
      <button
        className={tabClass('issues')}
        onClick={() => onSetTab('issues')}
        aria-label={issueBadgeCount > 0 ? `Issues and pull requests, ${issueBadgeCount} open` : 'Issues and pull requests'}
      >
        <span className="sm:hidden">Issues</span>
        <span className="hidden sm:inline">Issues / PRs</span>
        {issueBadgeCount > 0 && (
          <span
            className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium tabular-nums"
            aria-hidden="true"
          >
            {issueBadgeCount}
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
