const AGENT_SCHEDULE_RE = /^[1-9]\d*[mh]$/i;

const AGENT_SCHEDULE_EXAMPLE = 'use 15m, 1h, 4h, or 24h';

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
