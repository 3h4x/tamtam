export const JOBS_PAUSED_CHANGED_EVENT = 'tamtam:jobs-paused-changed'

interface JobsPausedChangedDetail {
  paused: boolean
}

export function dispatchJobsPausedChanged(paused: boolean) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<JobsPausedChangedDetail>(JOBS_PAUSED_CHANGED_EVENT, {
    detail: { paused },
  }))
}

export function subscribeToJobsPausedChanged(onChange: (paused: boolean) => void) {
  if (typeof window === 'undefined') return () => {}

  const handler = (event: Event) => {
    const paused = (event as CustomEvent<JobsPausedChangedDetail>).detail?.paused === true
    onChange(paused)
  }

  window.addEventListener(JOBS_PAUSED_CHANGED_EVENT, handler)
  return () => window.removeEventListener(JOBS_PAUSED_CHANGED_EVENT, handler)
}
