'use client'

import { useProjects } from '@/components/ProjectsProvider'
import { ProjectDetailPage } from '@/components/ProjectDetailPage'
import { ProjectPageLoadingState } from '@/components/project-detail/ProjectPageLoadingState'

export function ProjectPageShell() {
  const { tasks, loading, fleet, loadProjects } = useProjects()

  if (loading && tasks.length === 0) return <ProjectPageLoadingState />

  return (
    <ProjectDetailPage
      fleet={fleet}
      onRefresh={loadProjects}
    />
  )
}
