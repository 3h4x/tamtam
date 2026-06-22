import { afterEach, describe, it, expect, vi } from 'vitest';

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock('@/lib/shared/shell', () => ({
  exec: mockExec,
}));

import {
  isMineableSourceFile,
  todoFindings,
  lintFindings,
  typeErrorFindings,
  depBumpFindings,
  trustedIssueFindings,
  apiRoutePathFromFile,
  isInternalApiPath,
  extractApiRefs,
  isPathCovered,
  orphanApiFindings,
  parseAddedRouteFiles,
  runProbes,
} from '@/lib/orchestrator/initiative-probes';

afterEach(() => {
  mockExec.mockReset();
  vi.unstubAllGlobals();
});

describe('isMineableSourceFile', () => {
  it('accepts first-party .ts/.tsx under lib/components/app', () => {
    expect(isMineableSourceFile('lib/foo.ts')).toBe(true);
    expect(isMineableSourceFile('components/Bar.tsx')).toBe(true);
    expect(isMineableSourceFile('app/api/x/route.ts')).toBe(true);
  });

  it('accepts first-party .ts/.tsx under the src/ convention (Vite / src-dir Next)', () => {
    expect(isMineableSourceFile('src/lib/foo.ts')).toBe(true);
    expect(isMineableSourceFile('src/components/Bar.tsx')).toBe(true);
    expect(isMineableSourceFile('src/app/security/page.tsx')).toBe(true);
    expect(isMineableSourceFile('src/hooks/useX.ts')).toBe(true);
    expect(isMineableSourceFile('src/services/y.ts')).toBe(true);
  });

  it('still excludes non-ts and build output under src/', () => {
    expect(isMineableSourceFile('src/foo.js')).toBe(false);
    expect(isMineableSourceFile('src/generated/types.ts')).toBe(false);
    expect(isMineableSourceFile('frontend/dist/assets/index-abc.js')).toBe(false);
  });

  it('rejects the engine\'s own probe/source files (no self-match)', () => {
    expect(isMineableSourceFile('lib/orchestrator/initiative-probes.ts')).toBe(false);
    expect(isMineableSourceFile('lib/orchestrator/initiative-miner.ts')).toBe(false);
  });

  it('rejects vendored / generated / dependency paths', () => {
    expect(isMineableSourceFile('node_modules/pkg/index.ts')).toBe(false);
    expect(isMineableSourceFile('lib/vendor/x.ts')).toBe(false);
    expect(isMineableSourceFile('app/__generated__/types.ts')).toBe(false);
    expect(isMineableSourceFile('dist/lib/x.ts')).toBe(false);
  });

  it('rejects non-ts files and files outside first-party roots', () => {
    expect(isMineableSourceFile('lib/foo.js')).toBe(false);
    expect(isMineableSourceFile('README.md')).toBe(false);
    expect(isMineableSourceFile('scripts/foo.ts')).toBe(false);
    expect(isMineableSourceFile('')).toBe(false);
  });
});

describe('todoFindings', () => {
  it('maps mineable files to todo findings with stable dedup keys', () => {
    const out = todoFindings(['lib/a.ts', 'app/b.tsx']);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'todo', dedupKey: 'todo:lib/a.ts' });
    expect(out[0].title).toContain('lib/a.ts');
  });

  it('filters out non-mineable files before mapping', () => {
    const out = todoFindings([
      'lib/orchestrator/initiative-probes.ts', // self
      'node_modules/x/y.ts',                   // vendored
      'lib/real.ts',                           // keep
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dedupKey).toBe('todo:lib/real.ts');
  });

  it('caps at 20 findings', () => {
    const files = Array.from({ length: 30 }, (_, i) => `lib/f${i}.ts`);
    expect(todoFindings(files)).toHaveLength(20);
  });
});

