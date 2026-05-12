export function canonicalizeAgentName(name: string): string {
  return name.trim();
}

export function getAgentNameValidationError(name: string): string | null {
  const canonical = canonicalizeAgentName(name);
  if (!canonical) return 'name is required';
  for (const char of canonical) {
    const code = char.charCodeAt(0);
    if (char === '/' || char === '\\' || code < 32 || code === 127) {
      return 'name may not contain slashes or control characters';
    }
  }
  return null;
}

export function normalizeAgentNameInput(value: unknown): { name: string | null; error: string | null } {
  if (typeof value !== 'string') {
    return { name: null, error: 'name is required' };
  }
  const name = canonicalizeAgentName(value);
  return { name, error: getAgentNameValidationError(name) };
}

export function canonicalAgentNameKey(name: string): string {
  return canonicalizeAgentName(name).toLowerCase();
}
