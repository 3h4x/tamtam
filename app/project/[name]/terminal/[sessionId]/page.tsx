'use client'

import { useProjects } from '@/components/ProjectsProvider'
import { ProjectDetailPage } from '@/components/ProjectDetailPage'
import { LoadingState } from '@/components/LoadingState'

export default function TerminalSessionPage() {
  const { tasks, loading, fleet, loadProjects } = useProjects()

  if (loading && tasks.length === 0) return <LoadingState />

  return (
    <ProjectDetailPage
      fleet={fleet}
      onRefresh={loadProjects}
    />
  )
}
