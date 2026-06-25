import { describe, expect, it } from 'vitest';
import { allFailuresQuarantined, parseFailingTests, retryCommandForFailure } from '@/lib/pipeline/flaky-tests';

describe('flaky test helpers', () => {
  it('parses vitest failures', () => {
    expect(parseFailingTests(`
 FAIL  src/foo.test.ts > widget > renders
 FAIL  src/bar.spec.ts > saves state
`)).toEqual([
      { framework: 'vitest', testId: 'src/foo.test.ts > widget > renders' },
      { framework: 'vitest', testId: 'src/bar.spec.ts > saves state' },
    ]);
  });

  it('parses pytest failures from summary lines', () => {
    expect(parseFailingTests(`
FAILED tests/test_api.py::test_handles_retry - AssertionError
ERROR tests/test_worker.py::TestWorker::test_shutdown
`)).toEqual([
      { framework: 'pytest', testId: 'tests/test_api.py::test_handles_retry' },
      { framework: 'pytest', testId: 'tests/test_worker.py::TestWorker::test_shutdown' },
    ]);
  });

  it('builds framework-specific retry commands', () => {
    expect(retryCommandForFailure(
      { framework: 'vitest', testId: 'src/foo.test.ts > widget renders' },
      'pnpm test',
    )).toBe("pnpm test -- 'src/foo.test.ts' --testNamePattern 'widget renders'");
    expect(retryCommandForFailure(
      { framework: 'pytest', testId: 'tests/test_api.py::test_handles_retry' },
      'python3 -m pytest',
    )).toBe("python3 -m pytest 'tests/test_api.py::test_handles_retry'");
  });

  it('detects when all failures are quarantined', () => {
    expect(allFailuresQuarantined(
      [
        { framework: 'vitest', testId: 'src/foo.test.ts > a' },
        { framework: 'pytest', testId: 'tests/test_api.py::test_b' },
      ],
      ['src/foo.test.ts > a', 'tests/test_api.py::test_b'],
    )).toBe(true);
  });
});
