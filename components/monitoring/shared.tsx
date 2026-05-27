'use client'

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ok ? 'bg-status-success' : 'bg-status-error'}`} />
  )
}

export function SectionHeader({ title, status }: { title: string; status: 'ok' | 'unavailable' | 'issue' }) {
  const colors = { ok: 'text-status-success', issue: 'text-status-warning', unavailable: 'text-text-tertiary' }
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <span className={`text-xs font-medium ${colors[status]}`}>
        {status === 'ok' ? '● ok' : status === 'unavailable' ? '● unavailable' : '● issues'}
      </span>
    </div>
  )
}
