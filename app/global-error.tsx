'use client'

import { useEffect } from 'react'
import { ErrorState } from '@/components/ErrorState'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html>
      <body>
        <ErrorState message="Something went wrong" onRetry={reset} />
      </body>
    </html>
  )
}
