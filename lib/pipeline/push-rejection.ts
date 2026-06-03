// Helpers for classifying push failures. The release pipeline uses these to
// decide whether to attempt an auto-fix (`isHookRejection`), give up and
// surface for human triage (`isTestFailureRejection`), or retry without an
// LLM fix because the failure is a transient remote race
// (`isRemoteRaceRejection`).
//
// These detectors live in their own module so the lifecycle hook can
// classify push failures without pulling in the fix phase's start-fix code.

/** Is this push failure a hook rejection (lint/typecheck nit) worth auto-fixing?
 *
 *  The signal we actually want is the pre-push hook's exit code. `git push`'s
 *  own exit code is non-zero on any failure (hook, remote rejection, network,
 *  auth), so we can't read it directly. Instead we rely on two
 *  exit-code-surrogate markers that the surrounding tooling only prints when
 *  the hook truly failed:
 *
 *    1. Husky's "script failed (code N)" line — printed iff the hook
 *       script returned non-zero. Substring matches on bare words like
 *       "eslint" / "husky" do not work because the *successful* hook
 *       echoes those command names into the log; "script failed" only
 *       appears on hook exit != 0.
 *    2. Absence of `remote:` lines — once the push reaches the server,
 *       git surfaces server output as `remote: …` and the failure is then
 *       a remote rejection, not a hook fail.
 *
 *  Both signals together give us "exit-code-equivalent" classification
 *  without needing a separate structured field on the job. */
export function isHookRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  // If the remote saw the push, the hook passed — any subsequent failure is
  // server-side, not the hook. Skip the auto-fix flow.
  if (/^\s*remote:\s/m.test(detail)) return false;
  // Husky's failure banner is printed iff the hook exited non-zero.
  if (/husky\s*-\s*\S+( hook)? script failed/i.test(detail)) return true;
  // lint-staged surfaces its own failure banner.
  if (/lint-staged\s+failed/i.test(detail)) return true;
  // pre-commit framework prints "hook id: …" followed by a Failed banner.
  if (/^\s*hook id:\s+\S+/m.test(detail) && /\bfailed\b/i.test(detail)) return true;
  return false;
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
    /test:(?:integration|unit|e2e)\s+failed/.test(s) ||
    /\bfailed:\s*test:/.test(s) ||
    /failing tests?:/.test(s)
  );
}

/** Did `git push` fail because the remote moved under us (non-fast-forward
 *  race, ref-lock race) or because branch protection requires a PR? These
 *  cases are not fixable by editing code — they need a rebase + retry, or
 *  a PR flow. The push step itself already auto-rebases on the common
 *  variants; this classifier exists so the lifecycle hook can recognize
 *  the residual case (e.g. rebase ineffective, branch protection blocks
 *  direct push) and stop the pipeline cleanly instead of spawning a
 *  doomed code-edit fix job. */
export function isRemoteRaceRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return (
    isRetryableRemoteRefRejection(detail) ||
    // GitHub branch-protection messages.
    /Changes must be made through a pull request/i.test(detail) ||
    /required status check/i.test(detail) ||
    /protected branch/i.test(detail)
  );
}

/** Did `git push` fail because the target ref moved and a fetch/rebase retry
 * can plausibly resolve it? This is narrower than `isRemoteRaceRejection`:
 * lifecycle callers also classify branch protection as non-code-fixable, but
 * push callers must not run a pointless rebase for protection-only denials. */
export function isRetryableRemoteRefRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return (
    /cannot lock ref/i.test(detail) ||
    /\bfetch first\b/i.test(detail) ||
    /Updates were rejected/i.test(detail) ||
    /\bnon-fast-forward\b/i.test(detail) ||
    /tip of your current branch is behind/i.test(detail)
  );
}
