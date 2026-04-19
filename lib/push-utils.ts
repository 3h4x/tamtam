export function computePushBlockReason(
  totalChanges: number,
  hasUnreviewed: boolean,
  verdict: string | null | undefined,
  commitJustFailed = false,
): string | null {
  if (totalChanges === 0 && !commitJustFailed) return 'No changes to push'
  // When a commit hook failed and modified files, the diff looks "unreviewed"
  // but the LGTM is still valid — don't block the retry.
  if (hasUnreviewed && !commitJustFailed) return 'Run a review first before pushing'
  if (!verdict && !commitJustFailed) return 'No review on record — run a review before pushing'
  if (verdict && verdict !== 'LGTM' && !commitJustFailed) return `Review verdict is "${verdict}" — fix issues before pushing`
  return null
}
