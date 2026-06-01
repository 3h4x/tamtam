'use client'

import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'

interface ErrorStateProps {
  message: string
  onRetry?: () => void
  hint?: string
}

export function ErrorState({ message, onRetry, hint }: ErrorStateProps) {
  return (
    <EmptyState
      paddingY="none"
      paddingX="none"
      className="px-4 py-16"
      icon={(
        <svg
          className="w-10 h-10 text-status-error/70"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )}
      title={<span className="font-normal">{message}</span>}
      description={hint}
      action={onRetry && (
        <Button
          size="sm"
          className="mt-1 rounded-md bg-transparent px-3 py-1.5 font-normal"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    />
  )
}
