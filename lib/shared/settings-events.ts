export const SETTINGS_CHANGED_EVENT = 'tamtam:settings-changed'

// This event carries setting patches. Emitters may send a full snapshot or
// only the keys they changed, so subscribers must merge absent keys.
export type SettingsEventPayload = Partial<Record<string, string | undefined>>

interface SettingsChangedDetail {
  settings: SettingsEventPayload
}

export function dispatchSettingsChanged(settings: SettingsEventPayload) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, {
    detail: { settings },
  }))
}

export function subscribeToSettingsChanged(onChange: (settings: SettingsEventPayload) => void) {
  if (typeof window === 'undefined') return () => {}

  const handler = (event: Event) => {
    const settings = (event as CustomEvent<SettingsChangedDetail>).detail?.settings
    onChange(settings ?? {})
  }

  window.addEventListener(SETTINGS_CHANGED_EVENT, handler)
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler)
}
