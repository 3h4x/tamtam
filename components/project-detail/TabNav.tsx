'use client'

import { fetchJobs } from '@/lib/client-api'
import { useRouter } from 'next/navigation'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'
import { StandardTabs, type StandardTabItem } from '@/components/ui/StandardTabs'

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

  const tabs: StandardTabItem<Tab>[] = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'terminal',
      label: 'Terminal',
      ariaLabel: runningCount > 0 ? `Terminal, ${runningCount} running` : 'Terminal',
      onClick: handleTerminalClick,
      indicator: runningCount > 0 ? (
        <span
          className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse align-middle"
          title={`${runningCount} running`}
          aria-hidden="true"
        />
      ) : null,
    },
    {
      id: 'changes',
      label: 'Changes',
      ariaLabel: totalChanges > 0 ? `Changes, ${totalChanges} pending` : 'Changes',
      badge: totalChanges > 0 ? (
        <span
          className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium tabular-nums"
          aria-hidden="true"
        >
          {totalChanges}
        </span>
      ) : null,
    },
    { id: 'history', label: 'History' },
    { id: 'agents', label: 'Agents' },
    {
      id: 'issues',
      label: 'Issues / PRs',
      mobileLabel: 'Issues',
      ariaLabel: issueBadgeCount > 0 ? `Issues and pull requests, ${issueBadgeCount} open` : 'Issues and pull requests',
      badge: issueBadgeCount > 0 ? (
        <span
          className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium tabular-nums"
          aria-hidden="true"
        >
          {issueBadgeCount}
        </span>
      ) : null,
    },
    { id: 'docs', label: 'Docs' },
    { id: 'config', label: 'Config' },
  ]

  return (
    <StandardTabs
      items={tabs}
      activeTab={activeTab}
      ariaLabel="Project sections"
      className="mb-3"
      onChange={onSetTab}
    />
  )
}
