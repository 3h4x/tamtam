'use client'

interface ErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="flex items-center gap-3 p-4 mb-4 bg-red-500/10 border border-status-error rounded-lg text-status-error" role="alert">
      {/* Plain U+26A0 (no VS16) renders as text-style glyph in the codebase's
          monochrome style — matches sibling usages in IssuesTab and RunRow. */}
      <span className="text-lg leading-none">⚠</span>
      <span>{message}</span>
      <button
        onClick={onDismiss}
        className="ml-auto bg-transparent border-none p-0 text-inherit cursor-pointer"
        aria-label="Dismiss error"
      >
        &#x2715;
      </button>
    </div>
  )
}
