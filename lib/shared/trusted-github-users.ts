function toEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return String(value).split(/[,\n]/);
}

export function parseTrustedGithubUsers(value: string): string[] {
  return canonicalizeTrustedGithubUsers(value);
}

export function serializeTrustedGithubUsers(users: string[]): string {
  return users.map((user) => user.trim()).filter(Boolean).join(', ');
}

export function canonicalizeTrustedGithubUsers(value: unknown): string[] {
  const seen = new Set<string>();
  const users: string[] = [];

  for (const entry of toEntries(value)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    users.push(trimmed);
  }

  return users;
}

export function validateTrustedGithubUsersEntries(users: string[]): string | null {
  const seen = new Set<string>();

  for (const user of users) {
    const trimmed = user.trim();
    if (!trimmed) return 'Trusted GitHub users cannot be empty.';

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) return `Duplicate GitHub login: ${trimmed}`;
    seen.add(normalized);
  }

  return null;
}

export function validateTrustedGithubUsersInput(value: unknown): string | null {
  const entries = toEntries(value);
  const hasMeaningfulEntry = entries.some((entry) => entry.trim().length > 0);
  if (!hasMeaningfulEntry) return null;

  return validateTrustedGithubUsersEntries(entries);
}
