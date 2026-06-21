'use client'

import { Suspense } from 'react'
import { GlobalRecommendationsPage } from '@/components/GlobalRecommendationsPage'

export default function RecommendationsRoute() {
  return (
    <Suspense fallback={null}>
      <GlobalRecommendationsPage />
    </Suspense>
  )
}
