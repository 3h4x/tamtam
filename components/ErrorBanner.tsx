'use client'

import { Button } from '@/components/ui/Button'

interface ErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="flex items-center gap-3 p-4 mb-4 bg-status-error/10 border border-status-error rounded-lg text-status-error" role="alert">
      {/* Plain U+26A0 (no VS16) renders as a text-style glyph, matching the
          codebase's monochrome style instead of the colour-emoji default. */}
      <span className="text-lg leading-none">⚠</span>
      <span>{message}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        className="ml-auto border-0 bg-transparent p-0 font-normal text-inherit hover:bg-transparent hover:text-inherit"
        aria-label="Dismiss error"
      >
        &#x2715;
      </Button>
    </div>
  )
}
