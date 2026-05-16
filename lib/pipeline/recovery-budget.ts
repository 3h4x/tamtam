import { getSettings, type ReviewDoNotShipAction } from '@/lib/shared/config';

const DEFAULT_MAX_STEP_ITERATIONS = 3;
const DEFAULT_PUSH_FIX_ATTEMPTS = 2;
const DEFAULT_STEP_WINDOW_SECONDS = 30 * 60;
const DEFAULT_REVIEW_FIX_MAX_ITERATIONS = 3;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMaxStepIterations(): number {
  return parsePositiveInt(
    process.env.TAMTAM_MAX_STEP_ITERATIONS ?? process.env.TAMTAM_MAX_FIX_ITERATIONS,
    DEFAULT_MAX_STEP_ITERATIONS,
  );
}

export function getReviewFixMaxIterations(): number {
  const envValue = parsePositiveInt(
    process.env.TAMTAM_REVIEW_FIX_MAX_ITERATIONS,
    DEFAULT_REVIEW_FIX_MAX_ITERATIONS,
  );
  try {
    const value = getSettings().review_fix_max_iterations;
    // 0 means "no cap" — the review→fix loop runs until LGTM (or the
    // release wall-clock kills it). Useful when iterating against a
    // stubborn review that converges given enough passes.
    if (value === 0) return Number.POSITIVE_INFINITY;
    return Number.isFinite(value) && value > 0 ? value : envValue;
  } catch {
    return envValue;
  }
}

/** Policy applied when review returns `DO NOT SHIP`. Default `pass` files a
 *  follow-up GitHub issue and continues with commit → push → mark-dod so the
 *  release still ships; `fix` routes back through the fix loop (subject to the
 *  review-fix iteration cap); `abort` keeps the legacy behavior of stopping
 *  the release immediately. */
export function getReviewDoNotShipAction(): ReviewDoNotShipAction {
  try {
    return getSettings().review_do_not_ship_action;
  } catch {
    return 'pass';
  }
}

/** Cap on automatic fix attempts triggered by repeated push hook rejections.
 *  Counted per project per `getStepWindowSeconds` window. Higher than 0
 *  because a stubbornly-broken lint rule shouldn't stop the pipeline forever
 *  in a tight loop. */
export function getPushFixAttemptCap(): number {
  return DEFAULT_PUSH_FIX_ATTEMPTS;
}

export function getStepWindowSeconds(): number {
  return parsePositiveInt(
    process.env.TAMTAM_STEP_WINDOW_SECONDS ?? process.env.TAMTAM_FIX_WINDOW_SECONDS,
    DEFAULT_STEP_WINDOW_SECONDS,
  );
}
