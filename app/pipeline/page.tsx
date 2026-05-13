// tamtam
import { Suspense } from 'react'
import { PipelinePage } from '@/components/PipelinePage'
import { LoadingState } from '@/components/LoadingState'

export default function Pipeline() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PipelinePage />
    </Suspense>
  )
}
