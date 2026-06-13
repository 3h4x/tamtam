// Bucket kinds for filtering + labeling. Anything that doesn't match lands in
// "other" (covers custom actions, future kinds).
export type KindBucket =
  | 'run'
  | 'release'
  | 'review'
  | 'test'
  | 'fix'
  | 'fix-ci'
  | 'commit'
  | 'push'
  | 'mark-dod'
  | 'pr-wait'
  | 'soak'
  | 'agent'
  | 'other'

export const ACTIVE_WORK_BUCKET_ORDER: KindBucket[] = [
  'run',
  'release',
  'review',
  'test',
  'fix',
  'fix-ci',
  'commit',
  'push',
  'mark-dod',
  'pr-wait',
  'soak',
  'agent',
  'other',
]

export function bucketOf(kind: string): KindBucket {
  if (kind === 'run') return 'run'
  if (kind === 'release') return 'release'
  if (kind === 'review') return 'review'
  if (kind === 'test') return 'test'
  if (kind === 'fix') return 'fix'
  if (kind === 'fix-ci') return 'fix-ci'
  if (kind === 'commit') return 'commit'
  if (kind === 'push') return 'push'
  if (kind === 'mark-dod') return 'mark-dod'
  if (kind === 'pr-wait') return 'pr-wait'
  if (kind === 'soak') return 'soak'
  if (kind.startsWith('agent:')) return 'agent'
  return 'other'
}

export const KIND_LABEL: Record<KindBucket, string> = {
  run: 'chat',
  release: 'release',
  review: 'review',
  test: 'test',
  fix: 'fix',
  'fix-ci': 'fix-ci',
  commit: 'commit',
  push: 'push',
  'mark-dod': 'dod',
  'pr-wait': 'pr-wait',
  soak: 'soak',
  agent: 'agent',
  other: 'action',
}

export const KIND_COLOR: Record<KindBucket, string> = {
  run: 'bg-accent/15 text-accent',
  release: 'bg-accent/20 text-accent border border-accent/40',
  review: 'bg-status-info/15 text-status-info',
  test: 'bg-status-success/15 text-status-success',
  fix: 'bg-status-warning/15 text-status-warning',
  'fix-ci': 'bg-status-warning/15 text-status-warning',
  commit: 'bg-status-success/15 text-status-success',
  push: 'bg-status-success/15 text-status-success',
  'mark-dod': 'bg-status-info/15 text-status-info',
  'pr-wait': 'bg-status-info/15 text-status-info',
  soak: 'bg-status-info/15 text-status-info',
  agent: 'bg-bg-tertiary text-text-secondary border border-border',
  other: 'bg-text-tertiary/15 text-text-secondary',
}

export function activeWorkBadgeLabel(kindOrBucket: string): string {
  if (kindOrBucket in KIND_LABEL) return KIND_LABEL[kindOrBucket as KindBucket]
  return KIND_LABEL[bucketOf(kindOrBucket)]
}

export function runKindDisplayName(kindOrBucket: string): string {
  const bucket = kindOrBucket in KIND_LABEL ? kindOrBucket as KindBucket : bucketOf(kindOrBucket)
  if (bucket === 'run') return 'Chat'
  if (bucket === 'release') return 'Release pipeline'
  if (bucket === 'review') return 'Code review'
  if (bucket === 'test') return 'Test run'
  if (bucket === 'fix') return 'Auto-fix'
  if (bucket === 'fix-ci') return 'Fix CI'
  if (bucket === 'commit') return 'Commit'
  if (bucket === 'push') return 'Push'
  if (bucket === 'mark-dod') return 'Mark DoD'
  if (bucket === 'pr-wait') return 'PR wait'
  if (bucket === 'soak') return 'Soak'
  if (bucket === 'agent') return 'Agent'
  return 'Action'
}

export function activeWorkAccentClass(kind: string): string {
  const bucket = bucketOf(kind)
  if (bucket === 'run' || bucket === 'release') return 'border-l-accent'
  if (bucket === 'review' || bucket === 'mark-dod' || bucket === 'pr-wait' || bucket === 'soak') return 'border-l-status-info'
  if (bucket === 'test' || bucket === 'commit' || bucket === 'push') return 'border-l-status-success'
  if (bucket === 'fix' || bucket === 'fix-ci') return 'border-l-status-warning'
  return 'border-l-border'
}