describe('lintFindings', () => {
  it('returns nothing on a clean lint run', () => {
    expect(lintFindings(0, '')).toEqual([]);
  });

  it('does NOT file lint debt for a deps/toolchain preflight failure (false positive)', () => {
    expect(lintFindings(1, 'Some dependencies are not up to date')).toEqual([]);
    expect(lintFindings(1, '    at runDepsStatusCheck (file://...)')).toEqual([]);
    expect(lintFindings(1, 'Error: Cannot find module \'eslint\'')).toEqual([]);
    expect(lintFindings(1, 'Missing script: "lint"')).toEqual([]);
  });

  it('does NOT file when there is no positive lint evidence', () => {
    expect(lintFindings(1, 'some unrelated gibberish')).toEqual([]);
  });

  it('files one severity-100 lint initiative on real lint errors', () => {
    const out = lintFindings(1, 'lib/x.ts\n  12:3  error  Unexpected console statement\n✖ 3 problems (3 errors, 0 warnings)');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'lint', dedupKey: 'lint:global' });
  });
});

describe('typeErrorFindings', () => {
  it('returns nothing on a clean type-check', () => {
    expect(typeErrorFindings(0, '')).toEqual([]);
  });

  it('does NOT file for a deps/toolchain/missing-script preflight failure', () => {
    expect(typeErrorFindings(1, 'Some dependencies are not up to date')).toEqual([]);
    expect(typeErrorFindings(1, 'Missing script: "type-check"')).toEqual([]);
    expect(typeErrorFindings(1, "Error: Cannot find module 'typescript'")).toEqual([]);
  });

  it('does NOT file when there is no positive tsc evidence', () => {
    expect(typeErrorFindings(1, 'some unrelated failure')).toEqual([]);
  });

  it('files one type-error initiative on real tsc errors', () => {
    const out = typeErrorFindings(1, "lib/x.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'type-error', dedupKey: 'type-error:global' });
  });
});

describe('depBumpFindings', () => {
  it('returns nothing when nothing is outdated (empty object / empty string / non-JSON)', () => {
    expect(depBumpFindings('{}')).toEqual([]);
    expect(depBumpFindings('')).toEqual([]);
    expect(depBumpFindings('not json')).toEqual([]);
    expect(depBumpFindings('[]')).toEqual([]);
  });

  it('files one aggregate dep-bump finding counting outdated packages', () => {
    const json = JSON.stringify({
      react: { current: '18.0.0', latest: '19.0.0' },
      vitest: { current: '3.0.0', latest: '4.0.0' },
    });
    const out = depBumpFindings(json);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'dep-bump', dedupKey: 'dep-bump:global' });
    expect(out[0].title).toContain('2');
  });
});

// trustedIssueFindings takes the slim, ALREADY-trust-filtered issues returned by
// GET /api/.../issues?trusted_only=1 — never raw `gh issue list` output. The
// server-side gate (filterTrustedIssues → isUserTrusted) is what makes this safe;
// this pure function only shapes + drops blocker-labeled issues + caps.
describe('trustedIssueFindings', () => {
  it('returns nothing for non-array / empty input', () => {
    expect(trustedIssueFindings(undefined)).toEqual([]);
    expect(trustedIssueFindings([])).toEqual([]);
    expect(trustedIssueFindings('nope' as unknown)).toEqual([]);
  });

  it('maps trusted slim issues (title only) to gh-issue findings keyed by number', () => {
    const out = trustedIssueFindings([
      { number: 42, title: 'Fix the thing', labels: ['bug'] },
      { number: 7, title: 'Add a widget', labels: [] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'gh-issue', dedupKey: 'gh-issue:42' });
    expect(out[0].title).toContain('42');
    // body/comments must never be embedded — only number + title
    expect(out[0].prompt).toContain('#42');
  });

  it('drops blocker-labeled issues (question/wontfix/blocked/…)', () => {
    const out = trustedIssueFindings([
      { number: 1, title: 'real', labels: ['bug'] },
      { number: 2, title: 'noise', labels: ['question'] },
      { number: 3, title: 'later', labels: ['blocked'] },
    ]);
    expect(out.map((f) => f.dedupKey)).toEqual(['gh-issue:1']);
  });

  it('skips malformed entries and caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: `t${i}`, labels: [] as string[] }));
    ;(many as unknown[]).push({ title: 'no number', labels: [] });
    const out = trustedIssueFindings(many);
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out.every((f) => f.dedupKey.startsWith('gh-issue:'))).toBe(true);
  });
});

