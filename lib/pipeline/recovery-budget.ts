import { getSettings, type ReviewDoNotShipAction } from '@/lib/shared/config';

// Single source of truth for the pipeline's step-iteration cap.
//
// ONE user-facing setting — `fix_max_iterations`, persisted in
// `app_settings` — governs every review-driven fix loop the release
// pipeline runs: review→fix→test→review, test→fix→test, commit→fix→commit,
// and the review-driven push→fix→push leg. Default `0` means "loop
// until success or the release wall-clock timeout."
//
// `getFixIterationCap()` is the only export for this knob: one function,
// one setting, one runtime value.
//
// Two failure-recovery caps stay deliberately separate and finite even
// when `fix_max_iterations = 0`, so a permanently broken environment
// cannot loop forever:
//   - `getPushFixAttemptCap()` (this file) — pre-push-hook rejection
//     retries cap at 2 attempts.
//   - `FIX_CI_MAX_RETRIES` (in `lib/jobs/lifecycle.ts`) — fix-CI
//     fast-crash recovery caps at 2 retries within a 120s window.
//
// `getStepWindowSeconds()` is a separate concept (time-based rolling
// window used by the legacy standalone hook, no releaseId) and stays
// env-driven (`TAMTAM_STEP_WINDOW_SECONDS`).

const DEFAULT_FIX_ITERATION_CAP = 3;
const DEFAULT_STEP_WINDOW_SECONDS = 30 * 60;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the configured per-release fix-loop iteration cap. Returns
 * `Number.POSITIVE_INFINITY` when the setting is 0 (operator-opted
 * "loop until success"). Returns the integer setting when > 0. Falls back
 * to `DEFAULT_FIX_ITERATION_CAP` when the settings store hasn't been
 * initialized yet (early boot, tests that don't seed settings).
 *
 * Reads live each call so an operator tuning the setting in the UI sees
 * the new value on the next release step without restarting the server.
 *
 * Applies uniformly to the review, test, commit, and review-driven push
 * verification loops. There is no separate per-step variant — the cap is
 * one number by design.
 */
export function getFixIterationCap(): number {
  try {
    const value = getSettings().fix_max_iterations;
    if (value === 0) return Number.POSITIVE_INFINITY;
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // settings not yet loaded — drop through to the safety default.
  }
  return DEFAULT_FIX_ITERATION_CAP;
}

/** Policy applied when review returns `DO NOT SHIP`. Default `pass` files a
 *  follow-up GitHub issue and continues with commit → push → mark-dod so the
 *  release still ships; `fix` routes back through the fix loop (subject to the
 *  iteration cap); `abort` keeps the legacy behavior of stopping the release
 *  immediately. */
export function getReviewDoNotShipAction(): ReviewDoNotShipAction {
  try {
    return getSettings().review_do_not_ship_action;
  } catch {
    return 'pass';
  }
}

/** Cap on automatic fix attempts triggered by repeated push pre-push-hook
 *  rejections. Kept separate from `fix_max_iterations` so hook failures stay
 *  finite even when the main fix-loop cap is unlimited. */
export function getPushFixAttemptCap(): number {
  return 2;
}

/** Time window the legacy completion hook uses to decide whether two
 *  back-to-back step runs belong to the same chain. Iteration-count caps
 *  are handled by `getFixIterationCap()`; this knob is a different
 *  concept (wall-clock window, not retry count) and remains env-driven. */
export function getStepWindowSeconds(): number {
  return parsePositiveInt(
    process.env.TAMTAM_STEP_WINDOW_SECONDS ?? process.env.TAMTAM_FIX_WINDOW_SECONDS,
    DEFAULT_STEP_WINDOW_SECONDS,
  );
}
