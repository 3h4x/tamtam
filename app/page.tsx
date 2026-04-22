'use client'

import { useProjects } from '@/components/ProjectsProvider'
import { ProjectTablePage } from '@/components/ProjectTablePage'
import { LoadingState } from '@/components/LoadingState'

export default function Home() {
  const { tasks, loading, fleet, loadProjects, issueCounts } = useProjects()

  if (loading && tasks.length === 0) return <LoadingState />
  if (tasks.length === 0) {
    return (
      <div style={{ padding: 'var(--space-6)', color: 'var(--text-secondary)' }}>
        No projects found
      </div>
    )
  }

  return (
    <ProjectTablePage
      fleet={fleet}
      onRefresh={loadProjects}
      issueCounts={issueCounts}
    />
  )
}
