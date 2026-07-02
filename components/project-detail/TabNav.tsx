'use client'

import { fetchJobs } from '@/lib/client-api'
import { useRouter } from 'next/navigation'
import { buildProjectTerminalPath } from '@/lib/client/project-routes'
import { Pill } from '@/components/ui/Pill'
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
      // Filter at the API level for the newest `run` job with a session_id.
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
        <Pill
          tone="accent"
          size="xs"
          className="ml-1.5 rounded-full border-transparent bg-accent-light px-1.5 py-0.5 text-[10px] text-accent tabular-nums"
          aria-hidden="true"
        >
          {totalChanges}
        </Pill>
      ) : null,
    },
    { id: 'history', label: 'History' },
    { id: 'agents', label: 'Agents' },
    {
      id: 'issues',
      label: 'Issues / PRs',
      mobileLabel: 'Issues',
      ariaLabel: issueBadgeCount > 0 ? `Issues and pull requests, ${issueBadgeCount} open` : 'Issues and pull requests',
      // Neutral count, not accent: the issue/PR backlog is passive reference,
      // unlike Changes (accent) which flags pending work to act on.
      badge: issueBadgeCount > 0 ? (
        <Pill
          tone="neutral"
          size="xs"
          className="ml-1.5 rounded-full border-transparent bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary tabular-nums"
          aria-hidden="true"
        >
          {issueBadgeCount}
        </Pill>
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
