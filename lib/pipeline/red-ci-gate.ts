// Guards the release pipeline against the "merge onto red CI" vicious cycle:
// feature PRs keep merging (their PR check is green) while the post-merge
// default-branch CI stays failing and nothing repairs it, so every cycle adds
// another merge on top of broken CI. When the default-branch CI is red, an
// automatic feature release is blocked (and fix-ci is dispatched to repair)
// instead of piling on more work. See docs/PIPELINE.md → CI-red gate.

/**
 * Whether to block an automatic feature release because the project's
 * default-branch CI is currently red.
 *
 * Exemptions (must NOT block, or the pipeline deadlocks / loses the override):
 *  - the fix-ci-chained release (`sourceJobKind === 'fix-ci'`): it CARRIES the
 *    CI fix — CI can't go green without it landing.
 *  - operator-initiated releases (the manual Release button): explicit human
 *    override.
 *  - the kill-switch setting off (`blockEnabled === false`).
 */
export function shouldBlockReleaseOnRedCi(opts: {
  blockEnabled: boolean;
  operatorInitiated: boolean;
  sourceJobKind: string | null;
  ci: string | null;
}): boolean {
  if (!opts.blockEnabled) return false;
  if (opts.operatorInitiated) return false;
  if (opts.sourceJobKind === 'fix-ci') return false;
  return opts.ci === 'failure';
}
