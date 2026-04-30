'use client'

import Link from 'next/link'
import { useProjects } from '@/components/ProjectsProvider'
import { ProjectTablePage } from '@/components/ProjectTablePage'
import { LoadingState } from '@/components/LoadingState'

export default function Home() {
  const { tasks, loading, fleet, issueCounts } = useProjects()

  if (loading && tasks.length === 0) return <LoadingState />
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 gap-3 text-center">
        <svg className="w-10 h-10 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
        <p className="text-sm text-text-secondary">No projects discovered.</p>
        <p className="text-xs text-text-tertiary max-w-md">
          TamTam scans your workspace directory for git repositories. Configure the workspace path in Settings, then enable the projects you want to track.
        </p>
        <Link
          href="/settings"
          className="mt-2 px-3 py-1.5 text-xs border border-border rounded-md text-text-primary hover:bg-bg-tertiary transition-colors"
        >
          Open Settings
        </Link>
      </div>
    )
  }

  return (
    <ProjectTablePage
      fleet={fleet}
      issueCounts={issueCounts}
    />
  )
}
