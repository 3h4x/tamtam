'use client'

// Pulsing "live" indicator: a solid status-info dot with an animate-ping halo
// behind it. Used to mark in-progress/running activity (active work header,
// running run rows). For a static success/attention glyph use StatusIcon.
type PulseDotSize = 'xs' | 'sm'

const SIZE: Record<PulseDotSize, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2.5 w-2.5',
}

export function PulseDot({ size = 'sm', className }: { size?: PulseDotSize; className?: string }) {
  return (
    <span className={['relative flex', SIZE[size], className].filter(Boolean).join(' ')}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-info opacity-60" />
      <span className={`relative inline-flex rounded-full bg-status-info ${SIZE[size]}`} />
    </span>
  )
}
