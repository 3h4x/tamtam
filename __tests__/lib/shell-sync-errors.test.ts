import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('exec sync spawn failures', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns a structured failure when spawn throws in killProcessGroup mode', async () => {
    vi.doMock('child_process', () => ({
      spawn: vi.fn(() => {
        throw new Error('spawn EBADF');
      }),
      execFile: vi.fn(),
    }));

    const { exec } = await import('@/lib/shared/shell');
    const result = await exec('git', ['status'], { killProcessGroup: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn EBADF');
  });

  it('returns a structured failure when execFile throws in standard mode', async () => {
    vi.doMock('child_process', () => ({
      spawn: vi.fn(),
      execFile: vi.fn(() => {
        throw new Error('execFile EBADF');
      }),
    }));

    const { exec } = await import('@/lib/shared/shell');
    const result = await exec('git', ['status']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('execFile EBADF');
  });
});
