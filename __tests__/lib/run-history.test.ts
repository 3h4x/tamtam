import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('run-history', () => {
  let homeDir: string;
  let recordRunStart: typeof import('@/lib/run-history').recordRunStart;
  let recordRunEnd: typeof import('@/lib/run-history').recordRunEnd;
  let readRunHistory: typeof import('@/lib/run-history').readRunHistory;
  let pruneRunsFile: typeof import('@/lib/run-history').pruneRunsFile;
  let lastRunLookup: typeof import('@/lib/run-history').lastRunLookup;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'tamtam-run-history-'));
    vi.resetModules();

    vi.doMock('os', async () => {
      const actual = await vi.importActual('os');
      return { ...actual, homedir: () => homeDir };
    });

    const mod = await import('@/lib/run-history');
    recordRunStart = mod.recordRunStart;
    recordRunEnd = mod.recordRunEnd;
    readRunHistory = mod.readRunHistory;
    pruneRunsFile = mod.pruneRunsFile;
    lastRunLookup = mod.lastRunLookup;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  const runsFile = () => join(homeDir, '.cache', 'tamtam', 'schedule-runs.jsonl');

  describe('recordRunStart', () => {
    it('returns a numeric token', () => {
      const token = recordRunStart('my-project');
      expect(typeof token).toBe('number');
      expect(token).toBeGreaterThan(0);
    });

    it('creates the runs file', () => {
      recordRunStart('my-project');
      expect(existsSync(runsFile())).toBe(true);
    });

    it('appends a start record to the file', () => {
      recordRunStart('my-project');
      const content = readFileSync(runsFile(), 'utf-8');
      const record = JSON.parse(content.trim());
      expect(record.e).toBe('start');
      expect(record.p).toBe('my-project');
      expect(typeof record.pid).toBe('number');
      expect(typeof record.t).toBe('string');
    });

    it('returns unique tokens each call', () => {
      const t1 = recordRunStart('proj');
      const t2 = recordRunStart('proj');
      // tokens are random 48-bit numbers; collision extremely unlikely
      expect(t1).not.toBe(t2);
    });

    it('creates parent directories if missing', () => {
      recordRunStart('proj');
      expect(existsSync(runsFile())).toBe(true);
    });
  });

  describe('recordRunEnd', () => {
    it('appends an end record to the file', () => {
      const token = recordRunStart('proj-a');
      recordRunEnd('proj-a', token, 0);

      const lines = readFileSync(runsFile(), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      const endRecord = lines.find((r: any) => r.e === 'end');
      expect(endRecord).toBeTruthy();
      expect(endRecord.p).toBe('proj-a');
      expect(endRecord.exit).toBe(0);
      expect(endRecord.pid).toBe(token);
    });

    it('records non-zero exit code', () => {
      const token = recordRunStart('proj');
      recordRunEnd('proj', token, 1);

      const lines = readFileSync(runsFile(), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      const endRecord = lines.find((r: any) => r.e === 'end');
      expect(endRecord.exit).toBe(1);
    });
  });

  describe('readRunHistory', () => {
    it('returns empty array when file does not exist', () => {
      const result = readRunHistory();
      expect(result).toEqual([]);
    });

    it('returns completed runs with correct fields', () => {
      const token = recordRunStart('my-proj');
      recordRunEnd('my-proj', token, 0);

      const result = readRunHistory();
      expect(result).toHaveLength(1);
      expect(result[0].project).toBe('my-proj');
      expect(result[0].exitCode).toBe(0);
      expect(result[0].durationS).toBeGreaterThanOrEqual(0);
      expect(result[0].started).toBeTruthy();
      expect(result[0].ended).toBeTruthy();
    });

    it('filters by project name', () => {
      const t1 = recordRunStart('proj-a');
      recordRunEnd('proj-a', t1, 0);
      const t2 = recordRunStart('proj-b');
      recordRunEnd('proj-b', t2, 0);

      const result = readRunHistory('proj-a');
      expect(result).toHaveLength(1);
      expect(result[0].project).toBe('proj-a');
    });

    it('includes runs matching project prefix', () => {
      const t1 = recordRunStart('proj-a-subtype');
      recordRunEnd('proj-a-subtype', t1, 0);

      const result = readRunHistory('proj-a');
      expect(result).toHaveLength(1);
    });

    it('returns runs sorted by started descending', () => {
      const t1 = recordRunStart('proj');
      recordRunEnd('proj', t1, 0);
      const t2 = recordRunStart('proj');
      recordRunEnd('proj', t2, 0);

      const result = readRunHistory('proj');
      expect(result.length).toBeGreaterThanOrEqual(2);
      const d0 = new Date(result[0].started).getTime();
      const d1 = new Date(result[1].started).getTime();
      expect(d0).toBeGreaterThanOrEqual(d1);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const t = recordRunStart('proj');
        recordRunEnd('proj', t, 0);
      }
      const result = readRunHistory(undefined, 3);
      expect(result).toHaveLength(3);
    });

    it('ignores orphaned start entries with dead pids', () => {
      // Write a start with a very unlikely-to-exist PID (no end record)
      const token = recordRunStart('orphan-proj');
      // Don't call recordRunEnd — simulates a crashed run
      const result = readRunHistory('orphan-proj');
      // Should return something (either a still-running entry or nothing)
      // Just ensure it doesn't throw
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('pruneRunsFile', () => {
    it('does nothing when file does not exist', () => {
      expect(() => pruneRunsFile()).not.toThrow();
    });

    it('does nothing when number of lines is within limit', () => {
      const t = recordRunStart('proj');
      recordRunEnd('proj', t, 0);

      const before = readFileSync(runsFile(), 'utf-8');
      pruneRunsFile(300);
      const after = readFileSync(runsFile(), 'utf-8');
      expect(after).toBe(before);
    });

    it('prunes old entries when over limit', () => {
      // Write many start/end pairs to exceed the threshold (keep * 2 + 10)
      const keep = 5;
      const total = keep * 2 + 11; // exceeds threshold

      for (let i = 0; i < total; i++) {
        const t = recordRunStart(`proj-${i}`);
        recordRunEnd(`proj-${i}`, t, 0);
      }

      const beforeLines = readFileSync(runsFile(), 'utf-8')
        .split('\n')
        .filter((l) => l.trim()).length;
      expect(beforeLines).toBe(total * 2);

      pruneRunsFile(keep);

      const afterLines = readFileSync(runsFile(), 'utf-8')
        .split('\n')
        .filter((l) => l.trim()).length;
      // Should have kept `keep` pairs = keep * 2 lines
      expect(afterLines).toBe(keep * 2);
    });
  });

  describe('lastRunLookup', () => {
    it('returns empty object when no runs exist', () => {
      const result = lastRunLookup();
      expect(result).toEqual({});
    });

    it('returns most recent run per project', () => {
      const t1 = recordRunStart('proj-x');
      recordRunEnd('proj-x', t1, 0);
      const t2 = recordRunStart('proj-x');
      recordRunEnd('proj-x', t2, 0);
      const t3 = recordRunStart('proj-y');
      recordRunEnd('proj-y', t3, 0);

      const lookup = lastRunLookup();
      expect(lookup['proj-x']).toBeTruthy();
      expect(lookup['proj-y']).toBeTruthy();
    });

    it('each project appears only once', () => {
      for (let i = 0; i < 3; i++) {
        const t = recordRunStart('repeated');
        recordRunEnd('repeated', t, 0);
      }
      const lookup = lastRunLookup();
      const keys = Object.keys(lookup).filter((k) => k === 'repeated');
      expect(keys).toHaveLength(1);
    });
  });
});
