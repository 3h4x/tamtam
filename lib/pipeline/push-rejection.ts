// Helpers for classifying push failures. The release pipeline uses these to
// decide whether to attempt an auto-fix (`isHookRejection`) or surface the
// failure for human triage (`isTestFailureRejection`).
//
// Previously co-located with `startFixPush` in `start-fix-push.ts`. After
// the fix-push workflow was collapsed into the generic `fix` phase, these
// detectors live in their own module so the lifecycle hook can still
// classify push failures without pulling in start-fix.

/** Is this push failure a hook rejection (lint/typecheck nit) worth auto-fixing? */
export function isHookRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const s = detail.toLowerCase();
  return (
    s.includes('husky') ||
    s.includes('pre-commit') ||
    s.includes('pre-push') ||
    s.includes('lint-staged') ||
    /\beslint\b/.test(s) ||
    /@typescript-eslint/.test(s)
  );
}

/** Did the pre-push hook reject because TESTS failed? Auto-fix loops can't
 *  reliably converge on test failures (especially flakes), so callers stop
 *  the pipeline and surface the failure for human triage. */
export function isTestFailureRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const s = detail.toLowerCase();
  return (
    /\btests? failed\b/.test(s) ||
    /\btest files?\s+\d+\s+failed/.test(s) ||
    /\btests?\s+\d+\s+failed/.test(s) ||
    / fail\s+/.test(s) ||
    /❌\s*test/.test(s) ||
    /\bvitest\b.*\bfail/.test(s) ||
    /\bjest\b.*\bfail/.test(s) ||
    /test:integration\s+failed/.test(s) ||
    /test:unit\s+failed/.test(s) ||
    /test:e2e\s+failed/.test(s) ||
    /\bfailed:\s*test:/.test(s) ||
    /failing tests?:/.test(s)
  );
}
