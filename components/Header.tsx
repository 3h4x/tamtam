'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from './ThemeToggle'
import { NotificationBell } from './NotificationBell'
import { PrivacyToggle } from './PrivacyToggle'
import { JobsPauseToggle } from './JobsPauseToggle'
import { fetchRecommendationsSummary } from '@/lib/client-api'
import { useTheme } from '@/hooks/useTheme'

interface HeaderProps {
  loading: boolean
  lastRefresh: number
}

interface NavItem {
  to: string
  label: string
  // When set, the nav item shows this Map's value as a count chip — same
  // pattern as `Issues / PRs 10` on the project tab nav. The chip is hidden
  // when the count is 0 to avoid noise.
  countKey?: 'recommendations'
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Projects' },
  { to: '/monitoring', label: 'Monitoring' },
  { to: '/runs', label: 'Runs' },
  { to: '/workflow-runs', label: 'Workflows' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/stats', label: 'Stats' },
  { to: '/library', label: 'Library' },
  { to: '/recommendations', label: 'Recommendations', countKey: 'recommendations' },
  { to: '/settings', label: 'Settings' },
]

export function Header({ loading, lastRefresh: _lastRefresh }: HeaderProps) {
  const pathname = usePathname()
  const { theme } = useTheme()
  const logoSrc = theme === 'dark' ? '/logo-light.png' : '/logo.png'

  // Open-recommendation count across all projects, polled on a 60s cadence
  // (same pattern as JobsPauseToggle). The chip is hidden when count is 0
  // and silently absent on fetch error — fail-open.
  const [recCount, setRecCount] = useState<number>(0)
  useEffect(() => {
    let live = true
    const load = () => {
      fetchRecommendationsSummary()
        .then((s) => { if (live) setRecCount(s.openCount) })
        .catch(() => { if (live) setRecCount(0) })
    }
    load()
    const id = setInterval(load, 60_000)
    window.addEventListener('tamtam:recommendations-changed', load)
    return () => { live = false; clearInterval(id); window.removeEventListener('tamtam:recommendations-changed', load) }
  }, [])
  const counts: Record<string, number> = { recommendations: recCount }

  return (
    <header className="sticky top-0 z-50 flex flex-wrap sm:flex-nowrap items-center px-3 sm:px-6 py-2 border-b border-border bg-bg-primary gap-x-2 gap-y-1 min-w-0">
      <div className="overflow-hidden shrink-0 -my-1" style={{ height: 36 }}>
        <img src={logoSrc} alt="tamtam" width={122} height={52} style={{ height: 52, width: 122, marginTop: -8, display: 'block' }} />
      </div>
      <nav className="order-3 sm:order-none flex flex-1 basis-full sm:basis-auto min-w-0 items-center gap-0.5 overflow-x-auto scrollbar-none" aria-label="Global sections">
        {NAV_ITEMS.map((item) => {
          const isActive = item.to === '/'
            ? pathname === '/'
            : pathname === item.to || pathname.startsWith(item.to + '/')
          const count = item.countKey ? counts[item.countKey] ?? 0 : 0
          return (
            <Link
              key={item.to}
              href={item.to}
              className={`px-2.5 sm:px-3 py-1.5 rounded-md text-sm no-underline transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 inline-flex items-center gap-1.5 ${
                isActive
                  ? 'bg-accent-light text-accent font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
              }`}
            >
              {item.label}
              {item.countKey && count > 0 && (
                <span
                  className="inline-flex items-center justify-center min-w-[1.25rem] px-1.5 rounded-full bg-accent/15 text-accent text-[10px] font-mono tabular-nums leading-4"
                  aria-label={`${count} open recommendation${count === 1 ? '' : 's'}`}
                >
                  {count}
                </span>
              )}
            </Link>
          )
        })}
      </nav>
      <div className="flex items-center gap-2 shrink-0 ml-auto">
        {loading && <span className="text-xs text-text-tertiary animate-spin" aria-label="Loading" role="status">{'\u27F3'}</span>}
        <PrivacyToggle />
        <JobsPauseToggle />
        <NotificationBell />
        <ThemeToggle />
      </div>
    </header>
  )
}
