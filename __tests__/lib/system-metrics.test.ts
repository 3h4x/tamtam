import { describe, it, expect, beforeEach, vi } from 'vitest';

// `sampleSystemMetrics` reads `node:os` (cpu/mem/load) and shells out for disk
// (best-effort). We mock both so the test is hermetic and deterministic.

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

function mockOs(cpus: { times: CpuTimes }[], load: [number, number, number], totalBytes: number, freeBytes: number) {
  const osLike = {
    cpus: () => cpus,
    loadavg: () => load,
    totalmem: () => totalBytes,
    freemem: () => freeBytes,
  };
  vi.doMock('node:os', () => ({ default: osLike, ...osLike }));
}

function mockShell(diskResult: { exitCode: number; stdout: string; stderr: string }) {
  vi.doMock('@/lib/shared/shell', () => ({ exec: vi.fn().mockResolvedValue(diskResult) }));
}

const GB = 1024 * 1024 * 1024;

describe('sampleSystemMetrics', () => {
  beforeEach(() => vi.resetModules());

  it('returns null cpuPct on the first sample, then computes it from the delta; mem + load are correct', async () => {
    // 2 cores; each: total = 100+0+50+850+0 = 1000, idle = 850
    let cpus = [
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ];
    mockOs(cpus, [2, 1.5, 1], 16 * GB, 8 * GB);
    mockShell({ exitCode: 1, stdout: '', stderr: '' }); // disk commands "fail" → null

    const mod = await import('@/lib/shared/system-metrics');

    const s1 = await mod.sampleSystemMetrics();
    expect(s1.cpuPct).toBeNull();        // no previous reading yet
    expect(s1.cpuCount).toBe(2);
    expect(s1.memTotalMb).toBe(16384);
    expect(s1.memUsedMb).toBe(8192);
    expect(s1.memPct).toBe(50);
    expect(s1.load1).toBe(2);
    expect(s1.loadPerCore).toBe(1);      // 2 / 2 cores → exactly saturated
    expect(s1.diskUsedPct).toBeNull();
    expect(s1.diskIoMbS).toBeNull();

    // Advance each core by +200 total, +100 idle → 50% busy over the interval.
    cpus.length = 0;
    cpus.push(
      { times: { user: 150, nice: 0, sys: 100, idle: 950, irq: 0 } },
      { times: { user: 150, nice: 0, sys: 100, idle: 950, irq: 0 } },
    );
    const s2 = await mod.sampleSystemMetrics();
    expect(s2.cpuPct).toBe(50);
  });

  it('parses disk usage % from df and IO MB/s from iostat when available', async () => {
    mockOs([{ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }], [0.5, 0.5, 0.5], 8 * GB, 4 * GB);
    // exec is called for both df and iostat; return a df-style then iostat-style
    // payload. Both readers grep generically, so one combined stub suffices per call.
    const calls: string[] = [];
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockImplementation(async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'df') {
          return { exitCode: 0, stdout: 'Filesystem 1K-blocks Used Avail Capacity\n/dev/disk1 100 73 27 73%\n', stderr: '' };
        }
        // iostat: last line has per-disk "KB/t tps MB/s" → 12.0 3 1.5 then 8.0 2 0.5
        return { exitCode: 0, stdout: '          disk0\n KB/t tps MB/s\n 12.00 3 1.50 8.00 2 0.50\n', stderr: '' };
      }),
    }));

    const mod = await import('@/lib/shared/system-metrics');
    const s = await mod.sampleSystemMetrics();
    expect(s.diskUsedPct).toBe(73);
    expect(s.diskIoMbS).toBe(2); // 1.5 + 0.5
    expect(calls).toContain('df');
    expect(calls).toContain('iostat');
  });
});
