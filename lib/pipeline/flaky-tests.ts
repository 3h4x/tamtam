export type TestFramework = 'vitest' | 'pytest';

export type ParsedTestFailure = {
  framework: TestFramework;
  testId: string;
};

export type TestOutcome = 'pass' | 'flaky' | 'fail' | 'quarantined';

const VITEST_FAIL_RE = /^\s*(?:FAIL|×|✕)\s+(.+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s*>\s*(.+))?\s*$/gm;
const PYTEST_FAIL_RE = /^_{2,}\s+(.+?)\s+_{2,}$/gm;
const PYTEST_SUMMARY_RE = /^\s*(?:FAILED|ERROR)\s+([^\s]+(?:::[^\s]+)+)/gm;

export function parseFailingTests(output: string): ParsedTestFailure[] {
  const failures = new Map<string, ParsedTestFailure>();

  for (const match of output.matchAll(VITEST_FAIL_RE)) {
    const file = match[1]?.trim();
    if (!file) continue;
    const name = match[2]?.trim();
    const testId = name ? `${file} > ${name}` : file;
    failures.set(`vitest:${testId}`, { framework: 'vitest', testId });
  }

  for (const match of output.matchAll(PYTEST_SUMMARY_RE)) {
    const testId = match[1]?.trim();
    if (testId) failures.set(`pytest:${testId}`, { framework: 'pytest', testId });
  }

  for (const match of output.matchAll(PYTEST_FAIL_RE)) {
    const testId = match[1]?.trim();
    if (testId?.includes('::')) failures.set(`pytest:${testId}`, { framework: 'pytest', testId });
  }

  return [...failures.values()];
}

export function retryCommandForFailure(failure: ParsedTestFailure, baseCommand: string): string | null {
  if (failure.framework === 'pytest') {
    return `${baseCommand} ${shellQuote(failure.testId)}`;
  }

  const [file, name] = failure.testId.split(/\s+>\s+(.+)/, 2);
  if (!file) return null;
  const nameArg = name ? ` --testNamePattern ${shellQuote(name)}` : '';
  if (/\bvitest\b/.test(baseCommand)) return `${baseCommand} ${shellQuote(file)}${nameArg}`;
  if (/\bjest\b/.test(baseCommand)) return `${baseCommand} ${shellQuote(file)}${nameArg}`;
  if (/\bpnpm\s+test\b/.test(baseCommand)) return `${baseCommand} -- ${shellQuote(file)}${nameArg}`;
  if (/\bnpm\s+test\b/.test(baseCommand)) return `${baseCommand} -- ${shellQuote(file)}${nameArg}`;
  return null;
}

export function normalizeQuarantinedTests(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeQuarantinedTests(parsed);
  } catch {
    return raw.split('\n').map((line) => line.trim()).filter(Boolean);
  }
}

export function allFailuresQuarantined(failures: ParsedTestFailure[], quarantinedTests: string[]): boolean {
  if (!failures.length || !quarantinedTests.length) return false;
  const quarantined = new Set(quarantinedTests);
  return failures.every((failure) => quarantined.has(failure.testId));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
