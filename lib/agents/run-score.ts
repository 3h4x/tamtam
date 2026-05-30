export interface RunScoreInput {
  exitCode: number | null;
  /** JSON string: Array<{path: string; status: string; confidence?: 'high' | 'low'}> */
  modifiedFiles: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  workSummary: string | null;
}

/** Compute a 0–100 quality score for a completed agent run from signals already
 *  on the job row at finalize time — no extra tokens.
 *
 *  Breakdown:
 *   - Exit code:      30 pts (30 if 0 and any work signal exists; 15 if non-zero but files changed; 0 otherwise)
 *   - Fruitfulness:   40 pts (40 if any high-confidence file changed; 0 otherwise)
 *   - LOC volume:     20 pts (log2-scaled, saturates at ~32 lines changed)
 *   - Work summary:   10 pts (10 if ≥50 chars; 5 if shorter but present; 0 if absent)
 */
export function computeRunScore(input: RunScoreInput): number {
  const linesChanged = (input.linesAdded ?? 0) + (input.linesRemoved ?? 0);

  let changedFiles = 0;
  let highConfidenceFiles = 0;
  if (input.modifiedFiles) {
    try {
      const files = JSON.parse(input.modifiedFiles) as Array<{ confidence?: string }>;
      if (Array.isArray(files)) {
        changedFiles = files.length;
        highConfidenceFiles = files.filter((f) => f?.confidence !== 'low').length;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  const summaryLen = input.workSummary?.length ?? 0;
  const hasFileChangeSignal = changedFiles > 0 || linesChanged > 0;
  const hasWorkSignal = hasFileChangeSignal || summaryLen > 0;
  const scoreExit = input.exitCode === 0 && hasWorkSignal
    ? 30
    : (input.exitCode !== null && input.exitCode !== 0 && hasFileChangeSignal ? 15 : 0);
  const scoreFruitfulness = highConfidenceFiles > 0 ? 40 : 0;
  const scoreVolume = Math.min(20, Math.floor(Math.log2(linesChanged + 1) * 4));
  const scoreSummary = summaryLen >= 50 ? 10 : (summaryLen > 0 ? 5 : 0);

  return scoreExit + scoreFruitfulness + scoreVolume + scoreSummary;
}
