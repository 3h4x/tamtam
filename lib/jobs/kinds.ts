export function getJobKind(kind: unknown): string {
  return typeof kind === 'string' ? kind : '';
}

export function isAgentJobKind(kind: unknown): boolean {
  return getJobKind(kind).startsWith('agent:');
}

export function isClaudeBackedJobKind(kind: unknown): boolean {
  const normalized = getJobKind(kind);
  return normalized === 'run'
    || normalized === 'review'
    || normalized === 'fix'
    || normalized === 'fix-ci'
    || isAgentJobKind(normalized);
}
