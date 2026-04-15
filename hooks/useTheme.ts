import { useEffect, useState } from 'react'

type ThemeValue = 'light' | 'dark'

function getSystemTheme(): ThemeValue {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeValue>('dark')

  useEffect(() => {
    const stored = localStorage.getItem('z-theme-preference') as ThemeValue | null
    const initial = stored || getSystemTheme()
    setThemeState(initial)
    document.documentElement.setAttribute('data-theme', initial)
  }, [])

  const setTheme = (newTheme: ThemeValue) => {
    setThemeState(newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('z-theme-preference', newTheme)
  }

  return { theme, setTheme }
}
