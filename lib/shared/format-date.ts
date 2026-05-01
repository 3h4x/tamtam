export function fmtAbsolute(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `today ${time}`
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + time
}
