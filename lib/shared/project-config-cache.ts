// Server-side cache for the per-project `/config` response.
//
// The /config GET does an fs test-command probe + `.tamtam/config.yml` read +
// several DB reads on every project-page mount, so under host contention it
// added seconds to the header (it drives the Paused pill and the Release /
// Auto-release buttons). The route caches the computed response per project
// with a short TTL and single-flights cold misses, mirroring the /branch and
// /behind routes.
//
// This lives in its own module (not the route file) because Next.js route
// modules may only export HTTP method handlers — an exported helper there fails
// the route-type check. Pinned to globalThis because Next.js duplicates modules
// across bundle realms.
//
// Freshness after a mutation: the config PATCH calls `clearConfigCache()`, and
// the client's post-mutation refetch sends `x-tamtam-refresh: 1` (see
// `fetchProjectConfig`) which bypasses + rewarms the cache.

export type ConfigResponse = Record<string, unknown>;

declare global {
  var __tamtamConfigCache: Map<string, { value: ConfigResponse; time: number }> | undefined;
  var __tamtamConfigInflight: Map<string, Promise<ConfigResponse>> | undefined;
}

export const CONFIG_TTL_MS = 5_000;

export function configCache(): Map<string, { value: ConfigResponse; time: number }> {
  return (globalThis.__tamtamConfigCache ??= new Map());
}

export function configInflight(): Map<string, Promise<ConfigResponse>> {
  return (globalThis.__tamtamConfigInflight ??= new Map());
}

/** Bust the cached /config response for a project (call after a config write). */
export function clearConfigCache(projectName: string): void {
  globalThis.__tamtamConfigCache?.delete(projectName);
}
