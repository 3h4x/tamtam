import { Suspense } from 'react'
import { StatsTabs } from '@/components/stats/StatsTabs'
import { LoadingState } from '@/components/LoadingState'

export default function Stats() {
  return (
    <Suspense fallback={<LoadingState />}>
      <StatsTabs />
    </Suspense>
  )
}
