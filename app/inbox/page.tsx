'use client'

import { Suspense } from 'react'
import { AttentionTabs } from '@/components/attention/AttentionTabs'

export default function InboxRoute() {
  return (
    <Suspense fallback={null}>
      <AttentionTabs />
    </Suspense>
  )
}
