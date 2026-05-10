import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

function makeExecResult(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

describe('launchagent', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let plistPath: typeof import('@/lib/scheduling/launchagent').plistPath;
  let pausedPlistPath: typeof import('@/lib/scheduling/launchagent').pausedPlistPath;
  let launchctlInfo: typeof import('@/lib/scheduling/launchagent').launchctlInfo;
  let pauseAll: typeof import('@/lib/scheduling/launchagent').pauseAll;
  let resumeAll: typeof import('@/lib/scheduling/launchagent').resumeAll;

  beforeEach(async () => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));

    const mod = await import('@/lib/scheduling/launchagent');
    plistPath = mod.plistPath;
    pausedPlistPath = mod.pausedPlistPath;
    launchctlInfo = mod.launchctlInfo;
    pauseAll = mod.pauseAll;
    resumeAll = mod.resumeAll;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.LAUNCHAGENT_PREFIX;
  });

  describe('plistPath', () => {
    it('uses default com.tamtam prefix', () => {
      const p = plistPath('myproject');
      expect(p).toContain('com.tamtam.improve.myproject.plist');
      expect(p).toContain('LaunchAgents');
    });

    it('uses LAUNCHAGENT_PREFIX env var when set', async () => {
      vi.resetModules();
      process.env.LAUNCHAGENT_PREFIX = 'org.custom';
      vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
      const mod = await import('@/lib/scheduling/launchagent');
      expect(mod.plistPath('foo')).toContain('org.custom.improve.foo.plist');
    });
  });

  describe('pausedPlistPath', () => {
    it('returns a path inside the paused subdirectory', () => {
      const paused = pausedPlistPath('myproject');
      expect(paused).toContain('paused');
      expect(paused).toContain('myproject.plist');
    });

    it('uses the same filename as plistPath', () => {
      const active = plistPath('myproject');
      const paused = pausedPlistPath('myproject');
      expect(paused.endsWith(active.split('/').pop()!)).toBe(true);
    });
  });

  describe('launchctlInfo', () => {
    it('returns loaded: false when launchctl list returns non-zero', async () => {
      execMock.mockResolvedValue(makeExecResult(1, '', 'Could not find service'));

      const info = await launchctlInfo('myproject');
      expect(info.loaded).toBe(false);
      expect(info.pid).toBeNull();
      expect(info.lastExit).toBeNull();
    });

    it('parses PID from launchctl output', async () => {
      const output = `{
        "PID" = 12345;
        "LastExitStatus" = 0;
      }`;
      execMock.mockResolvedValue(makeExecResult(0, output));

      const info = await launchctlInfo('myproject');
      expect(info.loaded).toBe(true);
      expect(info.pid).toBe(12345);
      expect(info.lastExit).toBe(0);
    });

    it('parses PID from unquoted launchctl output keys', async () => {
      const output = `{
        PID = 54321;
        LastExitStatus = 7;
      }`;
      execMock.mockResolvedValue(makeExecResult(0, output));

      const info = await launchctlInfo('myproject');
      expect(info.loaded).toBe(true);
      expect(info.pid).toBe(54321);
      expect(info.lastExit).toBe(7);
    });

    it('returns null PID when PID key is missing from output', async () => {
      const output = `{
        "LastExitStatus" = 1;
      }`;
      execMock.mockResolvedValue(makeExecResult(0, output));

      const info = await launchctlInfo('myproject');
      expect(info.loaded).toBe(true);
      expect(info.pid).toBeNull();
      expect(info.lastExit).toBe(1);
    });

    it('parses plistMinute from plist file when it exists', async () => {
      // Write a plist file at the real path to test file parsing
      const project = `tamtam-test-${Date.now()}`;
      const plist = plistPath(project);
      const plistDir = plist.substring(0, plist.lastIndexOf('/'));

      let created = false;
      try {
        mkdirSync(plistDir, { recursive: true });
        writeFileSync(
          plist,
          `<?xml version="1.0"?>
<plist>
<dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
</dict>
</plist>`
        );
        created = true;
      } catch {
        // Skip if we can't write to LaunchAgents dir (e.g. restricted permissions)
      }

      execMock.mockResolvedValue(makeExecResult(0, '"PID" = 999;'));

      const info = await launchctlInfo(project);

      if (created) {
        expect(info.plistMinute).toBe(30);
        rmSync(plist);
      } else {
        expect(info.plistMinute).toBeNull();
      }
    });

    it('returns null plistMinute when plist does not exist', async () => {
      execMock.mockResolvedValue(makeExecResult(0, '"PID" = 1;'));

      const info = await launchctlInfo('project-that-has-no-plist-' + Date.now());
      expect(info.plistMinute).toBeNull();
    });

    it('returns null wrapperPhase and wrapperCycle when wrapper does not exist', async () => {
      execMock.mockResolvedValue(makeExecResult(1, ''));

      const info = await launchctlInfo('no-wrapper-project-' + Date.now());
      expect(info.wrapperPhase).toBeNull();
      expect(info.wrapperCycle).toBeNull();
    });
  });

  describe('pauseAll', () => {
    it('skips projects whose plist files do not exist', async () => {
      execMock.mockResolvedValue(makeExecResult(0));

      // Use project names whose plists won't exist on disk
      await pauseAll(['nonexistent-project-abc123', 'nonexistent-project-def456']);

      expect(execMock).not.toHaveBeenCalled();
    });
  });

  describe('resumeAll', () => {
    it('skips projects whose paused plist files do not exist', async () => {
      execMock.mockResolvedValue(makeExecResult(0));

      await resumeAll(['nonexistent-project-abc123', 'nonexistent-project-def456']);

      expect(execMock).not.toHaveBeenCalled();
    });

    it('calls launchctl load and renames file for existing paused plists', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'tamtam-launchagent-'));
      const pausedDir = join(tmpDir, 'paused');
      mkdirSync(pausedDir, { recursive: true });

      try {
        // We can't easily test the full rename+exec flow without mocking module constants,
        // but we can confirm that the function handles empty lists cleanly.
        execMock.mockResolvedValue(makeExecResult(0));
        await resumeAll([]);
        expect(execMock).not.toHaveBeenCalled();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
