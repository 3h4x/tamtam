'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from './ThemeToggle'
import { NotificationBell } from './NotificationBell'
import { PrivacyToggle } from './PrivacyToggle'
import { useTheme } from '@/hooks/useTheme'

interface HeaderProps {
  loading: boolean
  lastRefresh: number
}

const NAV_ITEMS = [
  { to: '/', label: 'Projects' },
  { to: '/monitoring', label: 'Monitoring' },
  { to: '/runs', label: 'Runs' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/stats', label: 'Stats' },
  { to: '/skills', label: 'Skills' },
  { to: '/settings', label: 'Settings' },
]

export function Header({ loading, lastRefresh: _lastRefresh }: HeaderProps) {
  const pathname = usePathname()
  const { theme } = useTheme()
  const logoSrc = theme === 'dark' ? '/logo.png' : '/logo-light.png'

  return (
    <header className="sticky top-0 z-50 flex items-center justify-between px-3 sm:px-6 py-3 border-b border-border bg-bg-primary gap-2">
      <div className="flex items-center gap-1 sm:gap-4 min-w-0 overflow-hidden">
        <div className="overflow-hidden shrink-0 -my-1" style={{ height: 36 }}>
          <img src={logoSrc} alt="tamtam" style={{ height: 52, width: 'auto', marginTop: -8 }} />
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-none">
          {NAV_ITEMS.map((item) => {
            const isActive = item.to === '/'
              ? pathname === '/'
              : pathname.startsWith(item.to)
            return (
              <Link
                key={item.to}
                href={item.to}
                className={`px-2.5 sm:px-3 py-1.5 rounded-md text-sm no-underline transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
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
      <div className="flex items-center gap-2 shrink-0">
        {loading && <span className="text-xs text-text-tertiary animate-spin" aria-label="Loading" role="status">{'\u27F3'}</span>}
        <PrivacyToggle />
        <NotificationBell />
        <ThemeToggle />
      </div>
    </header>
  )
}
