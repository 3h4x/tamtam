import { Suspense } from 'react'
import { JobsPage } from '@/components/JobsPage'
import { LoadingState } from '@/components/LoadingState'

export default function Runs() {
  return (
    <Suspense fallback={<LoadingState />}>
      <JobsPage />
    </Suspense>
  )
}
