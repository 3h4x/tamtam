'use client'

import { useProjects } from '@/components/ProjectsProvider'
import { TaskDetailPage } from '@/components/TaskDetailPage'
import { LoadingState } from '@/components/LoadingState'

export default function TaskPage() {
  const {
    tasks, loading, fleet, priorities,
    handlePriorityChange, handlePause, handleResume,
  } = useProjects()

  if (loading && tasks.length === 0) return <LoadingState />

  return (
    <TaskDetailPage
      fleet={fleet}
      priorities={priorities}
      onPriorityChange={handlePriorityChange}
      onPause={handlePause}
      onResume={handleResume}
    />
  )
}
