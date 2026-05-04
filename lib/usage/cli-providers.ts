/**
 * Identifiers for the four CLI backends TamTam can route work through.
 * `claude` and `codex` have subscription-quota fetchers; `gemini` and
 * `lmstudio` do not (LM Studio is local/free; Gemini lacks an OAuth quota
 * endpoint at the moment).
 */
export const CLI_PROVIDERS = ['claude', 'codex', 'gemini', 'lmstudio'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

export const CLI_PROVIDERS_WITH_QUOTA: CliProvider[] = ['claude', 'codex'];

export function isCliProvider(value: unknown): value is CliProvider {
  return typeof value === 'string' && (CLI_PROVIDERS as readonly string[]).includes(value);
}

export function parseEnabledProviders(raw: string | undefined | null): CliProvider[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is CliProvider => isCliProvider(s));
}

export function encodeEnabledProviders(providers: CliProvider[]): string {
  // Dedupe but preserve order.
  const seen = new Set<CliProvider>();
  const out: CliProvider[] = [];
  for (const p of providers) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(',');
}
