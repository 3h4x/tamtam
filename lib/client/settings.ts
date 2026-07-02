import { cachedGet, invalidateGet } from './request-cache'

const SETTINGS_URL = '/api/settings'

// Settings values are persisted as strings (`jobs_paused: 'true'`, model names,
// etc.), matching how every caller reads them.
export type SettingsBag = Record<string, string | undefined>

// Shared settings reader. Every project tab independently fetched
// `/api/settings` — the page shell, the jobs-pause chip, and the tab body all
// hit it concurrently on each render (browser-measured `settings ×2–3` per tab
// switch). Routing them through the shared GET helper collapses those
// concurrent duplicates into ONE in-flight request.
//
// Dedup-only (no TTL memo): `jobs_paused` / `rebuild_in_progress` are liveness
// signals the 5s pollers must see fresh, so we never serve a stale cached value
// — the only thing shared is a concurrent in-flight fetch. That kills the
// render-time burst with zero staleness and no cross-render cache to
// invalidate. `invalidateSettings()` stays exposed for mutation paths.
export async function fetchSettings(
  _opts: { force?: boolean } = {},
): Promise<{ settings: SettingsBag }> {
  return cachedGet(SETTINGS_URL)
}

export function invalidateSettings(): void {
  invalidateGet(SETTINGS_URL)
}
