function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return undefined;
  const causeCode = (cause as { code?: unknown }).code;
  return typeof causeCode === 'string' ? causeCode : undefined;
}

export function isUndefinedTableError(error: unknown): boolean {
  if (errorCode(error) === '42P01') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /relation "[^"]+" does not exist/.test(message);
}
