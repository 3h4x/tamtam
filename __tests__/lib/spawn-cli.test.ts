import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSubprocess } from '@/lib/jobs/spawn-cli';

describe('runSubprocess env cleansing', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  });

  it('strips sandbox env from inherited and caller-provided env while preserving normal overrides', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-spawn-cli-'));
    tempDirs.push(tempDir);
    const promptPath = join(tempDir, 'prompt.txt');
    const logPath = join(tempDir, 'run.log');
    writeFileSync(promptPath, 'prompt');

    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';

    const result = await runSubprocess({
      jobId: 'job-env-test',
      cmd: 'sh',
      cmdArgs: ['-c', [
        'echo "inherited=${CODEX_SANDBOX_NETWORK_DISABLED:-unset}"',
        'echo "override=${CODEX_SANDBOX_OVERRIDE:-unset}"',
        'echo "port=${PORT:-unset}"',
        'echo "keep=${TAMTAM_SPAWN_CLI_TEST:-unset}"',
      ].join('; ')],
      promptPath,
      logPath,
      env: {
        CODEX_SANDBOX_OVERRIDE: '1',
        PORT: '7777',
        TAMTAM_SPAWN_CLI_TEST: 'kept',
      },
    });

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('inherited=unset');
    expect(log).toContain('override=unset');
    expect(log).toContain('port=unset');
    expect(log).toContain('keep=kept');
  });
});
