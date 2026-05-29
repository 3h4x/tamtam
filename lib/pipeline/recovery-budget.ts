import { getSettings, type ReviewDoNotShipAction } from '@/lib/shared/config';

// Single source of truth for the pipeline's step-iteration cap.
//
// ONE user-facing setting — `fix_max_iterations`, persisted in
// `app_settings` — governs every retry loop the release pipeline runs:
// review→fix→review, test→fix→test, commit→fix→commit, the review-driven
// push→fix→push leg, AND the pre-push-hook rejection retry. Previously
// each leg had its own knob (settings for review, env vars for the rest,
// a hardcoded 2 for push-hook retries) so an operator who set
// `fix_max_iterations = 0` to mean "loop until success" was surprised
// when the test loop aborted at 3/3 or the push-hook leg at 2/2. One
// setting now drives them all.
//
// Every consumer (`getReviewFixMaxIterations`, `getMaxStepIterations`,
// `getPushFixAttemptCap`) delegates to `readFixIterationCap()` so any
// future tweak — clamping, telemetry, per-project overrides — happens
// in one place.
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
 * Resolve the configured per-release iteration cap. Returns
 * `Number.POSITIVE_INFINITY` when the setting is 0 (operator-opted
 * "loop until success"). Returns the integer setting when > 0. Falls back
 * to `DEFAULT_FIX_ITERATION_CAP` when the settings store hasn't been
 * initialized yet (early boot, tests that don't seed settings).
 *
 * Reads live each call so an operator tuning the setting in the UI sees
 * the new value on the next release step without restarting the server.
 */
function readFixIterationCap(): number {
  try {
    const value = getSettings().fix_max_iterations;
    if (value === 0) return Number.POSITIVE_INFINITY;
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // settings not yet loaded — drop through to the safety default.
  }
  return DEFAULT_FIX_ITERATION_CAP;
}

/** Cap on `test`, `commit`, and push-recovery verification loops. */
export function getMaxStepIterations(): number {
  return readFixIterationCap();
}

/** Cap on the `review→fix→review` verification loop. */
export function getReviewFixMaxIterations(): number {
  return readFixIterationCap();
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
 *  rejections. Reads the same single global `fix_max_iterations` setting:
 *  there is intentionally no separate knob. When the operator sets
 *  `fix_max_iterations = 0`, this cap also becomes unlimited — the only
 *  outer bound is then the release wall-clock timeout. */
export function getPushFixAttemptCap(): number {
  return readFixIterationCap();
}

/** Time window the legacy completion hook uses to decide whether two
 *  back-to-back step runs belong to the same chain. Iteration-count caps
 *  are handled by `getMaxStepIterations()`; this knob is a different
 *  concept (wall-clock window, not retry count) and remains env-driven. */
export function getStepWindowSeconds(): number {
  return parsePositiveInt(
    process.env.TAMTAM_STEP_WINDOW_SECONDS ?? process.env.TAMTAM_FIX_WINDOW_SECONDS,
    DEFAULT_STEP_WINDOW_SECONDS,
  );
}
