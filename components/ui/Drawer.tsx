'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/Button'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  /** Panel max width. Defaults to a comfortable reading column. */
  widthClass?: string
  ariaLabel?: string
}

// Right-anchored slide-over. Portal + backdrop, ESC to close, body-scroll lock,
// focus-on-open. Follows UI.md: bordered bg-secondary panel, no drop shadow;
// entrance is a plain opacity fade (no layout/transform animation).
export function Drawer({ open, onClose, title, children, widthClass = 'max-w-2xl', ariaLabel }: DrawerProps) {
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) {
      setVisible(false)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Next frame so the fade-in transition runs from the initial opacity.
    const raf = requestAnimationFrame(() => {
      setVisible(true)
      panelRef.current?.focus()
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      cancelAnimationFrame(raf)
    }
  }, [open, onClose])

  if (!mounted || !open) return null

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-end transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : 'Detail')}
        tabIndex={-1}
        className={`relative flex h-full w-full ${widthClass} flex-col border-l border-border bg-bg-secondary outline-none`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">{title}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="shrink-0 text-text-tertiary hover:text-text-primary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
