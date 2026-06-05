'use client'

import type { ReactNode } from 'react'

interface ErrorCalloutProps {
  children: ReactNode
  className?: string
}

const BASE = 'rounded border border-status-error/30 bg-status-error/10 p-2 whitespace-pre-wrap text-status-error'

/**
 * Inline error-message block: renders error text inside a small red, pre-wrapped
 * callout box. For full-panel load failures use ErrorState; for dismissible
 * banners use ErrorBanner.
 */
export function ErrorCallout({ children, className }: ErrorCalloutProps) {
  return <div className={[BASE, className].filter(Boolean).join(' ')}>{children}</div>
}
