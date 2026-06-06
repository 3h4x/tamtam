'use client'

import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'

interface ErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div role="alert">
      <ErrorCallout
        padding="md"
        radius="md"
        preWrap={false}
        className="mb-4 flex items-center gap-3 !rounded-lg !border-status-error !p-4"
      >
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
      </ErrorCallout>
    </div>
  )
}
