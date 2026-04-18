export function computePushBlockReason(
  totalChanges: number,
  hasUnreviewed: boolean,
  verdict: string | null | undefined,
): string | null {
  if (totalChanges === 0) return 'No changes to push'
  if (hasUnreviewed) return 'Run a review first before pushing'
  if (!verdict) return 'No review on record — run a review before pushing'
  if (verdict !== 'LGTM') return `Review verdict is "${verdict}" — fix issues before pushing`
  return null
}
