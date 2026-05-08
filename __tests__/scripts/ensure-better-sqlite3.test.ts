import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

describe('scripts/ensure-better-sqlite3.js', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-better-sqlite3-'));
    tempDirs.push(dir);
    return dir;
  }

  it('rebuilds and writes an ABI stamp when the current ABI has not been checked yet', async () => {
    const mod = await import('@/scripts/ensure-better-sqlite3');
    const cwd = makeTempDir();
    const spawn = vi.fn(() => ({ status: 0 }));

    const result = mod.ensureBetterSqlite3ForCurrentNode({ cwd, spawn });
    const state = mod.readState(cwd);

    expect(result).toEqual({ rebuilt: true, stampPath: state.stampPath });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ['rebuild', 'better-sqlite3'], expect.objectContaining({ cwd }));
    expect(existsSync(state.stampPath)).toBe(true);
  });

  it('skips the rebuild when the current ABI stamp already exists and probing succeeds', async () => {
    const mod = await import('@/scripts/ensure-better-sqlite3');
    const cwd = makeTempDir();
    const state = mod.readState(cwd);
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '' }));

    mod.writeStamp(state);
    const result = mod.ensureBetterSqlite3ForCurrentNode({ cwd, spawn });

    expect(result).toEqual({ rebuilt: false, stampPath: state.stampPath });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['-e', expect.stringContaining('require(\'better-sqlite3\')')],
      expect.objectContaining({ cwd, encoding: 'utf8' }),
    );
  });

  it('rebuilds again when probing fails, and prunes stale ABI stamps', async () => {
    const mod = await import('@/scripts/ensure-better-sqlite3');
    const cwd = makeTempDir();
    const state = mod.readState(cwd);
    const spawn = vi.fn(() => ({ status: 0 }));
    const probe = vi.fn()
      .mockReturnValueOnce(new Error('stale native binary'))
      .mockReturnValueOnce(null);

    mod.writeStamp(state);
    writeFileSync(join(state.stampDir, 'better-sqlite3-old-abi-999.stamp'), 'stale\n');

    const result = mod.ensureBetterSqlite3ForCurrentNode({ cwd, probe, spawn });

    expect(result).toEqual({ rebuilt: true, stampPath: state.stampPath });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(readdirSync(state.stampDir)).toEqual([basename(state.stampPath)]);
  });

  it('treats a probe subprocess crash as a rebuildable error instead of crashing the parent process', async () => {
    const mod = await import('@/scripts/ensure-better-sqlite3');
    const cwd = makeTempDir();
    const state = mod.readState(cwd);
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: null, signal: 'SIGSEGV', stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '', stderr: '' });

    mod.writeStamp(state);
    const result = mod.ensureBetterSqlite3ForCurrentNode({ cwd, spawn });

    expect(result).toEqual({ rebuilt: true, stampPath: state.stampPath });
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ['-e', expect.stringContaining('require(\'better-sqlite3\')')],
      expect.objectContaining({ cwd, encoding: 'utf8' }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['rebuild', 'better-sqlite3'],
      expect.objectContaining({ cwd }),
    );
  });
});
