// Two relative-time formatters live here. They have intentionally different
// contracts: prose vs. tight columnar. Keep both — UI callers pick the one
// that fits their density budget.
//
//   formatAgo:     'just now' | '3m ago' | '2h ago' | '5d ago'    (prose-style)
//   formatTimeAgo: '<1m'       | '3m'      | '2h'      | '5d'        (compact)
//
// Both treat future timestamps as "now"-equivalent (no negative numbers).

export function formatAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatTimeAgo(isoDate: string): string {
  const d = (Date.now() - new Date(isoDate).getTime()) / 1000;
  if (d < 60) return '<1m';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/**
 * Format a millisecond duration as `230ms` / `45s` / `3m 12s` / `1h 4m`.
 * Canonical replacement for the near-identical ms-duration formatters that
 * were reimplemented in PipelineTimeline, RunDetailDrawer, and ReleaseTraceView.
 * `empty` is returned for null / non-positive input (callers pass '' or '—').
 */
export function formatDurationMs(ms: number | null | undefined, empty = ''): string {
  if (ms == null || ms <= 0) return empty;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
