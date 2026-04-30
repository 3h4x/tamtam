'use client'

interface ErrorStateProps {
  message: string
  onRetry?: () => void
  hint?: string
}

export function ErrorState({ message, onRetry, hint }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 gap-3 text-center">
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
      <p className="text-sm text-text-secondary max-w-md">{message}</p>
      {hint && <p className="text-xs text-text-tertiary max-w-md">{hint}</p>}
      {onRetry && (
        <button
          className="mt-1 px-3 py-1.5 text-xs border border-border rounded-md text-text-primary hover:bg-bg-tertiary cursor-pointer transition-colors"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  )
}
