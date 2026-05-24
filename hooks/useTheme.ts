import { useEffect, useState } from 'react'
import { readBrowserStorage, writeBrowserStorage } from '@/lib/client/browser-storage'

type ThemeValue = 'light' | 'dark'

function getSystemTheme(): ThemeValue {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readCurrentTheme(): ThemeValue {
  if (typeof document === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme') as ThemeValue | null
  if (attr === 'light' || attr === 'dark') return attr
  const stored = readBrowserStorage('z-theme-preference') as ThemeValue | null
  return stored ?? getSystemTheme()
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeValue>('dark')

  // On mount: sync state to whatever the DOM currently says, and subscribe
  // to attribute changes so every hook instance reacts to theme toggles from
  // any other instance (Header, ThemeToggle, etc.).
  useEffect(() => {
    const current = readCurrentTheme()
    setThemeState(current)
    document.documentElement.setAttribute('data-theme', current)

    const observer = new MutationObserver(() => {
      const next = document.documentElement.getAttribute('data-theme') as ThemeValue | null
      if (next === 'light' || next === 'dark') {
        setThemeState(next)
      }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const setTheme = (newTheme: ThemeValue) => {
    document.documentElement.setAttribute('data-theme', newTheme)
    writeBrowserStorage('z-theme-preference', newTheme)
    // The MutationObserver will flip local state; no need to also call setThemeState here.
  }

  return { theme, setTheme }
}
