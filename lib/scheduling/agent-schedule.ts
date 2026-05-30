// Accept minutes (`Nm`), hours (`Nh`), and days (`Nd`). Day suffixes let the UI
// offer 3d / 7d / 30d intervals for low-frequency audit-style agents
// without forcing the operator to compute `72h`/`168h`/`720h` by hand.
const AGENT_SCHEDULE_RE = /^[1-9]\d*[mhd]$/i;

const AGENT_SCHEDULE_EXAMPLE = 'use 15m, 1h, 4h, 24h, or 7d';

export function parseOptionalAgentScheduleInput(
  input: unknown
): { schedule: string | null; error: string | null } {
  if (input == null || input === '') return { schedule: null, error: null };
  if (typeof input !== 'string') {
    return { schedule: null, error: `Invalid schedule: ${String(input)} (${AGENT_SCHEDULE_EXAMPLE})` };
  }

  const schedule = input.trim().toLowerCase();
  if (!schedule) return { schedule: null, error: null };
  if (!AGENT_SCHEDULE_RE.test(schedule)) {
    return { schedule: null, error: `Invalid schedule: ${input} (${AGENT_SCHEDULE_EXAMPLE})` };
  }
  return { schedule, error: null };
}

export function normalizeAgentScheduleOrThrow(schedule: string): string {
  const parsed = parseOptionalAgentScheduleInput(schedule);
  if (parsed.error || !parsed.schedule) {
    throw new Error(parsed.error ?? `Invalid schedule: ${schedule} (${AGENT_SCHEDULE_EXAMPLE})`);
  }
  return parsed.schedule;
}
