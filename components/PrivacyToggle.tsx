'use client'

import { usePrivacyMode } from '@/hooks/usePrivacyMode'
import { Button } from '@/components/ui/Button'

export function PrivacyToggle() {
  const { isPrivate, togglePrivacy } = usePrivacyMode()

  return (
    <Button
      type="button"
      variant={isPrivate ? 'warning' : 'secondary'}
      onClick={togglePrivacy}
      title={isPrivate ? 'Show project names' : 'Hide project names (privacy mode)'}
      aria-label={isPrivate ? 'Disable privacy mode' : 'Enable privacy mode'}
      className={`h-9 w-9 justify-center rounded-lg p-0 ${
        isPrivate ? '' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {isPrivate ? (
        // eye-off
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
          <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      ) : (
        // eye
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      )}
    </Button>
  )
}
