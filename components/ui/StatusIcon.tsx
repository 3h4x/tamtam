'use client'

type Size = 'sm' | 'md'

export function StatusIcon({
  ok,
  className,
  size = 'md',
}: {
  ok: boolean
  className?: string
  size?: Size
}) {
  const sm = size === 'sm'
  const cls = className ?? (sm ? 'w-3.5 h-3.5' : 'w-4 h-4')
  const viewBox = sm ? '0 0 14 14' : '0 0 16 16'
  const strokeWidth = sm ? 1.8 : 2
  const cx = sm ? 7 : 8
  const cy = sm ? 7 : 8
  const r = sm ? 5.5 : 6.5
  const okPath = sm ? 'M4.5 7l1.8 1.8 3-3.5' : 'M5 8l2 2 4-4'
  const errPath = sm ? 'M5 5l4 4M9 5l-4 4' : 'M5.5 5.5l5 5M10.5 5.5l-5 5'

  return ok ? (
    <svg
      aria-label="success"
      className={`${cls} text-status-success shrink-0`}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={cx} cy={cy} r={r} />
      <path d={okPath} />
    </svg>
  ) : (
    <svg
      aria-label="attention"
      className={`${cls} text-status-error shrink-0`}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={cx} cy={cy} r={r} />
      <path d={errPath} />
    </svg>
  )
}
