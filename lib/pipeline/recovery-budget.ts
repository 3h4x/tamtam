const DEFAULT_MAX_STEP_ITERATIONS = 3;
const DEFAULT_FIX_PUSH_ATTEMPTS = 2;
const DEFAULT_STEP_WINDOW_SECONDS = 30 * 60;

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

export function getFixPushAttemptCap(): number {
  return DEFAULT_FIX_PUSH_ATTEMPTS;
}

export function getStepWindowSeconds(): number {
  return parsePositiveInt(process.env.TAMTAM_FIX_WINDOW_SECONDS, DEFAULT_STEP_WINDOW_SECONDS);
}
