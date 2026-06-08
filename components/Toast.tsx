'use client'

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'

interface ToastItem {
  id: number
  message: string
  type: 'info' | 'error' | 'success'
}

interface ToastContextType {
  toast: (message: string, type?: 'info' | 'error' | 'success') => void
}

const ToastContext = createContext<ToastContextType | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

let _nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const toast = useCallback((message: string, type: 'info' | 'error' | 'success' = 'info') => {
    const id = ++_nextId
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  // Stable value reference — without this, every toast add/remove rebuilds
  // the context object and forces every `useToast()` consumer to re-render
  // even though the `toast` function itself never changes.
  const ctxValue = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={ctxValue}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role={t.type === 'error' ? 'alert' : 'status'}
              aria-live={t.type === 'error' ? 'assertive' : 'polite'}
              className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium max-w-[400px] animate-slide-in-up ${
                t.type === 'error'
                  ? 'bg-status-error text-white'
                  : t.type === 'success'
                    ? 'bg-status-success text-white'
                    : 'bg-bg-tertiary text-text-primary border border-border'
              }`}
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
