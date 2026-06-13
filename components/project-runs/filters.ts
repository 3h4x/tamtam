import type { KindBucket } from '@/components/project-runs/utils'

// One-axis filter: either a kind bucket, or a status shortcut.
export type Filter =
  | { kind: 'all' }
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'bucket'; bucket: KindBucket }

export function filterKey(f: Filter): string {
  return f.kind === 'bucket' ? `b:${f.bucket}` : f.kind
}
