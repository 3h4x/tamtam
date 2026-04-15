import { Suspense } from 'react'
import { JobsPage } from '@/components/JobsPage'
import { LoadingState } from '@/components/LoadingState'

export default function Jobs() {
  return (
    <Suspense fallback={<LoadingState />}>
      <JobsPage />
    </Suspense>
  )
}
