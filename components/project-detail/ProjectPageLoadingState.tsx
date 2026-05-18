'use client'

function ChipSkeleton({ width }: { width: string }) {
  return <div className={`skeleton h-6 rounded-full ${width}`} />
}

function StatusCardSkeleton() {
  return (
    <div className="flex min-w-[140px] items-center gap-2 rounded-md border border-border bg-bg-secondary px-2.5 py-1.5">
      <div className="skeleton h-1.5 w-1.5 shrink-0 rounded-full" />
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">Status</div>
      <div className="skeleton h-3.5 w-[4.5rem] rounded" />
    </div>
  )
}

function MetricCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border px-3 py-2">
        <div className="skeleton h-3 w-24 rounded" />
      </div>
      <div className="space-y-3 p-3">
        <div className="flex items-end justify-between gap-3">
          <div className="skeleton h-7 w-20 rounded" />
          <div className="skeleton h-3.5 w-16 rounded" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-md border border-border bg-bg-primary px-3 py-2">
              <div className="skeleton h-3 w-[4.5rem] rounded" />
              <div className="mt-2 skeleton h-4 w-12 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ActivityCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <div className="skeleton h-4 w-24 rounded" />
          <div className="mt-1 skeleton h-3 w-20 rounded" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ChipSkeleton width="w-[4.5rem]" />
          <ChipSkeleton width="w-16" />
          <ChipSkeleton width="w-14" />
        </div>
      </div>
      <div className="grid gap-2 p-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-md border border-border bg-bg-primary px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="skeleton h-3 w-3 rounded-full" />
                  <div className="skeleton h-4 w-28 rounded" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <div className="skeleton h-3 w-[4.5rem] rounded" />
                  <div className="skeleton h-3 w-14 rounded" />
                </div>
              </div>
              <div className="skeleton h-5 w-14 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProjectPageLoadingState() {
  return (
    <div className="px-0 py-1" aria-label="Loading project">
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="skeleton h-6 w-6 rounded-md" />
          <div className="skeleton h-7 w-40 rounded" />
          <ChipSkeleton width="w-[4.5rem]" />
          <ChipSkeleton width="w-16" />
          <ChipSkeleton width="w-20" />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <div className="skeleton h-8 w-24 rounded-md" />
          <div className="skeleton h-8 w-[6.5rem] rounded-md" />
          <div className="skeleton h-8 w-24 rounded-md" />
          <div className="skeleton h-8 w-20 rounded-md" />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2 border-b border-border">
        {['Overview', 'Terminal', 'Changes', 'History', 'Issues', 'Docs', 'Config'].map((tab, index) => (
          <div
            key={tab}
            className={`rounded-t-md border border-b-0 border-border px-3 py-2 ${index === 0 ? 'bg-bg-secondary' : 'bg-bg-primary'}`}
          >
            <div className="skeleton h-3.5 rounded" style={{ width: `${Math.max(tab.length * 7, 48)}px` }} />
          </div>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {Array.from({ length: 4 }).map((_, index) => (
          <StatusCardSkeleton key={index} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-4">
          <ActivityCardSkeleton />
          <MetricCardSkeleton />
        </div>
        <div className="space-y-4">
          <MetricCardSkeleton />
          <MetricCardSkeleton />
        </div>
      </div>
    </div>
  )
}
