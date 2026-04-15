'use client'

export function LoadingState() {
  return (
    <div className="p-6 flex items-center justify-center flex-col gap-4">
      <div className="spinner"></div>
      <div className="text-text-secondary text-sm">Loading projects...</div>
    </div>
  )
}
