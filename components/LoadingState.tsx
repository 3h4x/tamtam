'use client'

export function LoadingState() {
  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="skeleton h-7 w-32" />
        <div className="skeleton h-8 w-24" />
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-3 border-b border-border bg-bg-secondary">
          {['Project', 'Status', 'CI', 'Agents', 'Changes'].map((col) => (
            <div key={col} className="skeleton h-3.5 w-16" />
          ))}
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-4 py-4 border-b border-border last:border-0"
            style={{ opacity: 1 - i * 0.12 }}
          >
            <div className="flex items-center gap-3">
              <div className="skeleton h-4 w-4 rounded-full" />
              <div className="skeleton h-4 w-36" />
            </div>
            <div className="skeleton h-4 w-12" />
            <div className="skeleton h-4 w-8" />
            <div className="skeleton h-5 w-20 rounded-full" />
            <div className="skeleton h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  )
}
