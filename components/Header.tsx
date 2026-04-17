'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from './ThemeToggle'
import { NotificationBell } from './NotificationBell'

interface HeaderProps {
  loading: boolean
  lastRefresh: number
}

const NAV_ITEMS = [
  { to: '/', label: 'Projects' },
  { to: '/jobs', label: 'Runs' },
  { to: '/skills', label: 'Skills' },
  { to: '/settings', label: 'Settings' },
]

export function Header({ loading, lastRefresh: _lastRefresh }: HeaderProps) {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 border-b border-border bg-bg-primary">
      <div className="flex items-center gap-6">
        <h1 className="m-0 text-lg font-semibold text-text-primary">tamtam</h1>
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.to === '/'
              ? pathname === '/'
              : pathname.startsWith(item.to)
            return (
              <Link
                key={item.to}
                href={item.to}
                className={`px-3 py-1.5 rounded-md text-sm no-underline transition-colors ${
                  isActive
                    ? 'bg-accent-light text-accent font-medium'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        {loading && <span className="text-xs text-text-tertiary animate-spin">{'\u27F3'}</span>}
        <NotificationBell />
        <ThemeToggle />
      </div>
    </header>
  )
}