describe('ui-coverage probe helpers', () => {
  it('apiRoutePathFromFile derives the route path, or null for non-routes', () => {
    expect(apiRoutePathFromFile('app/api/initiatives/route.ts')).toBe('/api/initiatives');
    expect(apiRoutePathFromFile('app/api/projects/by-project/[projectName]/route.ts'))
      .toBe('/api/projects/by-project/[projectName]');
    expect(apiRoutePathFromFile('app/page.tsx')).toBeNull();
    expect(apiRoutePathFromFile('lib/x.ts')).toBeNull();
  });

  it('isInternalApiPath flags internal route kinds only', () => {
    expect(isInternalApiPath('/api/cron/tick')).toBe(true);
    expect(isInternalApiPath('/api/webhook')).toBe(true);
    expect(isInternalApiPath('/api/streaming/abc')).toBe(true);
    expect(isInternalApiPath('/api/jobs/notifications')).toBe(true);
    expect(isInternalApiPath('/api/initiatives')).toBe(false);
  });

  it('extractApiRefs pulls unique /api paths from client text', () => {
    const refs = extractApiRefs("fetch('/api/foo'); fetch(`/api/bar/baz`); fetch('/api/foo/')");
    expect(refs.sort()).toEqual(['/api/bar/baz', '/api/foo']);
  });

  it('isPathCovered handles exact, base-prefix (JOBS_BASE concat) and deeper-ref cases', () => {
    // exact
    expect(isPathCovered('/api/stats/usage', ['/api/stats/usage'])).toBe(true);
    // base-prefix: client calls `${JOBS_BASE}/notifications`, only `/api/jobs` literal present
    expect(isPathCovered('/api/jobs/notifications', ['/api/jobs'])).toBe(true);
    // route is an ancestor of a referenced deeper path
    expect(isPathCovered('/api/x', ['/api/x/y'])).toBe(true);
    // genuinely uncovered (the /api/stats/orchestrator-without-UI case)
    expect(isPathCovered('/api/stats/orchestrator', ['/api/stats/usage', '/api/stats/bridge'])).toBe(false);
  });

  it('orphanApiFindings flags only uncovered, non-internal routes', () => {
    const routeFiles = [
      'app/api/orphan/route.ts',          // uncovered -> flag
      'app/api/cron/tick/route.ts',       // internal -> skip
      'app/api/used/route.ts',            // covered -> skip
      'app/api/jobs/notifications/route.ts', // internal -> skip
    ];
    const out = orphanApiFindings(routeFiles, ['/api/used']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'ui-coverage', dedupKey: 'ui-coverage:/api/orphan' });
    expect(out[0].title).toContain('/api/orphan');
  });

  it('caps ui-coverage findings at 5 (advisory drip, not a flood)', () => {
    const routeFiles = Array.from({ length: 12 }, (_, i) => `app/api/orphan${i}/route.ts`);
    expect(orphanApiFindings(routeFiles, [])).toHaveLength(5);
  });

  it('parseAddedRouteFiles extracts deduped api route files from git log output', () => {
    const stdout = [
      '', 'app/api/discord/link/route.ts', 'lib/x.ts', '',
      'app/api/foo/[id]/route.tsx', 'app/page.tsx', 'app/api/discord/link/route.ts',
    ].join('\n');
    expect(parseAddedRouteFiles(stdout).sort()).toEqual([
      'app/api/discord/link/route.ts',
      'app/api/foo/[id]/route.tsx',
    ]);
  });
});

describe('runProbes', () => {
  it('bounds the trusted-issue fetch and keeps other findings when it aborts', async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'pnpm' && args[0] === 'lint') {
        return {
          stdout: 'lib/x.ts\n  1:1  error  Unexpected any\n✖ 1 problem (1 error, 0 warnings)',
          stderr: '',
          exitCode: 1,
        };
      }
      if (cmd === 'pnpm' && args[0] === 'type-check') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd === 'pnpm' && args[0] === 'outdated') {
        return { stdout: '{}', stderr: '', exitCode: 0 };
      }
      if (cmd === 'git') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
    });

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('timed out', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await runProbes('alpha', '/repo/alpha');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:1337/api/projects/by-project/alpha/issues?trusted_only=1',
      { signal: expect.any(AbortSignal) },
    );
    expect(results.findings.map((f) => f.dedupKey)).toEqual(['lint:global']);
  });
});
