'use client'

import { useProjects } from '@/components/ProjectsProvider'
import { ProjectDetailPage } from '@/components/ProjectDetailPage'
import { LoadingState } from '@/components/LoadingState'

export default function TerminalSessionPage() {
  const {
    tasks, loading, fleet, priorities,
    handlePriorityChange, handlePause, handleResume,
    loadProjects, startFastPolling,
  } = useProjects()

  if (loading && tasks.length === 0) return <LoadingState />

  return (
    <ProjectDetailPage
      fleet={fleet}
      priorities={priorities}
      onPriorityChange={handlePriorityChange}
      onPause={handlePause}
      onResume={handleResume}
      onRefresh={loadProjects}
      onPush={() => { startFastPolling(); loadProjects() }}
    />
  )
}
